/**
 * Content auditor — runs after publish, checking recently published Sanity
 * posts for known issues and fixing/flagging them:
 *
 *  1. Image relevance: re-runs the same Unsplash relevance check the
 *     publish pipeline used, and falls back to gpt-image-1 (same pattern
 *     as newsApiSync.ts's generateAndUploadHeroForGoogleNews) if the
 *     re-check still comes back irrelevant.
 *  2. Duplicates across a broader (DUPLICATE_LOOKBACK_DAYS) recent-history
 *     pool, wider than the image-freshness window above: dedupeFeature.ts's
 *     checkForDuplicates only compares a candidate against posts already in
 *     Sanity BEFORE the run started, so two posts published seconds apart
 *     in the same run — or an older sibling that was already past a prior
 *     audit run's narrow window by the time a duplicate showed up — are
 *     never cross-checked against each other. This fills that gap, after
 *     the fact. Keeps the earliest-published post in each duplicate group;
 *     unpublishes the rest (never deletes).
 *
 * Manual, one-shot script — not wired to cron. Set AUDIT_DRY_RUN=true to
 * preview what it WOULD do (no writes: no Sanity patches, no image
 * generation/upload, no syncRun record).
 *
 * Never deletes anything — duplicates are unpublished (isActive: false,
 * status: 'draft'), same convention as eventCleanup.ts's deactivatePastEvents.
 */
import axios from 'axios';
import { config, validateConfig } from '../config';
import { getSanityClient, uploadImageBufferToSanity } from '../agents/sanityPublisher';
import { fetchUnsplashHeroImageResult } from '../agents/unsplashHero';
import { generateImage, generateImagePrompt } from '../agents/imageAgent';
import { deriveDedupeKeyFromExistingPost, normalizeSourceUrl } from '../src/agents/dedupeFeature';
import { recordSyncRun } from '../syncRunLogger';
import { VisualStyleSchema } from '../utils/validator';

const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Backoff schedule for OpenAI 429s hit while generating a fallback hero
 * (gpt-5.4-mini prompt enhancement and/or gpt-image-1 itself). A run that
 * needs several fallbacks fires these calls back-to-back with no natural
 * spacing, which is what tipped a 6-post run into a 100% 429 rate on
 * 2026-08-25 (syncRun sESRA9nn5E6yWErUIplHQK).
 */
export const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/** Be polite between one post's fallback attempt and the next — same spirit as backfillHeroImages.ts's 1.5s Unsplash pacing. */
const FALLBACK_PACING_MS = 1_500;

export function isRateLimitError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

/** Retries `fn` on a 429 with exponential backoff; any other error (or a 429 past the last attempt) rethrows immediately. */
export async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRateLimitError(err) || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw err;
      const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt]!;
      console.warn(`[audit] ${label} hit a 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Duplicate detection needs a wider net than the image-freshness audit
 * window: a post can go multiple audit runs without ever being checked
 * against an OLDER duplicate that was itself already processed by a prior
 * run (and therefore isn't "new" in the current narrow window either). 30
 * days rather than dedupeFeature.ts's RECENT_WINDOW_DAYS=7 — that value
 * was tuned for pre-publish dedupe recall, not for catching drift after
 * the fact, and this check is cheap (just Sanity reads + key comparisons,
 * no image generation), so a wider net costs little.
 */
const DUPLICATE_LOOKBACK_DAYS = 30;
const DRY_RUN = process.env.AUDIT_DRY_RUN === 'true';

type AuditPost = {
  _id: string;
  title: string;
  section?: string;
  categories?: string[];
  tags?: string[];
  publishedAt: string;
  disclaimer?: string;
  visualStyle?: string;
  originalSourceUrl?: string;
};

/**
 * Most recent syncType: 'auditor' run's finishedAt, or a DEFAULT_LOOKBACK_HOURS
 * fallback if the auditor has never run before.
 */
async function getAuditWindowStart(): Promise<string> {
  const client = getSanityClient();
  const lastRun = await client.fetch<{ finishedAt?: string } | null>(
    `*[_type == "syncRun" && syncType == "auditor" && defined(finishedAt)] | order(finishedAt desc)[0]{ finishedAt }`
  );
  if (lastRun?.finishedAt) return lastRun.finishedAt;
  return new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
}

async function fetchPostsInWindow(since: string): Promise<AuditPost[]> {
  const client = getSanityClient();
  const query = `*[_type == "post" && defined(publishedAt) && publishedAt >= $since]{
    _id, title, section, categories, tags, publishedAt, disclaimer, visualStyle, originalSourceUrl
  } | order(publishedAt asc)`;
  const rows = await client.fetch<AuditPost[]>(query, { since });
  return rows || [];
}

/** Broader pool for duplicate detection only — see DUPLICATE_LOOKBACK_DAYS. Only isActive posts: an already-unpublished post shouldn't be re-flagged or count as the "keep". */
async function fetchDuplicateCheckPool(): Promise<AuditPost[]> {
  const client = getSanityClient();
  const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const query = `*[_type == "post" && defined(publishedAt) && publishedAt >= $since && isActive == true]{
    _id, title, section, categories, tags, publishedAt, disclaimer, visualStyle, originalSourceUrl
  } | order(publishedAt asc)`;
  const rows = await client.fetch<AuditPost[]>(query, { since });
  return rows || [];
}

// ---------------------------------------------------------------------------
// Check 1 — image relevance
// ---------------------------------------------------------------------------

/**
 * Re-runs the Unsplash relevance check fresh (doesn't trust that whatever
 * shipped is still the right call). Only intervenes when the FRESH check
 * still comes back irrelevant/empty — if a relevant Unsplash match exists
 * now, the existing heroImage is left alone rather than swapped for a new
 * pick just because a re-search happened to return something.
 *
 * Returns true if the post's heroImage was patched.
 */
async function auditImageRelevance(
  post: AuditPost,
  actions: string[],
  errorSample: string[]
): Promise<boolean> {
  const label = `[${post._id}] "${post.title.slice(0, 60)}"`;

  // Already using the gpt-image-1 fallback (set by this same fallback path,
  // either at publish time or a prior audit run) — the Unsplash re-check
  // below will fail again for the exact same reason it failed before
  // (Unsplash usually has no stock photo of a specific named local
  // restaurant/athlete/venue), so re-running it would just burn an OpenAI
  // image generation on every single audit run forever. Nothing to fix.
  if (post.disclaimer && post.disclaimer.includes('Hero image is AI-generated (gpt-image-1)')) {
    console.log(`[audit] ${label} already has a gpt-image-1 hero — skipping re-check.`);
    return false;
  }

  // Section carries disambiguation signal (see unsplashHero.ts's
  // AMBIGUOUS_TERM_RULES, matched against `notes`); tags add extra keywords.
  const notes = [post.section, ...(post.tags || [])].filter(Boolean).join(' ');

  let unsplashResult;
  try {
    unsplashResult = await fetchUnsplashHeroImageResult(post.title, notes);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit] ${label} Unsplash re-check threw — skipping image check: ${msg}`);
    errorSample.push(`${post._id}: Unsplash re-check threw — ${msg}`);
    return false;
  }

  if (unsplashResult && unsplashResult.matchedRelevanceFilter) {
    console.log(`[audit] ${label} image re-check OK — relevant Unsplash match still exists, leaving heroImage untouched.`);
    return false;
  }

  const fallbackReason = !unsplashResult
    ? 'Unsplash returned nothing on re-check'
    : 'Unsplash re-check result never matched the relevance filter (resolution-only pick)';
  console.log(`[audit] ${label} ${fallbackReason} — trying gpt-image-1 fallback (same pattern as generateAndUploadHeroForGoogleNews).`);

  if (DRY_RUN) {
    console.log(`[audit] ${label} [DRY RUN] would generate a gpt-image-1 fallback hero and patch heroImage + disclaimer.`);
    actions.push(`${post._id}: [DRY RUN] would replace irrelevant/missing heroImage with gpt-image-1 fallback`);
    return false;
  }

  try {
    const basePrompt = `HappyTimesAZ ${post.section || 'news'} (greater Phoenix, Arizona metro): "${post.title}".\n\nHero scene direction: Photorealistic editorial photograph suited to the headline; Arizona / greater Phoenix context where appropriate.\n\nNo overlaid text, watermarks, third-party logos, or identifiable news outlet branding in the image.`;

    const visualStyleCheck = VisualStyleSchema.safeParse(post.visualStyle);
    const visualStyle = visualStyleCheck.success ? visualStyleCheck.data : 'editorial_realistic';

    let imageBuf: Buffer | null;
    try {
      const enhanced = await withRateLimitRetry(`${label} generateImagePrompt`, () =>
        generateImagePrompt(basePrompt, visualStyle)
      );
      imageBuf = await withRateLimitRetry(`${label} generateImage`, () => generateImage(enhanced));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] ${label} gpt-image-1 fallback threw: ${msg}`);
      errorSample.push(`${post._id}: gpt-image-1 fallback threw — ${msg}`);
      return false;
    }

    if (!imageBuf) {
      console.warn(`[audit] ${label} gpt-image-1 fallback returned nothing — flagging, heroImage left untouched.`);
      actions.push(`${post._id}: flagged irrelevant/missing hero image, no better replacement found`);
      return false;
    }

    let assetId: string;
    try {
      const filename = `${post._id.replace(/[^a-z0-9-]/gi, '-')}-audit-hero.jpg`;
      assetId = await uploadImageBufferToSanity(imageBuf, filename);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] ${label} Sanity image upload threw: ${msg}`);
      errorSample.push(`${post._id}: hero re-upload threw — ${msg}`);
      return false;
    }

    // The image being replaced is no longer credited to whoever shot the old
    // Unsplash photo — strip any "Hero photo by X on Unsplash (url)" segment
    // entirely (same shape written by both publishAssembly.ts's buildDisclaimer
    // and attachHeroImageDraftMushrooms.ts, with or without a trailing period)
    // before appending the AI-generated line, so the two don't end up stacked.
    const UNSPLASH_CREDIT_RE = /\s*Hero photo by [^()]*\([^)]*\)\.?/gi;
    const aiLine = 'Hero image is AI-generated (gpt-image-1).';
    const baseDisclaimer = (post.disclaimer || '').replace(UNSPLASH_CREDIT_RE, '').trim();
    const updatedDisclaimer = baseDisclaimer.includes(aiLine)
      ? baseDisclaimer
      : baseDisclaimer
        ? `${baseDisclaimer} ${aiLine}`
        : aiLine;

    // AI-generated images have no photographer to credit, so no real alt
    // text ships with them the way an Unsplash pick's alt_description does
    // — build one the same way imageSourcing.ts's gpt-image-1 fallback does
    // (buildAiAltText), ported here rather than imported per this script's
    // standalone convention.
    const altSubject = (post.tags && post.tags[0]) || post.section || post.title;
    const heroAlt = `AI-generated editorial image related to ${altSubject}`;

    try {
      const client = getSanityClient();
      await client
        .patch(post._id)
        .set({
          heroImage: {
            _type: 'image',
            asset: { _type: 'reference', _ref: assetId },
            alt: heroAlt,
          },
          disclaimer: updatedDisclaimer,
        })
        .commit();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] ${label} Sanity patch threw: ${msg}`);
      errorSample.push(`${post._id}: hero patch threw — ${msg}`);
      return false;
    }

    console.log(`[audit] ${label} heroImage fixed — assetId=${assetId}`);
    actions.push(`${post._id}: heroImage replaced with gpt-image-1 fallback (was irrelevant/missing)`);
    return true;
  } finally {
    // Pace fallback attempts so a run needing several of them doesn't fire
    // OpenAI calls in a tight burst — same spirit as backfillHeroImages.ts.
    await new Promise((r) => setTimeout(r, FALLBACK_PACING_MS));
  }
}

// ---------------------------------------------------------------------------
// Check 2 — duplicates across the broader lookback pool
// ---------------------------------------------------------------------------

type DedupeGroup = { key: string; posts: AuditPost[] };

/**
 * Recovers a source URL for a post published before originalSourceUrl was
 * populated by the pipeline_v2 path (see publishAssembly.ts) — those older
 * posts only ever had the URL embedded in the disclaimer's free text via
 * buildDisclaimer's "Sourced from: Outlet (https://...)." pattern. Belt-
 * and-suspenders only: going forward, originalSourceUrl is the real field
 * and this fallback is never needed for new posts.
 */
const DISCLAIMER_SOURCE_URL_RE = /Sourced from:.*?\((https?:\/\/[^)]+)\)/;

function extractSourceUrlFromDisclaimer(disclaimer: string | undefined): string | undefined {
  if (!disclaimer) return undefined;
  const m = disclaimer.match(DISCLAIMER_SOURCE_URL_RE);
  return m?.[1];
}

function resolvePostSourceUrl(post: AuditPost): string | undefined {
  return post.originalSourceUrl || extractSourceUrlFromDisclaimer(post.disclaimer);
}

/**
 * Groups posts by (1) normalized source URL, when resolvable — very high
 * confidence, catches the confirmed gap where entity-key matching missed a
 * feature/listicle article rediscovered under a fresh (LLM-regenerated)
 * specificSubject on each run — and (2) deriveDedupeKeyFromExistingPost's
 * entity+city key, the pre-existing behavior, unchanged. A post that lands
 * in a URL group is excluded from also being entity-grouped, so it isn't
 * double-processed by auditDuplicates.
 *
 * Runs over fetchDuplicateCheckPool()'s DUPLICATE_LOOKBACK_DAYS pool, NOT
 * the narrow image-freshness audit window — a post already processed by a
 * prior audit run is no longer "in window" for image checks, but a
 * duplicate published against it days later still needs to be caught, and
 * the reverse (an old duplicate surfacing only once a newer sibling
 * appears) needs the same wide net. A single group-by over the full pool
 * naturally covers same-window siblings too, since window posts are a
 * strict subset of the pool — no need for a second, separate
 * same-window-only pass.
 *
 * Still only compares within the lookback pool, not the pipeline's full
 * history — a post's dedupe check against anything older than the pool
 * already happened at publish time (dedupeFeature.ts's checkForDuplicates).
 */
function findDuplicateGroups(posts: AuditPost[]): DedupeGroup[] {
  const byUrl = new Map<string, AuditPost[]>();
  const urlGrouped = new Set<AuditPost>();
  for (const post of posts) {
    const rawUrl = resolvePostSourceUrl(post);
    const url = rawUrl ? normalizeSourceUrl(rawUrl) : undefined;
    if (!url) continue;
    const list = byUrl.get(url) || [];
    list.push(post);
    byUrl.set(url, list);
  }

  const groups: DedupeGroup[] = [];
  for (const [url, group] of byUrl.entries()) {
    if (group.length <= 1) continue;
    groups.push({ key: `url:${url}`, posts: group });
    for (const p of group) urlGrouped.add(p);
  }

  const byKey = new Map<string, AuditPost[]>();
  for (const post of posts) {
    if (urlGrouped.has(post)) continue;
    const key = deriveDedupeKeyFromExistingPost(post.title, post.tags || []);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(post);
    byKey.set(key, list);
  }
  for (const [key, group] of byKey.entries()) {
    if (group.length > 1) groups.push({ key, posts: group });
  }

  return groups;
}

/** Keeps the earliest publishedAt in each duplicate group; unpublishes the rest. Returns count unpublished. */
async function auditDuplicates(
  posts: AuditPost[],
  actions: string[],
  errorSample: string[]
): Promise<number> {
  const groups = findDuplicateGroups(posts);
  let unpublishedCount = 0;
  const client = getSanityClient();

  for (const group of groups) {
    const sorted = [...group.posts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    const keep = sorted[0]!;
    const duplicates = sorted.slice(1);

    for (const dup of duplicates) {
      console.log(
        `[audit] duplicate — key="${group.key}" keeping [${keep._id}] (${keep.publishedAt}), unpublishing [${dup._id}] (${dup.publishedAt})`
      );

      if (DRY_RUN) {
        console.log(`[audit] [${dup._id}] [DRY RUN] would set isActive=false, status='draft'.`);
        actions.push(`${dup._id}: [DRY RUN] would unpublish as duplicate of ${keep._id} (key="${group.key}")`);
        continue;
      }

      try {
        await client.patch(dup._id).set({ isActive: false, status: 'draft' }).commit();
        unpublishedCount++;
        actions.push(`${dup._id}: unpublished as duplicate of ${keep._id} (key="${group.key}")`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[audit] [${dup._id}] unpublish patch threw: ${msg}`);
        errorSample.push(`${dup._id}: unpublish threw — ${msg}`);
      }
    }
  }
  return unpublishedCount;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  validateConfig();

  if (!config.unsplash.accessKey) {
    console.warn('[audit] UNSPLASH_ACCESS_KEY is not set — every image re-check will fall straight through to the gpt-image-1 fallback branch.');
  }
  if (DRY_RUN) {
    console.log('[audit] AUDIT_DRY_RUN=true — no Sanity writes, no image generation/upload, no syncRun record will be made.\n');
  }

  const runStartedAt = new Date().toISOString();
  const since = await getAuditWindowStart();
  console.log(`[audit] Audit window: publishedAt >= ${since}`);

  const posts = await fetchPostsInWindow(since);
  console.log(`[audit] Found ${posts.length} post(s) in window.\n`);

  const actions: string[] = [];
  const errorSample: string[] = [];
  let imagesFixed = 0;
  let duplicatesUnpublished = 0;

  for (const post of posts) {
    console.log(`\n[audit] Checking [${post._id}] "${post.title}" (publishedAt=${post.publishedAt})`);
    try {
      const fixed = await auditImageRelevance(post, actions, errorSample);
      if (fixed) imagesFixed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] [${post._id}] image check threw unexpectedly: ${msg}`);
      errorSample.push(`${post._id}: image check threw — ${msg}`);
    }
  }

  {
    console.log(`\n[audit] Checking for duplicates across the last ${DUPLICATE_LOOKBACK_DAYS} days (broader than the image-freshness window above)…`);
    try {
      const duplicateCheckPool = await fetchDuplicateCheckPool();
      console.log(`[audit] Duplicate-check pool: ${duplicateCheckPool.length} active post(s) in the last ${DUPLICATE_LOOKBACK_DAYS} days.`);
      duplicatesUnpublished = await auditDuplicates(duplicateCheckPool, actions, errorSample);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[audit] duplicate check threw unexpectedly: ${msg}`);
      errorSample.push(`duplicate check threw — ${msg}`);
    }
  }

  const totalErrors = errorSample.length;

  console.log('\n--- Audit complete ---');
  console.log(`  Posts audited:           ${posts.length}`);
  console.log(`  Hero images fixed:       ${imagesFixed}`);
  console.log(`  Duplicates unpublished:  ${duplicatesUnpublished}`);
  console.log(`  Errors:                  ${totalErrors}`);
  if (actions.length > 0) {
    console.log(`  Actions:`);
    for (const a of actions) console.log(`    - ${a}`);
  }

  if (DRY_RUN) {
    console.log('\n[audit] [DRY RUN] Skipping syncRun record. Would have recorded:');
    console.log(
      JSON.stringify(
        {
          syncType: 'auditor',
          startedAt: runStartedAt,
          finishedAt: new Date().toISOString(),
          itemsSynced: posts.length,
          errors: totalErrors,
          errorSample: errorSample.slice(0, 5),
          actionsSample: actions.slice(0, 5),
          triggeredBy: 'manual',
        },
        null,
        2
      )
    );
    return;
  }

  await recordSyncRun({
    syncType: 'auditor',
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    itemsSynced: posts.length,
    errors: totalErrors,
    errorSample,
    actionsSample: actions,
    triggeredBy: 'manual',
  });
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

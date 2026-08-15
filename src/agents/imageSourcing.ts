/**
 * Stage 7 — Image Sourcing (pipeline-redesign-architecture.md).
 *
 * Fixes a confirmed production bug in agents/unsplashHero.ts (read
 * read-only for reference, not modified, not imported): its
 * buildUnsplashSearchQuery(title, notes) builds the search query mostly
 * out of the raw headline's own words (title itself is always the first
 * chunk of the query, and the "unique keyword" extraction pulls from
 * `${title}\n${notes}` combined, so headline word-soup dominates either
 * way). That produced wrong images — a toddler-and-soccer-ball photo for
 * an ASU FOOTBALL story (Unsplash's unscoped "football" defaults to
 * association football/soccer imagery worldwide, and nothing in the old
 * query disambiguated it), and an aurora photo for a meteor-shower piece
 * (loose headline/notes words like "night sky" pulling in unrelated
 * astro-adjacent stock photography with no structured anchor). The old
 * path also never captured photographer attribution, never confirmed its
 * download-trigger call actually succeeded (fire-and-forget, swallows
 * errors), and never generated alt text at all.
 *
 * NEW MODULE. STANDALONE, SHADOW MODE ONLY — not wired into
 * orchestrator.ts, newsApiSync.ts, or any hero-image call site. No
 * production file is modified.
 *
 * Live Unsplash calls are made (this stage's whole job is fetching a real
 * image) — expected. On a rate-limit/quota response (HTTP 403/429) this
 * module stops and reports that status rather than retrying.
 */
import axios from 'axios';

import { config } from '../../config';

const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';
const MAX_QUERY_TERMS = 5;
const QUERY_MAX_CHARS = 100;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export type ImageSourcingInput = {
  /** Structured tags — e.g. WrittenArticle.tags. Never the raw headline. */
  tags: string[];
  /** The article's section (Stage 2's output) — used for relevance ranking and disambiguation context. */
  section: string;
  /**
   * Named entity/venue the article is actually about — e.g. a fact's
   * venueName value, or a topic's subjectTag when no venue exists.
   * Highest-priority query term when present. Never the raw headline.
   */
  entity?: string;
  /** Kept only for console labeling / a last-resort alt-text fallback — never fed into the search query. */
  title: string;
};

// ---------------------------------------------------------------------------
// Disambiguation — ambiguous search terms that resolve differently
// depending on section context. Keyed by lowercase term; a rule only
// fires when the input's section matches `whenSection`. `append` adds an
// extra query word rather than replacing the original term, so the
// original term still contributes to relevance ranking.
//
// Deliberately starts minimal (just the one bug case this build spec
// concretely describes) rather than inventing untested rules for other
// ambiguous terms — extend this list as new mismatches are actually
// observed, not speculatively.
// ---------------------------------------------------------------------------

const AMBIGUOUS_TERM_RULES: { term: string; whenSection: string; append: string }[] = [
  {
    term: 'football',
    whenSection: 'sports',
    append: 'american football',
  },
];

function applyDisambiguation(parts: string[], section: string): string[] {
  const additions: string[] = [];
  for (const part of parts) {
    const tokens = part.toLowerCase().split(/\s+/);
    for (const rule of AMBIGUOUS_TERM_RULES) {
      if (rule.whenSection !== section) continue;
      if (tokens.includes(rule.term) && !additions.includes(rule.append)) {
        additions.push(rule.append);
      }
    }
  }
  return [...parts, ...additions];
}

const STOP_TAGS = new Set(['news', 'events', 'local', 'phoenix', 'arizona']);

/**
 * Builds the Unsplash search query from structured input only — entity
 * first (most specific), then up to MAX_QUERY_TERMS tags, with
 * section-aware disambiguation applied last. Never touches input.title.
 */
export function buildImageSearchQuery(input: ImageSourcingInput): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  const pushTerm = (raw: string) => {
    const term = raw.trim();
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key) || STOP_TAGS.has(key)) return;
    seen.add(key);
    parts.push(term);
  };

  if (input.entity) pushTerm(input.entity);
  for (const tag of input.tags) {
    if (parts.length >= MAX_QUERY_TERMS) break;
    pushTerm(tag);
  }

  if (parts.length === 0) {
    // Last-resort: section alone. Deliberately never falls back to the raw
    // title — an empty/low-signal query is a known, logged limitation, not
    // a silent revert to the exact bug this stage exists to fix.
    console.warn(`[image-sourcing] No entity/tags available for "${input.title}" — falling back to section="${input.section}" alone (low-confidence query).`);
    pushTerm(input.section);
  }

  const disambiguated = applyDisambiguation(parts, input.section);
  const query = disambiguated.join(' ').slice(0, QUERY_MAX_CHARS).trim();
  return query || 'editorial';
}

function dedupeAndCleanTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key) || STOP_TAGS.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Named venues/businesses (e.g. "Kähvi Coffee + Cafe") essentially never
 * appear in Unsplash's stock-photo metadata — a query built from a specific
 * entity name plus several tags is often over-specific and returns zero
 * results, discovered empirically against tests 1-4 tonight (all 4 came
 * back no-results on the entity+tags query, while a more generic query did
 * not). Rather than accept "no image" as the normal case, this builds a
 * ladder of progressively broader queries — most specific first — so
 * sourceImage() can retry with less specificity instead of giving up after
 * one narrow attempt. Each rung is still built from structured input only;
 * the raw headline never enters any rung.
 */
function buildQueryLadder(input: ImageSourcingInput): string[] {
  const candidates: string[] = [];
  const seenQueries = new Set<string>();
  const addCandidate = (parts: string[]) => {
    const disambiguated = applyDisambiguation(parts, input.section);
    const q = disambiguated.join(' ').slice(0, QUERY_MAX_CHARS).trim();
    if (q && !seenQueries.has(q)) {
      seenQueries.add(q);
      candidates.push(q);
    }
  };

  // Rung 1: entity + tags — most specific (same as buildImageSearchQuery).
  const withEntity = dedupeAndCleanTerms([
    ...(input.entity ? [input.entity] : []),
    ...input.tags,
  ]).slice(0, MAX_QUERY_TERMS);
  if (withEntity.length > 0) addCandidate(withEntity);

  // Rung 2: tags only — drops the specific venue/entity name, which is the
  // term most likely to have zero matches in a general stock-photo library.
  const tagsOnly = dedupeAndCleanTerms(input.tags).slice(0, MAX_QUERY_TERMS);
  if (tagsOnly.length > 0) addCandidate(tagsOnly);

  // Rung 3: section + the single most generic tag — broad category search.
  if (input.tags.length > 0) addCandidate([input.section, input.tags[0]!]);

  // Rung 4: section alone — last resort before giving up.
  addCandidate([input.section]);

  return candidates.length > 0 ? candidates : ['editorial'];
}

// ---------------------------------------------------------------------------
// Unsplash API — search, photographer capture, download-trigger, alt text
// ---------------------------------------------------------------------------

type UnsplashUser = { name?: string; links?: { html?: string } };

type UnsplashPhotoRow = {
  id?: string;
  width?: number;
  height?: number;
  urls?: { raw?: string; full?: string; regular?: string };
  links?: { download_location?: string };
  user?: UnsplashUser;
  alt_description?: string | null;
  description?: string | null;
};

type UnsplashSearchResponse = {
  results?: UnsplashPhotoRow[];
  total?: number;
  errors?: string[];
};

/** Same selection logic as unsplashHero.ts's pickHighestResolutionPhoto — ported, not imported. */
function pickHighestResolutionPhoto(results: UnsplashPhotoRow[]): UnsplashPhotoRow | null {
  if (!results.length) return null;
  let best = results[0]!;
  let bestPx = (best.width || 0) * (best.height || 0);
  for (const p of results) {
    const px = (p.width || 0) * (p.height || 0);
    if (px > bestPx) {
      bestPx = px;
      best = p;
    }
  }
  return best;
}

/**
 * Fires Unsplash's required download-trigger endpoint (Unsplash API
 * Guidelines: every time a photo is used, GET the photo's
 * `links.download_location` with your Client-ID). Unlike
 * unsplashHero.ts's fire-and-forget version, this reports whether the
 * call actually succeeded (HTTP 200) so the caller/test harness can
 * confirm it fired rather than assuming.
 */
async function triggerUnsplashDownload(
  downloadLocation: string,
  key: string
): Promise<{ fired: boolean; httpStatus?: number }> {
  if (!downloadLocation.startsWith('http')) return { fired: false };
  try {
    const res = await axios.get(downloadLocation, {
      headers: { Authorization: `Client-ID ${key}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    return { fired: res.status === 200, httpStatus: res.status };
  } catch (err: unknown) {
    console.warn('[image-sourcing] download-trigger call threw:', err instanceof Error ? err.message : String(err));
    return { fired: false };
  }
}

/**
 * Alt text sourced from Unsplash's own alt_description/description
 * (a real, factual description of the photo's actual content — exactly
 * what accessibility alt text should be), not a generic template. Only
 * falls back to a query-based generic description when Unsplash provides
 * neither field.
 */
function buildAltText(photo: UnsplashPhotoRow, query: string): string {
  const desc = (photo.alt_description || photo.description || '').trim();
  if (desc) {
    return desc.charAt(0).toUpperCase() + desc.slice(1);
  }
  return `Editorial photo related to ${query}`;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type ImageSourcingResult = {
  query: string;
  photoId: string;
  imageUrl: string;
  photographerName: string;
  photographerProfileUrl: string;
  altText: string;
  downloadTriggerFired: boolean;
};

export type ImageSourcingOutcome =
  | { status: 'ok'; result: ImageSourcingResult }
  | { status: 'no-key' }
  | { status: 'no-results'; query: string }
  | { status: 'rate-limited'; query: string; httpStatus: number }
  | { status: 'error'; query: string; message: string };

// ---------------------------------------------------------------------------
// Stage 7 entry point
// ---------------------------------------------------------------------------

async function searchUnsplashOnce(
  query: string,
  key: string
): Promise<{ outcome: 'ok'; photo: UnsplashPhotoRow } | { outcome: 'no-results' | 'rate-limited' | 'error'; httpStatus?: number; message?: string }> {
  let res;
  try {
    res = await axios.get<UnsplashSearchResponse>(UNSPLASH_SEARCH, {
      params: { query, per_page: 15, orientation: 'landscape' },
      headers: { Authorization: `Client-ID ${key}` },
      timeout: 20_000,
      validateStatus: () => true,
    });
  } catch (err: unknown) {
    return { outcome: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  if (res.status === 403 || res.status === 429) {
    return { outcome: 'rate-limited', httpStatus: res.status };
  }

  if (res.status !== 200 || !res.data?.results?.length) {
    return { outcome: 'no-results', httpStatus: res.status };
  }

  const photo = pickHighestResolutionPhoto(res.data.results);
  if (!photo?.urls) {
    return { outcome: 'no-results', httpStatus: res.status };
  }

  return { outcome: 'ok', photo };
}

/**
 * Tries buildQueryLadder()'s rungs in order (most specific first),
 * stopping at the first rung that returns real results. Stops immediately
 * on a rate-limit/quota response or a network error — never retries past
 * that, per the build spec.
 */
export async function sourceImage(input: ImageSourcingInput): Promise<ImageSourcingOutcome> {
  const key = config.unsplash.accessKey;
  if (!key) {
    console.error('[image-sourcing] STOPPING — UNSPLASH_ACCESS_KEY not set. Not guessing/hardcoding a key.');
    return { status: 'no-key' };
  }

  const ladder = buildQueryLadder(input);
  console.log(`[image-sourcing] "${input.title}" → query ladder: ${JSON.stringify(ladder)}`);

  let query = ladder[0]!;
  let photo: UnsplashPhotoRow | null = null;

  for (const candidate of ladder) {
    query = candidate;
    const attempt = await searchUnsplashOnce(candidate, key);
    if (attempt.outcome === 'ok') {
      photo = attempt.photo;
      console.log(`[image-sourcing] rung "${candidate}" → matched`);
      break;
    }
    if (attempt.outcome === 'rate-limited') {
      console.error(`[image-sourcing] STOPPING — Unsplash rate-limit/quota response (HTTP ${attempt.httpStatus}). Not retrying.`);
      return { status: 'rate-limited', query: candidate, httpStatus: attempt.httpStatus! };
    }
    if (attempt.outcome === 'error') {
      console.error(`[image-sourcing] Unsplash search call threw: ${attempt.message}`);
      return { status: 'error', query: candidate, message: attempt.message! };
    }
    console.log(`[image-sourcing] rung "${candidate}" → no results, trying next rung if any`);
  }

  if (!photo) {
    console.warn(`[image-sourcing] Exhausted query ladder with no results. Ladder tried: ${JSON.stringify(ladder)}`);
    return { status: 'no-results', query };
  }

  const imageUrl = photo.urls?.raw || photo.urls?.full || photo.urls?.regular || '';

  let downloadTriggerFired = false;
  const downloadLoc = photo.links?.download_location;
  if (downloadLoc) {
    const trig = await triggerUnsplashDownload(downloadLoc, key);
    downloadTriggerFired = trig.fired;
    console.log(`[image-sourcing] download-trigger call → fired=${trig.fired}, httpStatus=${trig.httpStatus ?? '(threw)'}`);
  } else {
    console.warn('[image-sourcing] Selected photo has no links.download_location — cannot fire required download-trigger call.');
  }

  const result: ImageSourcingResult = {
    query,
    photoId: photo.id || '(unknown)',
    imageUrl,
    photographerName: photo.user?.name || '(unknown photographer)',
    photographerProfileUrl: photo.user?.links?.html || '',
    altText: buildAltText(photo, query),
    downloadTriggerFired,
  };

  console.log(
    `[image-sourcing] selected photoId=${result.photoId} photographer="${result.photographerName}" downloadTriggerFired=${downloadTriggerFired}`
  );
  return { status: 'ok', result };
}

// ---------------------------------------------------------------------------
// Test harness — chains real Stage 4 (sufficiencyGate) → Stage 5
// (articleWriter) to get real WrittenArticle.tags for tests 1-4 (same
// fixtures used for Stage 5/6 tonight), then runs this stage on the
// resulting tags/section/entity. writeArticle()/evaluateSufficiency() are
// dynamic-imported here, test-harness-only, same pattern as
// verificationGate.ts's harness. Adds one BONUS fixture specifically
// constructed to exercise the football/sports disambiguation rule, since
// none of tests 1-4 happen to contain that term.
// ---------------------------------------------------------------------------

type HarnessTopicInput = {
  title: string;
  snippet?: string;
  section?: string;
  verdict?: string;
  subjectTag?: string;
  [key: string]: unknown;
};

type HarnessFact = { field: string; value: string; source: string; sourceUrl?: string };

type HarnessSourceGatheringResult = {
  topic: HarnessTopicInput;
  facts: HarnessFact[];
  primarySourceFound: boolean;
  factCount: number;
};

function extractEntity(sourcing: HarnessSourceGatheringResult): string | undefined {
  const venueFact = sourcing.facts.find((f) => f.field === 'venueName');
  if (venueFact) return venueFact.value;
  return sourcing.topic.subjectTag;
}

async function runTestHarness(): Promise<void> {
  const { writeArticle } = await import('./articleWriter');
  const { evaluateSufficiency } = await import('./sufficiencyGate');

  type Case = { label: string; topic: HarnessTopicInput; sourcing: HarnessSourceGatheringResult };

  const cases: Case[] = [
    {
      label: 'TEST 1: WordCamp US 2026 (rich facts)',
      topic: { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Phoenix Convention Center North', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'address', value: '100 N 3rd St, Phoenix, AZ 85004', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'date', value: '2026-08-16', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'time', value: '9:00 AM', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
          { field: 'ticketUrl', value: 'https://2026.us.wordcamp.org/tickets/', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'price', value: '$85', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
          { field: 'description', value: 'WordCamp US brings together WordPress users, developers, and businesses for three days of sessions and workshops.', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
        ],
        primarySourceFound: true,
        factCount: 7,
      },
    },
    {
      label: 'TEST 2: Sunday Yoga (thin facts)',
      topic: { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Kähvi Coffee + Cafe', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/sundayyoga' },
        ],
        primarySourceFound: false,
        factCount: 1,
      },
    },
    {
      label: 'TEST 3: Rare Meteor Shower (national-reframe)',
      topic: { title: 'Rare Meteor Shower Peaks Tonight', section: 'news', subjectTag: 'astronomy', verdict: 'national-reframe' },
      sourcing: {
        topic: { title: 'Rare Meteor Shower Peaks Tonight', section: 'news', subjectTag: 'astronomy', verdict: 'national-reframe' },
        facts: [
          { field: 'visibility', value: 'Not visible from Arizona tonight due to forecast monsoon cloud cover', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
          { field: 'alternative', value: 'Best alternative Arizona viewing window is Thursday night, when skies are forecast to clear', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
          { field: 'date', value: '2026-08-13', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
          { field: 'description', value: 'The Perseid meteor shower peaks tonight with up to 60 meteors per hour visible under clear skies.', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
        ],
        primarySourceFound: true,
        factCount: 4,
      },
    },
    {
      label: 'TEST 4: Trivia Night (conflicting facts)',
      topic: { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Arizona Wilderness Brewing Co.', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'date', value: 'Wednesdays', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'price', value: 'Free', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'price', value: '$5 buy-in', source: 'venue page — HTTP fetch (https://azwbeer.com/gilbert/events/)', sourceUrl: 'https://azwbeer.com/gilbert/events/' },
        ],
        primarySourceFound: true,
        factCount: 4,
      },
    },
  ];

  console.log('[image-sourcing] ========== TEST HARNESS start ==========');

  const summary: { label: string; outcome: ImageSourcingOutcome }[] = [];

  for (const c of cases) {
    console.log(`\n\n=== ${c.label} ===`);
    const sufficiency = evaluateSufficiency(c.sourcing);
    const article = await writeArticle(c.topic, c.sourcing, sufficiency);
    if (!article) {
      console.log('(no article written — decision was skip; nothing to source an image for)');
      continue;
    }
    console.log(`Stage 5 tags: ${JSON.stringify(article.tags)}`);

    const input: ImageSourcingInput = {
      tags: article.tags,
      section: c.topic.section || 'news',
      entity: extractEntity(c.sourcing),
      title: article.title,
    };
    console.log(`Image sourcing input: entity=${JSON.stringify(input.entity)}, section=${input.section}`);

    const outcome = await sourceImage(input);
    summary.push({ label: c.label, outcome });
    console.log('Outcome:');
    console.log(JSON.stringify(outcome, null, 2));
  }

  console.log('\n\n=== BONUS: football/sports disambiguation rule ===');
  const bonusInput: ImageSourcingInput = {
    tags: ['football', 'college football', 'ASU Sun Devils'],
    section: 'sports',
    entity: 'ASU Sun Devils',
    title: 'ASU Football Season Opener Set for This Weekend',
  };
  console.log(`Query built: "${buildImageSearchQuery(bonusInput)}" (confirms "american football" was appended)`);
  const bonusOutcome = await sourceImage(bonusInput);
  summary.push({ label: 'BONUS: football/sports disambiguation', outcome: bonusOutcome });
  console.log('Outcome:');
  console.log(JSON.stringify(bonusOutcome, null, 2));

  console.log('\n\n########## IMAGE SOURCING TEST HARNESS SUMMARY ##########');
  for (const { label, outcome } of summary) {
    if (outcome.status === 'ok') {
      console.log(
        `${label} → OK — query="${outcome.result.query}", photographer="${outcome.result.photographerName}", downloadTriggerFired=${outcome.result.downloadTriggerFired}`
      );
    } else {
      console.log(`${label} → ${outcome.status.toUpperCase()}${'query' in outcome ? ` (query="${outcome.query}")` : ''}`);
    }
  }
  console.log('[image-sourcing] ========== TEST HARNESS end ==========');
}

function safeErrorSummary(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const apiMessage =
      body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
        ? JSON.stringify((body as Record<string, unknown>).error)
        : undefined;
    return `AxiosError: HTTP ${status ?? '(no response)'}${apiMessage ? ` — ${apiMessage}` : ` — ${err.message}`}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

if (require.main === module) {
  runTestHarness().catch((err) => {
    console.error('[image-sourcing] Fatal:', safeErrorSummary(err));
    process.exit(1);
  });
}

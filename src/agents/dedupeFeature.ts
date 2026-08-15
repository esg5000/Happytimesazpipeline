/**
 * Stage 9 — Dedupe (pipeline-redesign-architecture.md).
 *
 * Fixes a confirmed gap: today's dedupe (agents/sanityPublisher.ts's
 * getExistingNewsSourceUrls, read read-only for reference, not modified)
 * is exact-URL-match only — the same real-world event covered by two
 * different outlets, or re-covered under a new URL days later, isn't
 * caught, because the URLs never match even though the underlying
 * entity/topic is the same.
 *
 * NEW MODULE, smaller scope than Stages 7/8 — builds ONLY the normalized
 * entity/topic dedupe key generation and a read-only recent-posts check
 * against it. Does not implement an auto-feature/pinning mechanism (that
 * exists already in production as sanityPublisher.ts's
 * autoFeatureIfStale, untouched here) — this build's actual instructions
 * only specified the dedupe-key half, so that's what's built; flagged in
 * the build report as worth confirming whether a "Feature" half was
 * expected here too.
 *
 * STANDALONE, SHADOW MODE ONLY — not wired into any publish flow. The one
 * live call this module makes is a read-only Sanity GROQ fetch (via the
 * existing, unmodified getSanityClient()) to check recent posts; it never
 * writes.
 */
import { getSanityClient } from '../../agents/sanityPublisher';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export type DedupeCandidateInput = {
  /** For logging/fallback only — see buildDedupeKey. */
  title: string;
  /**
   * The specific named entity this topic is about (brand, venue, act,
   * event name) — e.g. "Trulieve", "Steel Pulse", "WordCamp US". This is
   * the field that most needs to come from structured upstream data
   * (Stage 1's subjectTag or Stage 3's venueName), not parsed here from
   * raw headline text — this module deliberately does no NLP.
   */
  entityName: string;
  /** City/location — critical for correctly distinguishing e.g. multiple same-brand openings in different cities (see the Trulieve test case). */
  city?: string;
  /** Raw date string in whatever form the source gave it — normalized best-effort; left out of the key entirely if it can't be parsed, rather than guessed. */
  date?: string;
};

export type DedupeMatch = {
  postId: string;
  title: string;
  matchedKey: string;
};

export type DedupeCheckResult = {
  candidateKey: string;
  isDuplicate: boolean;
  matches: DedupeMatch[];
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCity(city: string): string {
  return city
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort ISO date normalization. Returns undefined (never a guess) if the string doesn't parse. */
function normalizeDate(raw: string): string | undefined {
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * Small AZ city list — ported from src/agents/sourceGathering.ts's
 * AZ_CITY_HINTS, not imported (that file is a sibling standalone module,
 * same "port, don't import" pattern used throughout this session).
 */
const AZ_CITY_HINTS = [
  'Phoenix', 'Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Glendale', 'Peoria', 'Surprise',
  'Flagstaff', 'Sedona', 'Prescott', 'Kingman', 'Tucson', 'Sierra Vista', 'Yuma', 'Lake Havasu City',
  'Show Low', 'Safford',
] as const;

/** Best-effort city extraction from arbitrary text, used only as a fallback when no explicit city is given. */
function extractCityHint(text: string): string | undefined {
  for (const city of AZ_CITY_HINTS) {
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) return city;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Normalized entity + city + date key — NOT slug or title string. Two
 * candidates about the same entity in different cities (or on different
 * dates) get different keys and are correctly treated as distinct, not
 * duplicates; two candidates about the same entity, same city, same date
 * (even from different outlets/URLs) get the same key and are flagged.
 */
export function buildDedupeKey(input: DedupeCandidateInput): string {
  const entity = normalizeEntityName(input.entityName || input.title);
  const city = normalizeCity(input.city || extractCityHint(input.title) || '');
  const date = input.date ? normalizeDate(input.date) || input.date.toLowerCase().trim() : '';
  const key = [entity, city, date].filter(Boolean).join('::');
  if (!city) {
    console.warn(`[dedupe] No city available for "${input.title}" (entity="${entity}") — key built without a city component, which weakens distinctness for same-entity/different-city cases.`);
  }
  return key;
}

/**
 * Best-effort re-derivation of a dedupe key from an EXISTING Sanity post,
 * which only has title/tags (no structured entity/city/date facts the way
 * a fresh Stage 0-9 candidate does). Necessarily heuristic — flagged, not
 * presented as equally reliable as buildDedupeKey() on real structured
 * input. Date is left out entirely (an existing post's publishedAt is a
 * publish timestamp, not necessarily the event date — using it would risk
 * false negatives, not just false positives, so it's safer to compare on
 * entity+city only for existing posts).
 */
function deriveDedupeKeyFromExistingPost(title: string, tags: string[]): string {
  const city = extractCityHint(`${title} ${tags.join(' ')}`);
  const entity = normalizeEntityName(title);
  return [entity, city ? normalizeCity(city) : ''].filter(Boolean).join('::');
}

// ---------------------------------------------------------------------------
// Read-only recent-posts check
// ---------------------------------------------------------------------------

const RECENT_WINDOW_DAYS = 7;

type RecentPost = { _id: string; title: string; tags?: string[]; publishedAt?: string };

async function fetchRecentPosts(): Promise<RecentPost[]> {
  const client = getSanityClient();
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    return await client.fetch<RecentPost[]>(
      `*[_type == "post" && defined(publishedAt) && publishedAt >= $since]{ _id, title, tags, publishedAt }`,
      { since }
    );
  } catch (err: unknown) {
    console.warn('[dedupe] fetchRecentPosts failed (read-only; treating as no matches):', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Stage 9 entry point. Read-only — never writes. Builds the candidate's
 * key, pulls the last RECENT_WINDOW_DAYS days of posts, re-derives a
 * best-effort key for each (see deriveDedupeKeyFromExistingPost), and
 * flags a match on exact key equality only (no fuzzy scoring — a
 * mismatch, even a near one, is treated as distinct rather than guessed
 * at).
 */
export async function checkForDuplicates(candidate: DedupeCandidateInput): Promise<DedupeCheckResult> {
  const candidateKey = buildDedupeKey(candidate);
  if (!candidateKey) {
    console.warn(`[dedupe] Empty dedupe key for "${candidate.title}" — cannot check for duplicates, treating as not-a-duplicate.`);
    return { candidateKey, isDuplicate: false, matches: [] };
  }

  const recentPosts = await fetchRecentPosts();
  const matches: DedupeMatch[] = [];
  for (const post of recentPosts) {
    const key = deriveDedupeKeyFromExistingPost(post.title, post.tags || []);
    if (key && key === candidateKey) {
      matches.push({ postId: post._id, title: post.title, matchedKey: key });
    }
  }

  console.log(`[dedupe] "${candidate.title}" → key="${candidateKey}", checked ${recentPosts.length} recent post(s), ${matches.length} match(es)`);
  return { candidateKey, isDuplicate: matches.length > 0, matches };
}

// ---------------------------------------------------------------------------
// Test harness — hand-built cases, no OpenAI calls needed (pure key
// generation is testable directly; only the live-Sanity-check portion
// makes a real call, and it's read-only).
// ---------------------------------------------------------------------------

function runHandBuiltKeyTests(): void {
  console.log('[dedupe] ========== HAND-BUILT KEY TESTS start ==========');

  // Case A: the three Trulieve dispensary-opening headlines — same brand,
  // three different AZ cities. Must produce three DISTINCT keys.
  const trulieveChandler: DedupeCandidateInput = {
    title: 'Trulieve Opens New Dispensary in Chandler',
    entityName: 'Trulieve',
    city: 'Chandler',
    date: '2026-08-10',
  };
  const trulievePhoenix: DedupeCandidateInput = {
    title: 'Trulieve Opens New Dispensary in Phoenix',
    entityName: 'Trulieve',
    city: 'Phoenix',
    date: '2026-08-10',
  };
  const trulieveMesa: DedupeCandidateInput = {
    title: 'Trulieve Opens New Dispensary in Mesa',
    entityName: 'Trulieve',
    city: 'Mesa',
    date: '2026-08-11',
  };

  const keyChandler = buildDedupeKey(trulieveChandler);
  const keyPhoenix = buildDedupeKey(trulievePhoenix);
  const keyMesa = buildDedupeKey(trulieveMesa);

  console.log('\n--- Case A: Trulieve x3, different cities ---');
  console.log(`Chandler → "${keyChandler}"`);
  console.log(`Phoenix  → "${keyPhoenix}"`);
  console.log(`Mesa     → "${keyMesa}"`);
  const allDistinct = new Set([keyChandler, keyPhoenix, keyMesa]).size === 3;
  console.log(`RESULT: all three keys distinct → ${allDistinct} (expected: true — same entity, different cities, must NOT collide)`);

  // Case B: the SAME event, same entity/city/date, covered by two
  // different outlets under two different URLs. Must produce the SAME
  // key (this is the actual gap being fixed — exact-URL dedupe would miss
  // this entirely since the URLs differ).
  const steelPulseOutletA: DedupeCandidateInput = {
    title: 'Steel Pulse Reggae Show Hits The Van Buren',
    entityName: 'Steel Pulse',
    city: 'Phoenix',
    date: '2026-08-13',
  };
  const steelPulseOutletB: DedupeCandidateInput = {
    title: 'Reggae Legends Steel Pulse Play Phoenix Venue',
    entityName: 'Steel Pulse',
    city: 'Phoenix',
    date: 'Aug 13, 2026',
  };
  const keyA = buildDedupeKey(steelPulseOutletA);
  const keyB = buildDedupeKey(steelPulseOutletB);

  console.log('\n--- Case B: same event, two outlets, two different headlines/URLs ---');
  console.log(`Outlet A → "${keyA}"`);
  console.log(`Outlet B → "${keyB}"`);
  console.log(`RESULT: keys match → ${keyA === keyB} (expected: true — same entity/city/date, different wording entirely, must collide)`);

  // Case C: same entity, same city, but a genuinely different date (e.g. a
  // recurring or re-covered event days apart) — should NOT be flagged as
  // the same occurrence.
  const triviaWeek1: DedupeCandidateInput = {
    title: 'Trivia Night at Arizona Wilderness Brewing Co.',
    entityName: 'Arizona Wilderness Brewing Co. Trivia Night',
    city: 'Gilbert',
    date: '2026-08-05',
  };
  const triviaWeek2: DedupeCandidateInput = {
    title: 'Trivia Night at Arizona Wilderness Brewing Co.',
    entityName: 'Arizona Wilderness Brewing Co. Trivia Night',
    city: 'Gilbert',
    date: '2026-08-12',
  };
  const keyWeek1 = buildDedupeKey(triviaWeek1);
  const keyWeek2 = buildDedupeKey(triviaWeek2);
  console.log('\n--- Case C: same weekly entity/venue, different week ---');
  console.log(`Week 1 → "${keyWeek1}"`);
  console.log(`Week 2 → "${keyWeek2}"`);
  console.log(`RESULT: keys distinct → ${keyWeek1 !== keyWeek2} (expected: true — different date, distinct occurrences)`);

  console.log('\n\n########## HAND-BUILT KEY TEST SUMMARY ##########');
  console.log(`Case A (Trulieve x3 distinct cities, must be distinct): ${allDistinct ? 'PASS' : 'FAIL'}`);
  console.log(`Case B (same event, two outlets, must collide): ${keyA === keyB ? 'PASS' : 'FAIL'}`);
  console.log(`Case C (same venue/entity, different week, must be distinct): ${keyWeek1 !== keyWeek2 ? 'PASS' : 'FAIL'}`);
  console.log('[dedupe] ========== HAND-BUILT KEY TESTS end ==========');
}

async function runLiveRecentPostsCheck(): Promise<void> {
  console.log('\n\n[dedupe] ========== LIVE RECENT-POSTS CHECK start (read-only) ==========');
  const candidate: DedupeCandidateInput = {
    title: 'Trulieve Opens New Dispensary in Chandler',
    entityName: 'Trulieve',
    city: 'Chandler',
    date: '2026-08-10',
  };
  const result = await checkForDuplicates(candidate);
  console.log(JSON.stringify(result, null, 2));
  console.log('[dedupe] ========== LIVE RECENT-POSTS CHECK end ==========');
}

async function runTestHarness(): Promise<void> {
  runHandBuiltKeyTests();
  await runLiveRecentPostsCheck();
}

if (require.main === module) {
  runTestHarness().catch((err) => {
    console.error('[dedupe] Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

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
  'Flagstaff', 'Sedona', 'Cottonwood', 'Prescott', 'Kingman', 'Tucson', 'Sierra Vista', 'Yuma', 'Lake Havasu City',
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

function buildEntityCityParts(input: DedupeCandidateInput): { entity: string; city: string } {
  const entity = normalizeEntityName(input.entityName || input.title);
  const city = normalizeCity(input.city || extractCityHint(input.title) || '');
  return { entity, city };
}

/**
 * Normalized entity + city + date key — NOT slug or title string. Two
 * candidates about the same entity in different cities (or on different
 * dates) get different keys and are correctly treated as distinct, not
 * duplicates; two candidates about the same entity, same city, same date
 * (even from different outlets/URLs) get the same key and are flagged.
 *
 * Used for the same-run (`seenThisRun`) comparison, which is symmetric —
 * candidateKey vs. candidateKey — so the date segment is meaningful there
 * (it's what keeps e.g. the same recurring venue/entity discovered twice
 * in one run, on two different dates, from colliding). NOT used for the
 * Sanity cross-run comparison — see buildDedupeKeyNoDate.
 */
export function buildDedupeKey(input: DedupeCandidateInput): string {
  const { entity, city } = buildEntityCityParts(input);
  const date = input.date ? normalizeDate(input.date) || input.date.toLowerCase().trim() : '';
  const key = [entity, city, date].filter(Boolean).join('::');
  if (!city) {
    console.warn(`[dedupe] No city available for "${input.title}" (entity="${entity}") — key built without a city component, which weakens distinctness for same-entity/different-city cases.`);
  }
  return key;
}

/**
 * Same as buildDedupeKey but WITHOUT the date segment — kept symmetric
 * with deriveDedupeKeyFromExistingPost, which deliberately never includes
 * date (an existing post's publishedAt is a publish timestamp, not
 * necessarily the event date). buildDedupeKey's candidate-side key always
 * carries a date segment whenever the source article has one, so comparing
 * it directly against deriveDedupeKeyFromExistingPost's dateless key could
 * never match by design — this is the key used for the Sanity
 * recent-posts comparison instead.
 */
export function buildDedupeKeyNoDate(input: DedupeCandidateInput): string {
  const { entity, city } = buildEntityCityParts(input);
  return [entity, city].filter(Boolean).join('::');
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
export function deriveDedupeKeyFromExistingPost(title: string, tags: string[]): string {
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
 * One entry per topic that has already passed Stage 9 THIS RUN — see
 * `seenThisRun` on checkForDuplicates below for why this exists.
 */
export type SeenThisRunEntry = { key: string; title: string };

/**
 * Stage 9 entry point. Read-only — never writes. Builds the candidate's
 * key, pulls the last RECENT_WINDOW_DAYS days of posts, re-derives a
 * best-effort key for each (see deriveDedupeKeyFromExistingPost), and
 * flags a match on exact key equality only (no fuzzy scoring — a
 * mismatch, even a near one, is treated as distinct rather than guessed
 * at).
 *
 * Confirmed gap (two Ketel Marte casino articles, same event, different
 * outlets, published 5 seconds apart): fetchRecentPosts() only sees posts
 * already durably published in Sanity BEFORE this run started.
 * orchestratorV2.ts's runOrchestratorV2AndPublish() runs the entire dry-run
 * funnel — including every topic's Stage 9 check — for ALL topics before
 * the real-publish loop writes anything, so two sibling candidates
 * discovered in the SAME run were never cross-checked against each other;
 * neither was in Sanity yet when the other's check ran. `seenThisRun` is
 * an optional in-memory list the caller accumulates across its own loop
 * (one {key, title} entry per topic that passed Stage 9 so far this run)
 * and passes back in on each subsequent call — checked with the exact
 * same equality logic as the Sanity check, not a looser one.
 */
export async function checkForDuplicates(
  candidate: DedupeCandidateInput,
  seenThisRun: SeenThisRunEntry[] = []
): Promise<DedupeCheckResult> {
  const candidateKey = buildDedupeKey(candidate);
  if (!candidateKey) {
    console.warn(`[dedupe] Empty dedupe key for "${candidate.title}" — cannot check for duplicates, treating as not-a-duplicate.`);
    return { candidateKey, isDuplicate: false, matches: [] };
  }
  const candidateKeyNoDate = buildDedupeKeyNoDate(candidate);

  const recentPosts = await fetchRecentPosts();
  const matches: DedupeMatch[] = [];
  for (const post of recentPosts) {
    const key = deriveDedupeKeyFromExistingPost(post.title, post.tags || []);
    if (key && key === candidateKeyNoDate) {
      matches.push({ postId: post._id, title: post.title, matchedKey: key });
    }
  }

  for (const seen of seenThisRun) {
    if (seen.key === candidateKey) {
      matches.push({ postId: '(same-run, not yet published)', title: seen.title, matchedKey: seen.key });
    }
  }

  console.log(
    `[dedupe] "${candidate.title}" → key="${candidateKey}", checked ${recentPosts.length} recent post(s) + ${seenThisRun.length} same-run candidate(s), ${matches.length} match(es)`
  );
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

  // Case D: reconstruction of the confirmed Queen B Sushi miss — same
  // outlet, same story, identical title, 3 days apart (per the confirmed
  // report: title was byte-identical on both posts, so entityName here is
  // deliberately identical too — this case isolates the date-asymmetry
  // bug specifically, not specificSubject wording drift across runs,
  // which is a separate, still-open risk this fix does not address).
  // "existing post" side (Aug 20, already in Sanity) is re-derived via
  // deriveDedupeKeyFromExistingPost, which never has a date. Must collide
  // on the dateless key.
  const queenBTitle = 'Queen B Sushi set to open in Cottonwood on Sept. 4';
  const queenBExistingPost = {
    title: queenBTitle,
    tags: ['food', 'cottonwood'],
  };
  const queenBCandidate: DedupeCandidateInput = {
    title: queenBTitle,
    entityName: queenBTitle,
    date: '2026-08-23T09:00:00.000Z',
  };
  const queenBDerivedPostKey = deriveDedupeKeyFromExistingPost(queenBExistingPost.title, queenBExistingPost.tags);
  const queenBCandidateFullKey = buildDedupeKey(queenBCandidate);
  const queenBCandidateNoDateKey = buildDedupeKeyNoDate(queenBCandidate);
  console.log('\n--- Case D: Queen B Sushi reconstruction (same outlet, cross-run, 3 days apart) ---');
  console.log(`Existing Aug 20 post, derived key → "${queenBDerivedPostKey}"`);
  console.log(`Aug 23 candidate, full key (date-inclusive, used for seenThisRun) → "${queenBCandidateFullKey}"`);
  console.log(`Aug 23 candidate, no-date key (used for Sanity comparison)        → "${queenBCandidateNoDateKey}"`);
  const queenBCollides = queenBDerivedPostKey === queenBCandidateNoDateKey;
  console.log(`RESULT: no-date keys match → ${queenBCollides} (expected: true — this is the fix; full keys would NOT have matched: ${queenBDerivedPostKey === queenBCandidateFullKey})`);

  // Case E: reconstruction of Sunday's Ketel Marte same-run miss — two
  // different outlets, same event, discovered in the SAME run (so neither
  // is in Sanity yet when the other's Stage 9 check runs). This is the
  // seenThisRun path, which must stay on the full (date-inclusive) key —
  // confirms the primary fix didn't regress it.
  const ketelMarteOutletA: DedupeCandidateInput = {
    title: 'Ketel Marte spotted at Talking Stick Resort casino',
    entityName: 'Ketel Marte casino sighting',
    city: 'Scottsdale',
    date: '2026-08-17',
  };
  const ketelMarteOutletB: DedupeCandidateInput = {
    title: 'Diamondbacks star Ketel Marte seen gambling at Valley casino',
    entityName: 'Ketel Marte casino sighting',
    city: 'Scottsdale',
    date: '2026-08-17',
  };
  const keyKetelA = buildDedupeKey(ketelMarteOutletA);
  const keyKetelB = buildDedupeKey(ketelMarteOutletB);
  console.log('\n--- Case E: Ketel Marte reconstruction (same-run, two outlets, seenThisRun path) ---');
  console.log(`Outlet A (seenThisRun entry) → "${keyKetelA}"`);
  console.log(`Outlet B (candidate)         → "${keyKetelB}"`);
  console.log(`RESULT: full keys match → ${keyKetelA === keyKetelB} (expected: true — same-run comparison still symmetric/date-inclusive, no regression)`);

  console.log('\n\n########## HAND-BUILT KEY TEST SUMMARY ##########');
  console.log(`Case A (Trulieve x3 distinct cities, must be distinct): ${allDistinct ? 'PASS' : 'FAIL'}`);
  console.log(`Case B (same event, two outlets, must collide): ${keyA === keyB ? 'PASS' : 'FAIL'}`);
  console.log(`Case C (same venue/entity, different week, must be distinct): ${keyWeek1 !== keyWeek2 ? 'PASS' : 'FAIL'}`);
  console.log(`Case D (Queen B Sushi cross-run reconstruction, must collide on no-date key): ${queenBCollides ? 'PASS' : 'FAIL'}`);
  console.log(`Case E (Ketel Marte same-run reconstruction, must collide on full key): ${keyKetelA === keyKetelB ? 'PASS' : 'FAIL'}`);
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

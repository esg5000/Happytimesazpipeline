/**
 * Topic Discovery — Stages 0-2 of the pipeline redesign (see
 * pipeline-redesign-architecture.md; that file was not found in the repo
 * at the time this was written, so the query classes and verdict rubric
 * below are reconstructed from the spec given directly in the build
 * request, not read from the doc).
 *
 * STANDALONE. Does not modify, import from, or get imported by
 * agents/newsApiSync.ts, agents/sanityPublisher.ts (except the read-only
 * getSanityClient for the shadow-mode comparison query), agents/editorAgent.ts,
 * or src/agents/researchAgent.ts. Runs alongside the existing 5-slot
 * pipeline, not in place of it. SHADOW MODE ONLY: fetches from SerpAPI,
 * classifies with Gemini, logs to a file outside the repo. Never publishes
 * to Sanity.
 *
 * Stage 1 classification runs on Gemini 3.7 Flash (generateContent +
 * googleSearch grounding tool), not OpenAI — swapped from the original
 * OpenAI Responses API + web_search implementation using the exact
 * request pattern confirmed live in scripts/probe-gemini-grounding.ts
 * earlier this session (same endpoint, same model, same tool key, no
 * responseSchema/responseMimeType — freeform JSON via prompt instruction,
 * same approach the OpenAI version used). Output parsing/shape
 * (verdict/section/relevanceScore/subjectTag/excludeAsCrimeTragedy) is
 * unchanged — this was a provider swap, not a logic change.
 *
 * `normalizeSourceRow` / `mergeSourcesByUrl` from src/agents/researchAgent.ts
 * were ported (copied, not imported — they are not exported there) and
 * adapted to the {title,url,summary} shape this module needs. `htmlToPlainText`
 * was NOT ported: Stage 1 is a locality read, not article research, and does
 * not fetch full page text or use Playwright.
 */
import axios from 'axios';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { config } from '../../config';
import { getSanityClient } from '../../agents/sanityPublisher';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';
/** Gemini 3.7 Flash — confirmed reachable on this account/key (2.5-generation models are not; see scripts/probe-gemini-model-access.ts). */
const STAGE1_GEMINI_MODEL = 'gemini-3.7-flash';
const GEMINI_GENERATE_CONTENT_URL = `https://generativelanguage.googleapis.com/v1beta/models/${STAGE1_GEMINI_MODEL}:generateContent`;

/** After Stage 0 pool + dedupe, keep at most this many candidates (newest first) before Stage 1. */
export const STAGE1_CANDIDATE_CAP = 20;
/** Stage 1 in-flight concurrency — batches, not one Promise.all across the whole capped list. */
const STAGE1_BATCH_SIZE = 4;
/**
 * Slots within STAGE1_CANDIDATE_CAP reserved specifically for cannabis-az
 * topics, filled by recency WITHIN the cannabis-az class only — so
 * cannabis-az doesn't have to win a pure combined-recency race against
 * same-day breaking local/national news, which it was confirmed to lose
 * entirely on high-news-volume days despite healthy raw volume. Backfilled
 * from the general combined pool if cannabis-az has fewer than this many
 * candidates (see runStage0Discovery).
 */
const CANNABIS_RESERVED_SLOTS = 4;

const SHADOW_OUTPUT_DIR = join(
  process.env.TEMP || process.env.TMPDIR || '/tmp',
  'happytimesaz-topic-discovery'
);

// ---------------------------------------------------------------------------
// Stage 0 — Topic Discovery
// ---------------------------------------------------------------------------

export type QueryClass = 'local-native' | 'national-with-potential-local-angle' | 'cannabis-az';

type Stage0Query = { query: string; queryClass: QueryClass };

/**
 * Data-driven query set, broader than the 5 existing slots' fixed lists.
 * `local-native`: generic Phoenix-metro discovery (mirrors/broadens old
 * slot-1/slot-3 territory, but content-agnostic — Stage 2 assigns section).
 * `national-with-potential-local-angle`: national/global story shapes that
 * can carry a real local hook (the gap the meteor-shower investigation
 * exposed — nothing in the 5 old slots' queries could ever surface these).
 * `cannabis-az`: Arizona dispensary/law/industry discovery — a real test of
 * whether Stage 0's broader-phrasing approach + Stage 1's model-judged,
 * logged verdict avoids the old slot-4-cannabis-az's opaque 270→0 collapse.
 * Feeds the same pool/dedupe/cap pipeline as the other two classes, no
 * special-casing (see runStage0Discovery, unchanged).
 */
const STAGE0_QUERIES: Stage0Query[] = [
  { query: 'Phoenix news today', queryClass: 'local-native' },
  { query: 'Arizona news today', queryClass: 'local-native' },
  { query: 'Scottsdale Tempe Mesa news today', queryClass: 'local-native' },
  { query: 'Phoenix metro community events this week', queryClass: 'local-native' },
  { query: 'Arizona local business opening today', queryClass: 'local-native' },
  { query: 'metro Phoenix restaurants bars new', queryClass: 'local-native' },
  { query: 'Arizona weather alert today', queryClass: 'national-with-potential-local-angle' },
  { query: 'meteor shower eclipse stargazing Arizona', queryClass: 'national-with-potential-local-angle' },
  { query: 'national retailer chain opening Arizona', queryClass: 'national-with-potential-local-angle' },
  { query: 'Arizona ranked best national list', queryClass: 'national-with-potential-local-angle' },
  { query: 'travel destination feature Arizona national', queryClass: 'national-with-potential-local-angle' },
  { query: 'national trend story Phoenix Arizona angle', queryClass: 'national-with-potential-local-angle' },
  { query: 'Arizona dispensary deals and discounts', queryClass: 'cannabis-az' },
  { query: 'Phoenix Valley cannabis business news', queryClass: 'cannabis-az' },
  { query: 'Arizona marijuana law regulation update', queryClass: 'cannabis-az' },
  { query: 'Scottsdale Tempe Mesa dispensary', queryClass: 'cannabis-az' },
  { query: 'Arizona cannabis industry growth', queryClass: 'cannabis-az' },
  { query: 'Arizona recreational marijuana news', queryClass: 'cannabis-az' },
];

export type RawNewsItem = {
  title: string;
  link: string;
  snippet?: string;
  sourceOutlet?: string;
  publishedDate?: Date;
  queryClass: QueryClass;
  matchedQuery: string;
};

/** Counts SerpAPI HTTP calls made during Stage 0 of this run, and fetch failures distinctly from a normal query with no results. */
type Stage0Usage = {
  apiCalls: number;
  errors: number;
  /** A few example SerpApi error messages from this run, capped — not every failure. */
  errorSample: string[];
};

const STAGE0_ERROR_SAMPLE_MAX = 5;

function parseRelativeNewsDate(s: string): Date | undefined {
  const t = Date.now();
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 10);
  const u = m[2]!.toLowerCase();
  const ms = u.startsWith('minute')
    ? n * 60_000
    : u.startsWith('hour')
      ? n * 3_600_000
      : u.startsWith('day')
        ? n * 86_400_000
        : u.startsWith('week')
          ? n * 7 * 86_400_000
          : n * 30 * 86_400_000;
  return new Date(t - ms);
}

function parsePublishedDate(src: Record<string, unknown>): Date | undefined {
  const iso = src.iso_date;
  if (typeof iso === 'string') {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const dStr = src.date;
  if (typeof dStr === 'string') {
    const rel = parseRelativeNewsDate(dStr);
    if (rel) return rel;
    const d2 = new Date(dStr);
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return undefined;
}

/** SerpAPI `source` can be a plain string or `{name, icon}` depending on result shape. */
function extractSourceOutlet(e: Record<string, unknown>): string | undefined {
  const src = e.source;
  if (typeof src === 'string' && src.trim()) return src.trim();
  if (src && typeof src === 'object') {
    const name = (src as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

function flattenStage0Results(
  raw: unknown[] | undefined,
  queryClass: QueryClass,
  query: string
): RawNewsItem[] {
  const out: RawNewsItem[] = [];

  const push = (
    title: unknown,
    link: unknown,
    snippet: unknown,
    sourceOutlet: string | undefined,
    dateSrc?: Record<string, unknown>
  ) => {
    if (typeof title !== 'string' || typeof link !== 'string' || !link.startsWith('http')) return;
    out.push({
      title,
      link,
      snippet: typeof snippet === 'string' ? snippet : undefined,
      sourceOutlet,
      publishedDate: dateSrc ? parsePublishedDate(dateSrc) : undefined,
      queryClass,
      matchedQuery: query,
    });
  };

  for (const entry of raw || []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (e.highlight && typeof e.highlight === 'object') {
      const h = e.highlight as Record<string, unknown>;
      push(h.title, h.link, h.snippet, extractSourceOutlet(h), h);
    }

    if (Array.isArray(e.stories)) {
      for (const st of e.stories) {
        if (st && typeof st === 'object') {
          const s = st as Record<string, unknown>;
          const merged: Record<string, unknown> = { ...s };
          if (merged.iso_date == null && typeof e.iso_date === 'string') merged.iso_date = e.iso_date;
          if (merged.date == null && typeof e.date === 'string') merged.date = e.date;
          push(s.title, s.link, s.snippet, extractSourceOutlet(s), merged);
        }
      }
    }

    if (!Array.isArray(e.stories) && e.title && e.link) {
      push(e.title, e.link, e.snippet, extractSourceOutlet(e), e);
    }
  }

  return out;
}

async function fetchSerpNewsForQuery(
  q: Stage0Query,
  usage: Stage0Usage
): Promise<RawNewsItem[]> {
  usage.apiCalls += 1;
  console.log(`[topic-discovery] Stage 0: calling SerpAPI for "${q.query}" (class=${q.queryClass})`);

  const { data, status } = await axios.get<{
    error?: string;
    news_results?: unknown[];
  }>(SERPAPI_SEARCH, {
    params: {
      engine: 'google_news',
      api_key: config.serpApi.apiKey,
      q: q.query,
      gl: 'us',
      hl: 'en',
      num: 20,
    },
    validateStatus: () => true,
  });

  // Detection parity with agents/serpApiEventsSync.ts's fetchEventsForCity
  // (and agents/newsApiSync.ts's fetchSerpGoogleNews, fixed alongside this):
  // a non-200 or an `error` field is a thrown exception, caught per-query in
  // runStage0Discovery below, which counts it distinctly from a query that
  // genuinely just returned zero results.
  if (status !== 200) {
    throw new Error(`SerpApi HTTP ${status}: ${data.error || 'request failed'}`);
  }
  if (data.error) {
    throw new Error(data.error);
  }

  const items = flattenStage0Results(data.news_results, q.queryClass, q.query);
  console.log(`[topic-discovery] Stage 0: "${q.query}" → ${items.length} result(s)`);
  return items;
}

/** Unique by link (exact), then by normalized title (case/whitespace-insensitive) to catch wire-copy dupes under different URLs. */
function dedupeStage0Pool(items: RawNewsItem[]): RawNewsItem[] {
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  const out: RawNewsItem[] = [];
  for (const it of items) {
    if (seenLinks.has(it.link)) continue;
    const normTitle = it.title.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seenTitles.has(normTitle)) continue;
    seenLinks.add(it.link);
    seenTitles.add(normTitle);
    out.push(it);
  }
  return out;
}

// ---- Near-duplicate detection --------------------------------------------
//
// Exact link/title dedupe (above) misses multiple outlets covering the same
// event under different URLs and slightly different headline wording (e.g.
// a regional storm story). Full semantic clustering is a bigger investment
// than this stage needs; instead this uses Jaccard token-overlap similarity
// on normalized titles — a standard, well-tested measure for near-duplicate
// text detection (not a bespoke string-distance algorithm). It's implemented
// locally rather than via a new npm dependency since this build is scoped to
// modifying only this file. Runs after exact dedupe, before the
// STAGE1_CANDIDATE_CAP recency cap, so near-dupes don't consume cap slots.

/** Token-overlap ratio (intersection / union) required to treat two titles as the same event. Tunable. */
const NEAR_DUP_JACCARD_THRESHOLD = 0.6;

/** Small generic + news-filler stopword list — enough to stop word reordering and filler ("today", "update") from diluting the overlap signal. Not exhaustive. */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'today', 'tonight', 'tomorrow', 'yesterday', 'week', 'news', 'update', 'updates', 'report', 'reports',
  'says', 'say', 'said', 'after', 'before', 'over', 'into', 'about', 'amid', 'due',
]);

/**
 * Numeric tokens (article counts, years, day-of-month fragments, etc.) are
 * exempted from the length>2 stopword strip below — a bare "8" or "17" is a
 * strong distinguishing signal between two otherwise near-identical headlines
 * ("These 8 ... are now closed" vs "These 17 ... are now closed") and must
 * not be silently dropped just because it's short.
 */
function normalizeTitleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => {
      if (!w) return false;
      if (/^\d+$/.test(w)) return true;
      return w.length > 2 && !TITLE_STOPWORDS.has(w);
    });
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Matches M/D, M/D/YY, or M/D/YYYY date-like fragments (slash or dash
 * separator) directly in the raw title — distinct from normalizeTitleTokens'
 * bag-of-words set, since date structure (the separators) is exactly what
 * that set discards.
 */
const DATE_TOKEN_RE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;

function extractDateTokens(title: string): string[] {
  return Array.from(title.match(DATE_TOKEN_RE) || []);
}

/**
 * True if both titles contain at least one date-like token and none of
 * title A's date tokens match any of title B's. A strong "these are
 * different events" signal that overrides an otherwise-high similarity
 * score — e.g. "Evening Weather Forecast - 5/11/26" vs "...5/12/26" share
 * every other word but are different days and must never merge.
 */
function hasConflictingDateTokens(titleA: string, titleB: string): boolean {
  const datesA = extractDateTokens(titleA);
  const datesB = extractDateTokens(titleB);
  if (datesA.length === 0 || datesB.length === 0) return false;
  const setB = new Set(datesB);
  return !datesA.some((d) => setB.has(d));
}

/**
 * Common function words that end in "s" but are not plural nouns — excluded
 * so the listicle-count detector below doesn't false-match on them.
 */
const NON_PLURAL_S_WORDS = new Set([
  'this', 'was', 'is', 'has', 'across', 'always', 'unless', 'plus', 'minus', 'less', 'his', 'its', 'as',
]);

/** How many words after a leading number to scan for a qualifying plural noun. */
const LISTICLE_LOOKAHEAD = 3;
/** How many leading words of the title count as "near the start". */
const LISTICLE_LEADING_WINDOW = 6;

/**
 * Detects a "leading listicle count" — a number near the start of the title
 * followed within a couple words by what looks like a plural noun, e.g.
 * "These 17 Phoenix restaurants...", "Top 10 places to...", "8 events this
 * weekend". Deliberately narrow and shape-based, not a vocabulary list: it
 * only requires a generic "ends in s, length >= 4" word within a small
 * lookahead window, so an incidental count describing an incident — "3
 * injured in a fire" — does NOT match, since "injured" isn't a plural noun
 * of a listed item and nothing in the lookahead window qualifies.
 */
function extractLeadingListicleCount(title: string): number | null {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < Math.min(words.length, LISTICLE_LEADING_WINDOW); i++) {
    const w = words[i]!;
    if (!/^\d+$/.test(w)) continue;

    for (let j = i + 1; j <= Math.min(i + LISTICLE_LOOKAHEAD, words.length - 1); j++) {
      const candidate = words[j]!;
      if (candidate.length >= 4 && candidate.endsWith('s') && !NON_PLURAL_S_WORDS.has(candidate)) {
        return parseInt(w, 10);
      }
    }
  }
  return null;
}

/**
 * True (with both counts) if both titles have a leading listicle count and
 * the numbers differ — same short-circuit mechanism as
 * hasConflictingDateTokens, deliberately narrower: it only blocks when the
 * number is the thing being counted in a list, not an incidental count
 * elsewhere in a story (e.g. differing casualty counts in early vs. updated
 * coverage of the same breaking event should still merge).
 */
function hasConflictingListicleCounts(
  titleA: string,
  titleB: string
): { conflict: boolean; countA: number | null; countB: number | null } {
  const countA = extractLeadingListicleCount(titleA);
  const countB = extractLeadingListicleCount(titleB);
  if (countA == null || countB == null) return { conflict: false, countA, countB };
  return { conflict: countA !== countB, countA, countB };
}

/**
 * Arizona city/place names for the location-conflict dedupe short-circuit.
 * Mirrors (copied, not imported — it's private there) agents/serpApiEventsSync.ts's
 * TARGET_CITIES list, extended with Bisbee and Maricopa (needed to catch the
 * confirmed false merge: three distinct Trulieve dispensary openings in
 * Bisbee/Maricopa/Sierra Vista collapsing into one).
 */
const AZ_PLACE_NAMES = [
  'Phoenix', 'Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Glendale', 'Peoria', 'Surprise',
  'Flagstaff', 'Sedona', 'Prescott', 'Kingman', 'Tucson', 'Sierra Vista', 'Yuma', 'Lake Havasu City',
  'Show Low', 'Safford', 'Bisbee', 'Maricopa',
] as const;

const AZ_PLACE_NAME_RE = new RegExp(
  '\\b(' +
    [...AZ_PLACE_NAMES]
      .sort((a, b) => b.length - a.length)
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') +
    ')\\b',
  'gi'
);

function extractAzPlaceNames(title: string): string[] {
  const matches = title.match(AZ_PLACE_NAME_RE) || [];
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

/**
 * True (with both place lists) if both titles mention at least one AZ place
 * name and none match — same short-circuit mechanism as the date and
 * listicle-count checks. E.g. "...Dispensary in Bisbee, Arizona" vs
 * "...Dispensary in Maricopa, Arizona" share every other word but are
 * different store openings in different cities and must never merge.
 */
function hasConflictingPlaceNames(
  titleA: string,
  titleB: string
): { conflict: boolean; placesA: string[]; placesB: string[] } {
  const placesA = extractAzPlaceNames(titleA);
  const placesB = extractAzPlaceNames(titleB);
  if (placesA.length === 0 || placesB.length === 0) return { conflict: false, placesA, placesB };
  const setB = new Set(placesB);
  return { conflict: !placesA.some((p) => setB.has(p)), placesA, placesB };
}

export type NearDuplicateMerge = {
  droppedTitle: string;
  droppedLink: string;
  keptTitle: string;
  keptLink: string;
  similarity: number;
};

/** Preference order when picking the cluster representative: has a snippet > most recent publish time > stable original order. */
function isMoreCompleteRepresentative(candidate: RawNewsItem, current: RawNewsItem): boolean {
  const candHasSnippet = Boolean(candidate.snippet && candidate.snippet.trim());
  const currHasSnippet = Boolean(current.snippet && current.snippet.trim());
  if (candHasSnippet !== currHasSnippet) return candHasSnippet;

  const candTime = candidate.publishedDate?.getTime();
  const currTime = current.publishedDate?.getTime();
  if (candTime != null && currTime != null && candTime !== currTime) return candTime > currTime;
  if (candTime != null && currTime == null) return true;
  if (candTime == null && currTime != null) return false;

  return false;
}

/**
 * Pairwise Jaccard similarity over normalized titles + union-find clustering
 * (so transitively-linked near-dupes — A~B, B~C — merge into one cluster even
 * if A and C alone fall under the threshold). Keeps the most complete member
 * per cluster, logs the rest as "merged as duplicate of X".
 */
function nearDedupeStage0Pool(
  items: RawNewsItem[]
): { deduped: RawNewsItem[]; merges: NearDuplicateMerge[] } {
  const n = items.length;
  if (n <= 1) return { deduped: items, merges: [] };

  const tokenSets = items.map((it) => normalizeTitleTokens(it.title));

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccardSimilarity(tokenSets[i]!, tokenSets[j]!);
      if (sim < NEAR_DUP_JACCARD_THRESHOLD) continue;

      if (hasConflictingDateTokens(items[i]!.title, items[j]!.title)) {
        console.log(
          `[topic-discovery] NOT merged (conflicting date tokens override sim=${sim.toFixed(2)}): "${items[i]!.title.slice(0, 80)}" vs "${items[j]!.title.slice(0, 80)}"`
        );
        continue;
      }

      const listicle = hasConflictingListicleCounts(items[i]!.title, items[j]!.title);
      if (listicle.conflict) {
        console.log(
          `[topic-discovery] NOT merged: conflicting listicle counts (${listicle.countA} vs ${listicle.countB}) overrides sim=${sim.toFixed(2)}: "${items[i]!.title.slice(0, 80)}" vs "${items[j]!.title.slice(0, 80)}"`
        );
        continue;
      }

      const place = hasConflictingPlaceNames(items[i]!.title, items[j]!.title);
      if (place.conflict) {
        console.log(
          `[topic-discovery] NOT merged: conflicting AZ place names (${place.placesA.join('/')} vs ${place.placesB.join('/')}) overrides sim=${sim.toFixed(2)}: "${items[i]!.title.slice(0, 80)}" vs "${items[j]!.title.slice(0, 80)}"`
        );
        continue;
      }

      union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = clusters.get(root);
    if (list) list.push(i);
    else clusters.set(root, [i]);
  }

  const deduped: RawNewsItem[] = [];
  const merges: NearDuplicateMerge[] = [];

  for (const members of clusters.values()) {
    if (members.length === 1) {
      deduped.push(items[members[0]!]!);
      continue;
    }
    let winnerIdx = members[0]!;
    for (const idx of members.slice(1)) {
      if (isMoreCompleteRepresentative(items[idx]!, items[winnerIdx]!)) {
        winnerIdx = idx;
      }
    }
    const winner = items[winnerIdx]!;
    deduped.push(winner);
    for (const idx of members) {
      if (idx === winnerIdx) continue;
      const dropped = items[idx]!;
      const similarity = jaccardSimilarity(tokenSets[idx]!, tokenSets[winnerIdx]!);
      merges.push({
        droppedTitle: dropped.title,
        droppedLink: dropped.link,
        keptTitle: winner.title,
        keptLink: winner.link,
        similarity,
      });
      console.log(
        `[topic-discovery] MERGED as duplicate of "${winner.title.slice(0, 80)}" (similarity=${similarity.toFixed(2)}): "${dropped.title.slice(0, 80)}"`
      );
    }
  }

  return { deduped, merges };
}

/** Keep newest `max` items by `publishedDate`; undated items sort last. Mirrors capSlotPoolByRecency in newsApiSync.ts. */
function capStage0PoolByRecency(items: RawNewsItem[], max: number): RawNewsItem[] {
  if (items.length <= max) return items;
  const tagged = items.map((it, idx) => ({ it, idx }));
  tagged.sort((a, b) => {
    const ta = a.it.publishedDate?.getTime();
    const tb = b.it.publishedDate?.getTime();
    if (ta != null && tb != null && tb !== ta) return tb - ta;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    return a.idx - b.idx;
  });
  return tagged.slice(0, max).map((x) => x.it);
}

async function runStage0Discovery(): Promise<{
  pool: RawNewsItem[];
  rawCount: number;
  exactDedupedCount: number;
  nearDedupedCount: number;
  nearDuplicateMerges: NearDuplicateMerge[];
  reservedCannabisItems: RawNewsItem[];
  usage: Stage0Usage;
}> {
  const usage: Stage0Usage = { apiCalls: 0, errors: 0, errorSample: [] };
  const all: RawNewsItem[] = [];

  for (const q of STAGE0_QUERIES) {
    try {
      const items = await fetchSerpNewsForQuery(q, usage);
      all.push(...items);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      usage.errors++;
      if (usage.errorSample.length < STAGE0_ERROR_SAMPLE_MAX) {
        usage.errorSample.push(`"${q.query}": ${msg}`);
      }
      console.warn(`[topic-discovery] Stage 0 query "${q.query}" errored:`, msg);
    }
  }

  const exactDeduped = dedupeStage0Pool(all);
  const { deduped: nearDeduped, merges: nearDuplicateMerges } = nearDedupeStage0Pool(exactDeduped);

  // Reserved cannabis-az quota: filled by recency WITHIN cannabis-az only
  // (no other pre-Stage-1 quality signal exists yet), so it doesn't have to
  // win a combined-recency race against same-day breaking local/national news.
  const cannabisCandidates = nearDeduped.filter((it) => it.queryClass === 'cannabis-az');
  const reservedCannabisItems = capStage0PoolByRecency(cannabisCandidates, CANNABIS_RESERVED_SLOTS);
  console.log(
    `[topic-discovery] Cannabis reserved quota: ${reservedCannabisItems.length}/${CANNABIS_RESERVED_SLOTS} slot(s) filled from ${cannabisCandidates.length} cannabis-az candidate(s) (recency within class).`
  );
  reservedCannabisItems.forEach((it, idx) => {
    console.log(`[topic-discovery]   reserved-cannabis-slot #${idx + 1}: "${it.title.slice(0, 90)}"`);
  });

  // Remaining slots (16, or more if cannabis-az didn't fill all 4 — backfill,
  // not left empty) fill from the combined pool of all three classes by
  // recency, same as before. Reserved items are excluded from re-selection
  // here so they aren't double-counted, but non-reserved cannabis-az items
  // remain eligible to also win a general slot on merit.
  const reservedLinks = new Set(reservedCannabisItems.map((it) => it.link));
  const remainingSlots = STAGE1_CANDIDATE_CAP - reservedCannabisItems.length;
  const remainingPool = nearDeduped.filter((it) => !reservedLinks.has(it.link));
  const generalCapped = capStage0PoolByRecency(remainingPool, remainingSlots);
  console.log(
    `[topic-discovery] General pool: ${generalCapped.length}/${remainingSlots} slot(s) filled by combined recency across all 3 classes.`
  );

  const capped = [...reservedCannabisItems, ...generalCapped];

  console.log(
    `[topic-discovery] Stage 0 done: ${STAGE0_QUERIES.length} queries, ${usage.apiCalls} SerpAPI calls, ${usage.errors} SerpAPI errors, ` +
      `${all.length} raw → ${exactDeduped.length} exact-deduped → ${nearDeduped.length} near-deduped (${nearDuplicateMerges.length} merged) → ${capped.length} capped (max ${STAGE1_CANDIDATE_CAP}, reserved-cannabis=${reservedCannabisItems.length}, general=${generalCapped.length})`
  );
  if (usage.errors > 0 && usage.errors === STAGE0_QUERIES.length) {
    console.warn(
      `[topic-discovery] STAGE 0 WARNING: every SerpAPI query errored this run (${usage.errors}/${STAGE0_QUERIES.length}) — likely an engine/account-level issue, not query-specific. Sample: ${usage.errorSample.join(' | ')}`
    );
  }

  return {
    pool: capped,
    rawCount: all.length,
    exactDedupedCount: exactDeduped.length,
    nearDedupedCount: nearDeduped.length,
    nearDuplicateMerges,
    reservedCannabisItems,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — Locality & Relevance Verdict (+ Stage 2 section, same call)
// ---------------------------------------------------------------------------
//
// Stage 2 (section routing) is folded into the same Gemini call as Stage 1
// rather than issued as a second call per candidate. The build spec asks
// for "ONE call" per topic for Stage 1 and scopes the usage governor to
// that one-call-per-topic budget; a separate Stage-2 call per topic would
// double real API cost against the exact bound the governor exists to
// enforce. Section is still assigned "from topic content + the Stage 1
// search summaries, not from which query found it" — the model sees only
// the story content and its own search evidence, never queryClass.

const SECTION_VALUES = ['food', 'nightlife', 'cannabis', 'health-wellness', 'sports', 'news'] as const;
export type SectionSlug = (typeof SECTION_VALUES)[number];

export type Stage1Verdict =
  | 'direct-local'
  | 'national-reframe'
  | 'national-verify-local'
  | 'national-skip';

export type SearchSummary = { title: string; url: string; summary: string };

type Stage1VerdictResult = {
  verdict: Stage1Verdict;
  section: SectionSlug;
  relevanceScore: number;
  subjectTag: string;
  skipReason?: string;
  excludeAsCrimeTragedy: boolean;
  crimeTragedyReason?: string;
  sources: SearchSummary[];
};

/** Ported from src/agents/researchAgent.ts (private there); generic URL cleanup, no Dig & Write coupling. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    u.pathname = path;
    return u.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Ported + adapted from researchAgent.ts's normalizeSourceRow — same validation shape, no relevanceScore field (not needed per-source here). */
function normalizeSearchSummaryRow(raw: unknown): SearchSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!title || !url || !summary) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { title, url, summary };
}

/** Ported + adapted from researchAgent.ts's mergeSourcesByUrl — dedupe by normalized URL, keep first (no per-source score to break ties on here). */
function mergeSearchSummariesByUrl(rows: SearchSummary[]): SearchSummary[] {
  const map = new Map<string, SearchSummary>();
  for (const s of rows) {
    const key = normalizeUrl(s.url);
    if (!map.has(key)) map.set(key, { ...s, url: key });
  }
  return [...map.values()];
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/**
 * Gemini 3.7 Flash generateContent call with the googleSearch grounding
 * tool — same request shape confirmed live in
 * scripts/probe-gemini-grounding.ts (single combined prompt in
 * contents[0].parts[0].text, tools: [{ googleSearch: {} }], no
 * generationConfig.responseSchema/responseMimeType — freeform JSON via
 * prompt instruction, same approach the OpenAI version used). Auth is a
 * `key` query param (Gemini's own auth style), not a Bearer header.
 */
async function geminiGenerateContentCall(promptText: string, timeoutMs = 180_000): Promise<unknown> {
  const key = config.gemini.apiKey;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set (required for topicDiscovery Stage 1)');
  }

  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    tools: [{ googleSearch: {} }],
  };

  const res = await axios.post(GEMINI_GENERATE_CONTENT_URL, body, {
    params: { key },
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const data = res.data;
    const msg =
      typeof data === 'object' && data && 'error' in (data as object)
        ? JSON.stringify((data as { error?: unknown }).error)
        : res.statusText || String(res.status);
    throw new Error(`Gemini generateContent HTTP ${res.status}: ${msg}`);
  }
  return res.data;
}

/** Extracts the concatenated text of the first candidate — same envelope shape confirmed in scripts/probe-gemini-grounding.ts. */
function extractGeminiText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = d.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string')
    .join('')
    .trim();
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const end = cleaned.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Single Gemini 3.7 Flash generateContent call with the googleSearch
 * grounding tool — asks for a locality verdict + section + 2-3 evidence
 * summaries. No full-page fetch, no Playwright — that belongs to a
 * future Stage 3 (article-body sourcing).
 */
async function runStage1VerdictForCandidate(item: RawNewsItem): Promise<Stage1VerdictResult> {
  const instructions = `You output only valid JSON, no markdown fences, no commentary.`;

  const user = `You are a locality/relevance classifier for HappyTimesAZ, a Phoenix AZ metro lifestyle & news site.

CANDIDATE STORY
Title: ${item.title}
Snippet: ${item.snippet || '(none)'}
Source outlet: ${item.sourceOutlet || 'unknown'}
Link: ${item.link}

TASK
1. Use search to find 2-3 relevant, credible sources about this story. Prefer sources with concrete local Arizona/Phoenix-metro detail if the story could plausibly have one — dates, venues, addresses, named local businesses, official local statements.
2. Classify this story into exactly one of:
   - "direct-local": the story is inherently, primarily about the greater Phoenix/Arizona metro area (a local event, local business, local government action, local sports team, local person). No uncertainty about whether it's local — it just is.
   - "national-reframe": the story is fundamentally national/global and does NOT occur locally, but there's a genuine, already-known "here's the Arizona angle or alternative" story to tell. Example: a meteor shower peaks tonight but forecasts show it won't be visible from Arizona due to clouds — the AZ story is "here's what you can see instead" or "here's when it's visible here next." The local angle is known and confirmed, just not the primary event itself.
   - "national-verify-local": the story is national/global AND local relevance itself is the open question — whether it's visible, applicable, or occurring in Arizona is NOT yet known from the headline/snippet alone and needs a follow-up check before you could call it direct-local or national-skip. Example: "Can you see the eclipse from Arizona?" (visibility unconfirmed), "does this federal cannabis rule change apply to Arizona dispensaries?" (applicability unconfirmed), "does this retail chain have Valley locations?" (occurrence unconfirmed). This is NOT a subtype of direct-local or national-reframe — it's a distinct editorial motion: the answer to "is this even a local story" hasn't been established yet, so it's flagged for a dedicated fact-check pass rather than decided now.
   - "national-skip": the story is national/global with no meaningful, addable local hook for Phoenix-metro readers, and nothing about local relevance is even in question — it's just not a local angle at all (e.g. a purely out-of-state incident, national politics with no Arizona tie).
3. If direct-local, national-reframe, or national-verify-local, assign the single best section for this site based on what the story is actually about (not on how it was found): one of food, nightlife, cannabis, health-wellness, sports, news.
4. Score overall relevance/value to a Phoenix-metro local lifestyle audience, 1-10.
5. Assign a short, freeform subjectTag describing what this story is actually about at a glance (e.g. "weather", "sports", "food", "crime", "culture", "policy", "cannabis-law", "astronomy") — your own words, not a fixed list, but keep it to 1-3 words.
6. Separately from the locality verdict, judge whether this story is crime, an accident, a death, or a tragedy — set excludeAsCrimeTragedy to true if so, with a short excludeReason. This applies no matter what verdict you gave above: a direct-local, national-reframe, or national-verify-local story can still be crime/tragedy content and must still be flagged. Judge the CONTENT and what actually happened, not whether specific trigger words like "fatal," "dead," "killed," or "shooting" literally appear in the title — a headline can describe a fatal incident without using any of those words and must still be flagged. For example, all three of these should be flagged true even though none contains an obvious trigger word:
   - "Man killed in Payson plane crash remembered as 'loving, caring' person" (a fatal accident, described through a tribute framing)
   - "Barricaded suspect in Glendale standoff dead, shelter in place lifted" (a fatal police incident)
   - "Boy dies after jumping off London Bridge in Arizona" (a child's death)
   Ordinary local news that merely mentions public safety in passing (e.g. a road-closure or weather-safety story) is NOT crime/tragedy — only flag stories where the substance of the story IS a crime, accident, death, or tragedy.

Return ONLY this JSON shape, no markdown fences, no prose before or after:
{"verdict":"direct-local"|"national-reframe"|"national-verify-local"|"national-skip","skipReason":"<short reason, only when verdict is national-skip>","section":"food"|"nightlife"|"cannabis"|"health-wellness"|"sports"|"news"|null,"relevanceScore":<1-10 integer>,"subjectTag":"<short freeform label, 1-3 words>","excludeAsCrimeTragedy":<true|false>,"excludeReason":"<short reason, only when excludeAsCrimeTragedy is true>","sources":[{"title":"string","url":"string starting with http","summary":"1-2 sentence summary of what this source adds as evidence for the classification"}]}`;

  const raw = await geminiGenerateContentCall(`${instructions}\n\n${user}`);

  const text = extractGeminiText(raw);
  const obj = tryParseJsonObject(text);
  if (!obj) throw new Error('Stage 1: model did not return parseable JSON');

  const verdict = obj.verdict;
  if (
    verdict !== 'direct-local' &&
    verdict !== 'national-reframe' &&
    verdict !== 'national-verify-local' &&
    verdict !== 'national-skip'
  ) {
    throw new Error(`Stage 1: invalid or missing verdict "${String(verdict)}"`);
  }

  const relevanceScore = clampScore(
    typeof obj.relevanceScore === 'number' ? obj.relevanceScore : parseInt(String(obj.relevanceScore ?? ''), 10)
  );

  const sectionRaw = typeof obj.section === 'string' ? obj.section.toLowerCase().trim() : '';
  const section: SectionSlug = (SECTION_VALUES as readonly string[]).includes(sectionRaw)
    ? (sectionRaw as SectionSlug)
    : 'news';

  const subjectTagRaw = typeof obj.subjectTag === 'string' ? obj.subjectTag.trim().replace(/\s+/g, ' ') : '';
  const subjectTag = subjectTagRaw ? subjectTagRaw.slice(0, 40) : 'uncategorized';

  const skipReason = typeof obj.skipReason === 'string' && obj.skipReason.trim() ? obj.skipReason.trim() : undefined;

  const excludeAsCrimeTragedy = obj.excludeAsCrimeTragedy === true;
  const crimeTragedyReason =
    typeof obj.excludeReason === 'string' && obj.excludeReason.trim() ? obj.excludeReason.trim() : undefined;

  const rawSources = Array.isArray(obj.sources) ? obj.sources : [];
  const sources = mergeSearchSummariesByUrl(
    rawSources
      .map((r) => normalizeSearchSummaryRow(r))
      .filter((s): s is SearchSummary => s !== null)
  ).slice(0, 3);

  return {
    verdict,
    section,
    relevanceScore,
    subjectTag,
    skipReason,
    excludeAsCrimeTragedy,
    crimeTragedyReason,
    sources,
  };
}

export type TopicDiscoveryResult = {
  title: string;
  snippet: string;
  link: string;
  sourceOutlet: string | null;
  publishedDate: string | null;
  verdict: Stage1Verdict;
  section: SectionSlug;
  relevanceScore: number;
  subjectTag: string;
  searchSummaries: SearchSummary[];
};

export type SkippedTopic = { title: string; link: string; reason: string };

/**
 * Cheap keyword pre-filter only — independently defined here, mirrors the
 * pattern/intent of NEGATIVE_HEADLINE_RE in agents/newsApiSync.ts (read there,
 * not imported or modified: "Fast reject before AI — crime, tragedy, serious
 * accidents, national partisan frame (headline-level)"). Applied BEFORE Stage 1's
 * Gemini generateContent call purely to save a call on the most obvious keyword
 * matches (explicit "murder", "shooting", etc.) — it is NOT the authority on
 * crime/tragedy exclusion. It mirrors the existing pattern's exact keyword set,
 * so it will not catch every crime/tragedy headline on its own (e.g. a death
 * reported without one of these specific words passes this cheap filter). The
 * actual authority is the excludeAsCrimeTragedy judgment the Stage 1 model makes
 * on every topic that reaches it, which judges content regardless of wording —
 * see runStage1VerdictForCandidate.
 */
const NEGATIVE_HEADLINE_RE =
  /murder|homicide|mass\s*shooting|killed in (a )?shooting|fatal (crash|collision|accident)|deadly (crash|collision|wreck)|terror(ist|ism)?|suicide|sexual assault|kidnap|rape\b|school\s*shooting|armed robbery|stabbed|shot dead|police\s+shooting|charged with|sentenced to|arrested for|domestic violence|child abuse|overdose death|capitol\s*riot|january\s*6|impeachment|white\s*house|mar[- ]a[- ]lago|\bGOP\b|\bDNC\b|presidential\s*campaign|midterm\s*election|election\s*fraud|stop\s*the\s*steal|congressional\s*hearing|supreme\s*court\s*(rules?|decides)/i;

function passesEditorialAppropriatenessGate(item: RawNewsItem): boolean {
  const blob = `${item.title}\n${item.snippet || ''}`;
  return !NEGATIVE_HEADLINE_RE.test(blob);
}

/** Usage/concurrency governor for Stage 1 — mirrors newsApiSync.ts's SerpRunUsage pattern. */
export type Stage1Usage = {
  apiCalls: number;
  /** Dropped by the cheap NEGATIVE_HEADLINE_RE keyword pre-filter, before any Gemini call. */
  editorialGateDropped: number;
  proceededToStage1: number;
  /** Dropped by the Stage 1 model's excludeAsCrimeTragedy judgment (the actual authority), independent of locality verdict. */
  crimeTragedyDropped: number;
  hardStopped: boolean;
  hardStopReason?: string;
  hardStopAtCount?: number;
};

/**
 * Runs Stage 1 (+ Stage 2) for the capped candidate pool in batches of
 * STAGE1_BATCH_SIZE, never issuing more than STAGE1_CANDIDATE_CAP Gemini
 * calls total for the run. If the pool somehow exceeds the cap, remaining
 * candidates are marked skipped (not silently dropped) and the run
 * continues with whatever completed — it does not fail the whole run.
 *
 * Before any candidate reaches the Gemini call, it must pass
 * passesEditorialAppropriatenessGate; failures are logged and skipped here
 * without spending an API call or counting against usage.apiCalls.
 */
async function runStage1Batched(
  candidates: RawNewsItem[]
): Promise<{ kept: TopicDiscoveryResult[]; skipped: SkippedTopic[]; usage: Stage1Usage }> {
  const usage: Stage1Usage = {
    apiCalls: 0,
    editorialGateDropped: 0,
    proceededToStage1: 0,
    crimeTragedyDropped: 0,
    hardStopped: false,
  };
  const kept: TopicDiscoveryResult[] = [];
  const skipped: SkippedTopic[] = [];

  const eligible: RawNewsItem[] = [];
  for (const c of candidates) {
    if (!passesEditorialAppropriatenessGate(c)) {
      usage.editorialGateDropped += 1;
      skipped.push({
        title: c.title,
        link: c.link,
        reason: 'editorial-gate: crime/tragedy/national-partisan headline pattern (pre-Stage-1, no API call spent)',
      });
      console.log(`[topic-discovery] SKIP (editorial-gate): "${c.title.slice(0, 90)}"`);
      continue;
    }
    eligible.push(c);
  }
  usage.proceededToStage1 = eligible.length;
  console.log(
    `[topic-discovery] Editorial gate: ${usage.editorialGateDropped} dropped, ${usage.proceededToStage1} proceeded to Stage 1 (of ${candidates.length} candidates).`
  );

  const candidatesForStage1 = eligible;

  let idx = 0;
  while (idx < candidatesForStage1.length) {
    if (usage.apiCalls >= STAGE1_CANDIDATE_CAP) {
      usage.hardStopped = true;
      usage.hardStopAtCount = usage.apiCalls;
      usage.hardStopReason = `STAGE1_CANDIDATE_CAP (${STAGE1_CANDIDATE_CAP}) reached; ${candidatesForStage1.length - idx} candidate(s) not processed.`;
      console.warn(`[topic-discovery] STAGE 1 HARD STOP: ${usage.hardStopReason}`);
      for (const remaining of candidatesForStage1.slice(idx)) {
        skipped.push({
          title: remaining.title,
          link: remaining.link,
          reason: 'not-processed: STAGE1_CANDIDATE_CAP hard stop',
        });
      }
      break;
    }

    const roomLeft = STAGE1_CANDIDATE_CAP - usage.apiCalls;
    const batchSize = Math.min(STAGE1_BATCH_SIZE, roomLeft, candidatesForStage1.length - idx);
    const batch = candidatesForStage1.slice(idx, idx + batchSize);
    idx += batchSize;

    console.log(
      `[topic-discovery] Stage 1: dispatching batch of ${batch.length} (apiCalls so far: ${usage.apiCalls}/${STAGE1_CANDIDATE_CAP})`
    );

    const settled = await Promise.all(
      batch.map(async (item) => {
        usage.apiCalls += 1;
        try {
          const verdictResult = await runStage1VerdictForCandidate(item);
          return { item, verdictResult, error: null as string | null };
        } catch (e) {
          return {
            item,
            verdictResult: null as Stage1VerdictResult | null,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      })
    );

    for (const r of settled) {
      if (r.error || !r.verdictResult) {
        console.warn(`[topic-discovery] Stage 1 error for "${r.item.title.slice(0, 80)}": ${r.error}`);
        skipped.push({
          title: r.item.title,
          link: r.item.link,
          reason: `stage1-error: ${r.error ?? 'unknown'}`,
        });
        continue;
      }

      const v = r.verdictResult;

      // Crime/tragedy exclusion is checked before, and independent of, the
      // locality verdict — a direct-local, national-reframe, or
      // national-verify-local topic can still be crime/tragedy content and
      // must be excluded the same way a national-skip topic is.
      if (v.excludeAsCrimeTragedy) {
        usage.crimeTragedyDropped += 1;
        skipped.push({
          title: r.item.title,
          link: r.item.link,
          reason: `crime-tragedy: ${v.crimeTragedyReason || '(no reason given)'}`,
        });
        console.log(
          `[topic-discovery] SKIP (crime-tragedy, verdict was ${v.verdict}): "${r.item.title.slice(0, 90)}" — ${v.crimeTragedyReason || '(no reason given)'}`
        );
        continue;
      }

      if (v.verdict === 'national-skip') {
        skipped.push({
          title: r.item.title,
          link: r.item.link,
          reason: v.skipReason || '(no reason given)',
        });
        console.log(
          `[topic-discovery] SKIP (national-skip): "${r.item.title.slice(0, 90)}" — ${v.skipReason || '(no reason given)'}`
        );
        continue;
      }

      kept.push({
        title: r.item.title,
        snippet: r.item.snippet ?? '',
        link: r.item.link,
        sourceOutlet: r.item.sourceOutlet ?? null,
        publishedDate: r.item.publishedDate ? r.item.publishedDate.toISOString() : null,
        verdict: v.verdict,
        section: v.section,
        relevanceScore: v.relevanceScore,
        subjectTag: v.subjectTag,
        searchSummaries: v.sources,
      });
      console.log(
        `[topic-discovery] KEEP (${v.verdict}, section=${v.section}, tag=${v.subjectTag}, score=${v.relevanceScore}): "${r.item.title.slice(0, 90)}"`
      );
    }
  }

  return { kept, skipped, usage };
}

// ---------------------------------------------------------------------------
// Shadow-mode comparison against today's live 5-slot pipeline output
// ---------------------------------------------------------------------------

const ASTRO_STORY_RE = /meteor|eclipse|comet|aurora|stargaz|planet(?:ary)?\s+align|solar\s+flare|supermoon|\blunar\b/i;

type SanityGoogleNewsPostRow = {
  title?: string;
  section?: string;
  originalSourceUrl?: string;
  publishedAt?: string;
};

/** Read-only query against Sanity for comparison purposes only. Never writes/patches/creates. */
async function fetchTodaysGoogleNewsPostsFromSanity(): Promise<SanityGoogleNewsPostRow[]> {
  try {
    const client = getSanityClient();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const rows = await client.fetch<SanityGoogleNewsPostRow[]>(
      `*[_type == "post" && contentSource == "google_news" && publishedAt >= $start]{ title, section, originalSourceUrl, publishedAt } | order(publishedAt desc)`,
      { start: startOfDay.toISOString() }
    );
    return rows || [];
  } catch (e) {
    console.warn(
      '[topic-discovery] Comparison: failed to read today\'s google_news posts from Sanity (read-only):',
      e instanceof Error ? e.message : e
    );
    return [];
  }
}

export type ComparisonResult = {
  todaysExistingGoogleNewsPosts: SanityGoogleNewsPostRow[];
  missedByOldSlots: {
    title: string;
    link: string;
    queryClass: QueryClass;
    verdict: Stage1Verdict;
    section: SectionSlug;
    relevanceScore: number;
  }[];
  astronomyStyleTest: { hit: boolean; examples: { title: string; link: string }[] };
  sectionMismatchesVsRigidSlot1: {
    title: string;
    link: string;
    assignedSection: SectionSlug;
    oldRigidSlot1SectionWouldHaveBeen: 'news';
  }[];
  cannabis: { survivingCount: number; note: string };
};

async function compareAgainstTodaysSlotOutput(
  pool: RawNewsItem[],
  kept: TopicDiscoveryResult[]
): Promise<ComparisonResult> {
  const poolByLink = new Map(pool.map((it) => [it.link, it]));

  // (a) Stories only findable via the national-with-potential-local-angle class —
  // none of the 5 old slots' fixed query lists target this territory at all, so
  // anything kept from this class is structurally invisible to the old pipeline.
  const missedByOldSlots = kept
    .map((k) => ({ k, raw: poolByLink.get(k.link) }))
    .filter((x): x is { k: TopicDiscoveryResult; raw: RawNewsItem } =>
      x.raw !== undefined && x.raw.queryClass === 'national-with-potential-local-angle'
    )
    .map(({ k, raw }) => ({
      title: k.title,
      link: k.link,
      queryClass: raw.queryClass,
      verdict: k.verdict,
      section: k.section,
      relevanceScore: k.relevanceScore,
    }));

  const astronomyHits = kept.filter(
    (k) => ASTRO_STORY_RE.test(k.title) || ASTRO_STORY_RE.test(k.snippet)
  );

  // (b) Under the old pipeline, anything found via slot-1-style generic local
  // queries always gets section="news" (resolveGoogleNewsPrimaryCategorySlug,
  // slot-1-local case), regardless of actual content. Flag kept topics found via
  // the local-native class whose real content-based section isn't "news".
  const sectionMismatchesVsRigidSlot1 = kept
    .map((k) => ({ k, raw: poolByLink.get(k.link) }))
    .filter((x): x is { k: TopicDiscoveryResult; raw: RawNewsItem } =>
      x.raw !== undefined && x.raw.queryClass === 'local-native' && x.k.section !== 'news'
    )
    .map(({ k }) => ({
      title: k.title,
      link: k.link,
      assignedSection: k.section,
      oldRigidSlot1SectionWouldHaveBeen: 'news' as const,
    }));

  // (c) Old slot-4 (AZ cannabis) went from 270 pooled results to zero published
  // with no diagnosable log trail. This module now has a dedicated cannabis-az
  // Stage 0 query class plus a CANNABIS_RESERVED_SLOTS reserved sub-quota of
  // the capped pool, specifically so cannabis-az doesn't have to win a pure
  // combined-recency race against same-day breaking local/national news (it
  // was confirmed to lose that race entirely despite healthy raw volume).
  // Report both the final kept count and how many cannabis-az candidates made
  // it into the capped pool at all — every cannabis-az topic's Stage 1
  // verdict/skip reason is visible in the run's KEEP/SKIP log lines, so a
  // zero here (if it happens) is diagnosable, unlike old slot-4's collapse.
  const cannabisCount = kept.filter((k) => k.section === 'cannabis').length;
  const cannabisInCappedPool = pool.filter((it) => it.queryClass === 'cannabis-az').length;

  const todaysExistingGoogleNewsPosts = await fetchTodaysGoogleNewsPostsFromSanity();

  return {
    todaysExistingGoogleNewsPosts,
    missedByOldSlots,
    astronomyStyleTest: {
      hit: astronomyHits.length > 0,
      examples: astronomyHits.map((k) => ({ title: k.title, link: k.link })),
    },
    sectionMismatchesVsRigidSlot1,
    cannabis: {
      survivingCount: cannabisCount,
      note:
        cannabisCount > 0
          ? `${cannabisCount} kept topic(s) landed in section=cannabis. ${cannabisInCappedPool} cannabis-az candidate(s) reached the capped pool this run, via the dedicated cannabis-az query lane + ${CANNABIS_RESERVED_SLOTS}-slot reserved quota.`
          : `No cannabis-section topics survived to kept this run. ${cannabisInCappedPool} cannabis-az candidate(s) reached the capped pool (dedicated query lane + ${CANNABIS_RESERVED_SLOTS}-slot reserved quota are both in place as of this build) — check each cannabis-az topic's Stage 1 verdict/skip reason in this run's log to see exactly why, rather than treating this as an unexplained collapse like old slot-4's.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Shadow-mode run
// ---------------------------------------------------------------------------

export type Stage0DedupeCounts = {
  rawCount: number;
  exactDedupedCount: number;
  nearDedupedCount: number;
  cappedCount: number;
};

export type ShadowRunResult = {
  kept: TopicDiscoveryResult[];
  skipped: SkippedTopic[];
  nearDuplicateMerges: NearDuplicateMerge[];
  dedupeCounts: Stage0DedupeCounts;
  reservedCannabisItems: RawNewsItem[];
  stage0Usage: Stage0Usage;
  stage1Usage: Stage1Usage;
  wallClockMs: number;
  comparison: ComparisonResult;
  outPath: string;
};

function writeShadowLog(payload: unknown): string {
  mkdirSync(SHADOW_OUTPUT_DIR, { recursive: true });
  const filename = `topic-discovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outPath = join(SHADOW_OUTPUT_DIR, filename);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

/**
 * Runs Stage 0 → Stage 1/2 against live SerpAPI + Gemini, logs the full
 * result to a file outside the repo, and returns it. Never publishes to
 * Sanity, never calls syncNewsApiToSanity, never touches the existing
 * 5-slot pipeline.
 */
export async function runTopicDiscoveryShadow(): Promise<ShadowRunResult> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set (required for Stage 1 — topicDiscovery.ts now uses Gemini, not OpenAI)');
  }

  const startedAt = Date.now();
  console.log('[topic-discovery] ========== SHADOW MODE run start ==========');

  const {
    pool,
    rawCount,
    exactDedupedCount,
    nearDedupedCount,
    nearDuplicateMerges,
    reservedCannabisItems,
    usage: stage0Usage,
  } = await runStage0Discovery();
  const { kept, skipped, usage: stage1Usage } = await runStage1Batched(pool);

  const wallClockMs = Date.now() - startedAt;

  const dedupeCounts: Stage0DedupeCounts = {
    rawCount,
    exactDedupedCount,
    nearDedupedCount,
    cappedCount: pool.length,
  };

  console.log(
    `[topic-discovery] Dedupe pipeline: raw=${dedupeCounts.rawCount} → exact-dedupe=${dedupeCounts.exactDedupedCount} → near-dedupe=${dedupeCounts.nearDedupedCount} (${nearDuplicateMerges.length} merged) → capped=${dedupeCounts.cappedCount}`
  );
  console.log(
    `[topic-discovery] Cannabis reserved quota filled: ${reservedCannabisItems.length}/${CANNABIS_RESERVED_SLOTS} — ${reservedCannabisItems.map((it) => `"${it.title.slice(0, 60)}"`).join(', ') || '(none)'}`
  );
  console.log(
    `[topic-discovery] Editorial gate (keyword pre-filter): ${stage1Usage.editorialGateDropped} dropped before Stage 1, ${stage1Usage.proceededToStage1} proceeded to Stage 1 (of ${pool.length} capped candidates).`
  );
  console.log(
    `[topic-discovery] Crime/tragedy exclusion (Stage 1 model judgment): ${stage1Usage.crimeTragedyDropped} dropped.`
  );
  console.log(
    `[topic-discovery] Stage 1 done: ${stage1Usage.apiCalls} Gemini calls, hardStopped=${stage1Usage.hardStopped}${
      stage1Usage.hardStopReason ? ` (${stage1Usage.hardStopReason})` : ''
    }`
  );
  console.log(`[topic-discovery] kept=${kept.length}, skipped=${skipped.length}`);
  console.log(`[topic-discovery] wall-clock: ${(wallClockMs / 1000).toFixed(1)}s`);

  const comparison = await compareAgainstTodaysSlotOutput(pool, kept);

  const outPath = writeShadowLog({
    generatedAt: new Date().toISOString(),
    wallClockMs,
    stage0: {
      queries: STAGE0_QUERIES.length,
      serpApiCalls: stage0Usage.apiCalls,
      serpApiErrors: stage0Usage.errors,
      serpApiErrorSample: stage0Usage.errorSample,
      rawResults: dedupeCounts.rawCount,
      exactDedupedResults: dedupeCounts.exactDedupedCount,
      nearDedupedResults: dedupeCounts.nearDedupedCount,
      nearDuplicateMerges,
      cappedPoolSize: dedupeCounts.cappedCount,
      cap: STAGE1_CANDIDATE_CAP,
      cannabisReservedSlots: CANNABIS_RESERVED_SLOTS,
      reservedCannabisItems: reservedCannabisItems.map((it) => ({ title: it.title, link: it.link })),
    },
    stage1: stage1Usage,
    kept,
    skipped,
    comparison,
  });
  console.log(`[topic-discovery] ========== SHADOW MODE run end — log: ${outPath} ==========`);

  return {
    kept,
    skipped,
    nearDuplicateMerges,
    dedupeCounts,
    reservedCannabisItems,
    stage0Usage,
    stage1Usage,
    wallClockMs,
    comparison,
    outPath,
  };
}

if (require.main === module) {
  runTopicDiscoveryShadow()
    .then((result) => {
      console.log('\n\n########## SHADOW MODE SUMMARY ##########');
      console.log(`Stage 0 SerpAPI calls: ${result.stage0Usage.apiCalls}, errors: ${result.stage0Usage.errors}`);
      console.log(
        `Dedupe pipeline: raw=${result.dedupeCounts.rawCount} → exact-dedupe=${result.dedupeCounts.exactDedupedCount} → near-dedupe=${result.dedupeCounts.nearDedupedCount} (${result.nearDuplicateMerges.length} merged) → capped=${result.dedupeCounts.cappedCount}`
      );
      console.log(
        `Editorial gate (keyword pre-filter): ${result.stage1Usage.editorialGateDropped} dropped, ${result.stage1Usage.proceededToStage1} proceeded to Stage 1`
      );
      console.log(
        `Crime/tragedy exclusion (Stage 1 model judgment): ${result.stage1Usage.crimeTragedyDropped} dropped`
      );
      console.log(
        `Stage 1 Gemini calls: ${result.stage1Usage.apiCalls} (cap=${STAGE1_CANDIDATE_CAP}, hardStopped=${result.stage1Usage.hardStopped}${
          result.stage1Usage.hardStopReason ? `, reason=${result.stage1Usage.hardStopReason}` : ''
        })`
      );
      console.log(`Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);
      console.log(`Kept: ${result.kept.length}, Skipped: ${result.skipped.length}`);
      console.log(`Output log: ${result.outPath}`);
      console.log(
        `\nCannabis reserved quota: ${result.reservedCannabisItems.length}/${CANNABIS_RESERVED_SLOTS} filled`
      );
      console.log(
        JSON.stringify(
          result.reservedCannabisItems.map((it) => ({ title: it.title, link: it.link })),
          null,
          2
        )
      );
      console.log('\n--- Near-duplicates merged (Stage 0, pre-cap) ---');
      console.log(JSON.stringify(result.nearDuplicateMerges, null, 2));
      console.log('\n--- (a) Topics only findable via national-with-potential-local-angle class ---');
      console.log(JSON.stringify(result.comparison.missedByOldSlots, null, 2));
      console.log('\n--- Astronomy/celestial-event test (solar-eclipse-shaped story check) ---');
      console.log(JSON.stringify(result.comparison.astronomyStyleTest, null, 2));
      console.log('\n--- (b) Section assignments that would differ from old rigid slot-1 logic ---');
      console.log(JSON.stringify(result.comparison.sectionMismatchesVsRigidSlot1, null, 2));
      console.log('\n--- (c) Cannabis content surviving this module\'s filters ---');
      console.log(JSON.stringify(result.comparison.cannabis, null, 2));
      console.log('\n--- Today\'s existing google_news Sanity posts (old pipeline, read-only) ---');
      console.log(JSON.stringify(result.comparison.todaysExistingGoogleNewsPosts, null, 2));
    })
    .catch((err) => {
      console.error('[topic-discovery] Fatal:', err);
      process.exit(1);
    });
}

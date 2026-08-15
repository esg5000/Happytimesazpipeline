/**
 * Stage 3 — Source Gathering (pipeline-redesign-architecture.md).
 *
 * Generic shell: gatherSources(topic) dispatches to a category-specific
 * checker based on the topic's subjectTag/section, falling back to a
 * general-purpose default checker (gatherDefaultSources) for anything
 * that doesn't match a more specific one. The `events` checker remains
 * for event-shaped topics (subjectTag hints, or section=nightlife); the
 * default checker is now Stage 3's primary path for everything else —
 * it fetches the real source article from topic.link and returns its
 * text as a single long-form fact, rather than the old "no checker
 * implemented" stub. There is no more silent/unhandled category: every
 * topic gets either the events checker or the default checker.
 *
 * STANDALONE. Does not import from or call newsApiSync.ts,
 * sanityPublisher.ts, editorAgent.ts, researchAgent.ts,
 * serpApiEventsSync.ts, or topicDiscovery.ts. Not wired into any publish
 * flow or the existing events sync. SHADOW MODE ONLY: the bottom of this
 * file runs a test harness against 5 hand-picked real events when
 * executed directly (`ts-node src/agents/sourceGathering.ts`); nothing
 * here writes to Sanity.
 *
 * `htmlToPlainText`, `fetchPagePlainTextWithPlaywright`, and the plain-
 * fetch-then-Playwright-fallback pattern are ported (copied, not
 * imported — private there) from src/agents/researchAgent.ts, per the
 * build instructions. No OpenAI call is made anywhere in this file —
 * Stage 3's job is fetching verifiable facts, not LLM synthesis.
 *
 * Deliberately does NOT reintroduce a category keyword *inclusion* gate
 * (the bug in agents/serpApiEventsSync.ts that could silently exclude
 * real events before they ever reached Sanity). The dispatch heuristic
 * here only decides which *checker* to route a topic to for this shell
 * — every topic gets a real attempt at gathering facts, never a silent
 * exclusion.
 */
import './playwrightBrowsersPath';
import axios from 'axios';
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { config } from '../../config';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

const PAGE_FETCH_TIMEOUT_MS = 25_000;
const PAGE_FETCH_MAX_BYTES = 2_000_000;
/** Meaningful plain-text length below which the Playwright fallback triggers. Mirrors researchAgent.ts's threshold. */
const PAGE_FETCH_MEANINGFUL_MIN_CHARS = 500;
const PLAYWRIGHT_FETCH_MAX_CHARS = 5000;

const SHADOW_OUTPUT_DIR = join(
  process.env.TEMP || process.env.TMPDIR || '/tmp',
  'happytimesaz-source-gathering'
);

// ---------------------------------------------------------------------------
// Shell types
// ---------------------------------------------------------------------------

export type Fact = {
  field: string;
  value: string;
  /** Which source this fact came from, e.g. "SerpAPI Events" or "venue page — HTTP fetch (<url>)" / "venue page — Playwright render (<url>)". Required for Stage 6 traceability. */
  source: string;
  sourceUrl?: string;
};

/**
 * Loosely-typed on purpose — this shell is meant to be reusable by future
 * categories with different topic shapes, and is not coupled to
 * topicDiscovery.ts's TopicDiscoveryResult type (not imported, per the
 * build constraints). `location` is an optional extra hint beyond the
 * shape given in the build spec ({title, snippet, link, section,
 * verdict, ...}) — useful for the events checker's SerpAPI query and
 * accepted as part of that "...".
 */
export type TopicInput = {
  title: string;
  snippet?: string;
  link?: string;
  section?: string;
  verdict?: string;
  subjectTag?: string;
  location?: string;
  [key: string]: unknown;
};

export type SourceGatheringResult = {
  topic: TopicInput;
  facts: Fact[];
  primarySourceFound: boolean;
  factCount: number;
  /** Set when nothing could be gathered — no checker for this category, or the checker ran but found no match. Additive to the core shape; Stage 4/5 can ignore it. */
  checkerNote?: string;
};

type CategoryChecker = (topic: TopicInput) => Promise<SourceGatheringResult>;

// ---------------------------------------------------------------------------
// Ported from src/agents/researchAgent.ts (private there) — generic HTML/
// page-fetch helpers, zero category-specific coupling.
// ---------------------------------------------------------------------------

function htmlToPlainText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (match, n: string) => {
      const code = parseInt(n, 10);
      if (!Number.isFinite(code) || code < 32) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, h: string) => {
      const code = parseInt(h, 16);
      if (!Number.isFinite(code) || code < 32) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    });
  t = t.replace(/\s+/g, ' ').trim();
  const max = 3000;
  if (t.length > max) {
    t = `${t.slice(0, max)}… [truncated]`;
  }
  return t;
}

function meaningfulPlainTextLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/** A nav-menu blob's "sentences" are short, punctuation-less fragments — this only counts chunks that actually look like written prose. */
const MIN_SUBSTANTIAL_SENTENCE_CHARS = 40;
/**
 * Real sentences are rarely this long — a nav menu with dozens of short
 * links strung together (no internal punctuation) but one incidental
 * period at the end becomes a single very long "chunk" under a naive
 * length-only check. Confirmed against a real page tonight: a 483-char
 * run of nav links ("Things To Do in Phoenix AZ... Skip to main content
 * Home Local Sports...AZ.") happened to end in a period and would
 * otherwise pass as one long "substantial sentence."
 */
const MAX_SUBSTANTIAL_SENTENCE_CHARS = 300;
/** Real prose runs roughly 30-50% common function words (the/a/of/and/for/...); nav-link chunks strung into Title Case phrases run much lower even when long enough to clear the length checks. */
const MIN_PROSE_STOPWORD_RATIO = 0.2;
const PROSE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'was', 'are', 'were', 'that', 'this', 'for',
  'on', 'at', 'from', 'by', 'with', 'as', 'it', 'its', 'be', 'has', 'have', 'had', 'will',
  'would', 'can', 'could', 'not', 'but', 'or', 'if', 'than', 'so', 'which', 'who', 'what',
  'when', 'where', 'how', 'your', 'our', 'their', 'his', 'her',
]);
/** Confirmed tonight: a 767-char nav-boilerplate page ("Skip to main content Home Local Sports...") cleared PAGE_FETCH_MEANINGFUL_MIN_CHARS on raw length alone. Requiring a few real sentences catches that case without needing a sophisticated parser. */
const MIN_SUBSTANTIAL_SENTENCES = 3;

/** True for a chunk that's the right length AND has enough function-word density to look like real prose, not a run of nav-link labels. */
function looksLikeProseSentence(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (trimmed.length < MIN_SUBSTANTIAL_SENTENCE_CHARS || trimmed.length > MAX_SUBSTANTIAL_SENTENCE_CHARS) {
    return false;
  }
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const stopwordCount = words.filter((w) => PROSE_STOPWORDS.has(w.replace(/[^a-z]/g, ''))).length;
  return stopwordCount / words.length >= MIN_PROSE_STOPWORD_RATIO;
}

function countSubstantialSentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(looksLikeProseSentence).length;
}

/**
 * Raw character count alone can't distinguish real article prose from a
 * long run of short nav-link-style fragments (no sentence-ending
 * punctuation, no sentence of meaningful length). Requires both enough
 * total length AND enough actual sentence-shaped content.
 */
function isMeaningfulProseText(text: string): boolean {
  if (meaningfulPlainTextLength(text) < PAGE_FETCH_MEANINGFUL_MIN_CHARS) return false;
  return countSubstantialSentences(text) >= MIN_SUBSTANTIAL_SENTENCES;
}

/** Headless Chromium: rendered DOM text when static HTTP fetch yields little content. Ported from researchAgent.ts's fetchPagePlainTextWithPlaywright. */
async function fetchPagePlainTextWithPlaywright(url: string): Promise<string | null> {
  console.log(`[source-gathering] Playwright fallback triggered for ${url}`);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // Many SPAs never reach networkidle; `load` above is enough to try innerText.
    }
    const inner = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
    let t = (inner || '').replace(/\s+/g, ' ').trim();
    if (t.length > PLAYWRIGHT_FETCH_MAX_CHARS) {
      t = `${t.slice(0, PLAYWRIGHT_FETCH_MAX_CHARS)}… [truncated]`;
    }
    return t.length > 0 ? t : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[source-gathering] Playwright fallback failed:', url, msg);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Plain HTTP fetch first, Playwright fallback if the result is under
 * PAGE_FETCH_MEANINGFUL_MIN_CHARS meaningful characters — same pattern as
 * researchAgent.ts's fetchPagePlainText, ported not imported. Returns which
 * method actually produced the text, for Stage 6 fact-source traceability
 * and for this build's test-harness reporting.
 */
async function fetchVenuePageText(
  url: string
): Promise<{ text: string; method: 'http' | 'playwright' } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const href = parsed.toString();
  let axiosText: string | null = null;

  try {
    const res = await axios.get<string>(href, {
      timeout: PAGE_FETCH_TIMEOUT_MS,
      maxContentLength: PAGE_FETCH_MAX_BYTES,
      maxBodyLength: PAGE_FETCH_MAX_BYTES,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; HappyTimesAZ-SourceGatheringBot/1.0; +https://happytimesaz.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const text = htmlToPlainText(html);
    if (text.length > 0) {
      axiosText = text;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[source-gathering] fetchVenuePageText (axios) failed:', href, msg);
  }

  const axiosMeaningful = axiosText !== null && isMeaningfulProseText(axiosText);
  if (axiosMeaningful && axiosText !== null) {
    return { text: axiosText, method: 'http' };
  }

  const pwText = await fetchPagePlainTextWithPlaywright(href);
  if (pwText && pwText.length > 0) {
    return { text: pwText, method: 'playwright' };
  }

  if (axiosText && axiosText.length > 40) {
    return { text: axiosText, method: 'http' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lightweight fact extraction from arbitrary page text — regex-based,
// deliberately conservative. Not a real NLP parser; see build report for
// observed hit-rate against the 5 live test cases.
// ---------------------------------------------------------------------------

const MONTH_RE =
  '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?';
const DATE_TEXT_RE = new RegExp(`\\b${MONTH_RE}\\s+\\d{1,2}(st|nd|rd|th)?,?\\s*(\\d{4})?\\b`, 'i');
const TIME_TEXT_RE = /\b\d{1,2}(:\d{2})?\s?(am|pm|AM|PM)\b/;
/** Only the explicit "$NN" pattern is trusted — a bare "free" match is too noisy on real venue pages (free wifi, free shipping, etc.) to treat as a price signal. */
const PRICE_TEXT_RE = /\$\d+(\.\d{2})?(\s?[-–]\s?\$?\d+(\.\d{2})?)?/;

function extractDateFromText(text: string): string | undefined {
  const m = text.match(DATE_TEXT_RE);
  return m ? m[0].trim() : undefined;
}

function extractTimeFromText(text: string): string | undefined {
  const m = text.match(TIME_TEXT_RE);
  return m ? m[0].trim() : undefined;
}

function extractPriceFromText(text: string): string | undefined {
  const m = text.match(PRICE_TEXT_RE);
  return m ? m[0].trim() : undefined;
}

// ---------------------------------------------------------------------------
// Events checker
// ---------------------------------------------------------------------------

type SerpGoogleEventResult = {
  title?: string;
  date?: { start_date?: string; when?: string };
  address?: string[];
  link?: string;
  description?: string;
  ticket_info?: Array<{ source?: string; link?: string; link_type?: string }>;
  venue?: { name?: string };
};

type SerpEventsApiResponse = {
  error?: string;
  events_results?: SerpGoogleEventResult[];
};

/** Small AZ city list for location-hint extraction — same 19 cities used elsewhere in the project, retyped here (not imported; topicDiscovery.ts and serpApiEventsSync.ts are both off-limits for this build). */
const AZ_CITY_HINTS = [
  'Phoenix', 'Scottsdale', 'Tempe', 'Mesa', 'Chandler', 'Gilbert', 'Glendale', 'Peoria', 'Surprise',
  'Flagstaff', 'Sedona', 'Prescott', 'Kingman', 'Tucson', 'Sierra Vista', 'Yuma', 'Lake Havasu City',
  'Show Low', 'Safford',
] as const;

function resolveLocationHint(topic: TopicInput): string | undefined {
  if (topic.location && topic.location.trim()) return topic.location.trim();
  const blob = `${topic.title} ${topic.snippet || ''}`;
  for (const city of AZ_CITY_HINTS) {
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(blob)) return `${city}, Arizona, United States`;
  }
  return undefined;
}

function buildEventsQuery(topic: TopicInput): string {
  const location = resolveLocationHint(topic);
  const locSuffix = location ? location.split(',')[0] : 'Arizona';
  return `${topic.title} ${locSuffix}`.trim();
}

/** Simple token-overlap similarity for picking the best SerpAPI result among several — not the full near-dedupe machinery from topicDiscovery.ts (not imported), just enough to prefer the closest title match. */
function simpleTitleSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function pickBestMatch(
  title: string,
  events: SerpGoogleEventResult[]
): SerpGoogleEventResult | undefined {
  if (events.length === 0) return undefined;
  let best = events[0];
  let bestScore = -1;
  for (const ev of events) {
    const score = simpleTitleSimilarity(title, ev.title || '');
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  return best;
}

function pickPageUrl(ev: SerpGoogleEventResult): string | undefined {
  const ticket = (ev.ticket_info || []).find((t) => t.link_type === 'tickets' && t.link);
  return ticket?.link || ev.link || undefined;
}

/**
 * SerpAPI-sourced facts only. Deliberately does NOT synthesize a fake
 * "price" fact the way agents/serpApiEventsSync.ts did (a non-numeric
 * "See {ticket source}" string) — SerpAPI's events engine doesn't actually
 * return price data in ticket_info, so a real price fact (when found) comes
 * from the venue page's own text instead (see buildVenuePageFacts).
 */
function buildSerpApiEventFacts(ev: SerpGoogleEventResult): Fact[] {
  const facts: Fact[] = [];
  const sourceUrl = ev.link;
  const source = 'SerpAPI Events';

  const venueName = ev.venue?.name || ev.address?.[0];
  if (venueName) facts.push({ field: 'venueName', value: venueName, source, sourceUrl });

  if (ev.address && ev.address.length > 0) {
    facts.push({ field: 'address', value: ev.address.join(', '), source, sourceUrl });
  }

  if (ev.date?.start_date) {
    facts.push({ field: 'date', value: ev.date.start_date, source, sourceUrl });
  }

  if (ev.date?.when) {
    const time = extractTimeFromText(ev.date.when);
    if (time) facts.push({ field: 'time', value: time, source, sourceUrl });
    if (!ev.date?.start_date) {
      facts.push({ field: 'date', value: ev.date.when, source, sourceUrl });
    }
  }

  const ticketUrl = pickPageUrl(ev);
  if (ticketUrl) facts.push({ field: 'ticketUrl', value: ticketUrl, source, sourceUrl });

  if (ev.description && ev.description.trim()) {
    facts.push({ field: 'description', value: ev.description.trim().slice(0, 1000), source, sourceUrl });
  }

  return facts;
}

function buildVenuePageFacts(text: string, pageUrl: string, method: 'http' | 'playwright'): Fact[] {
  const facts: Fact[] = [];
  const source =
    method === 'playwright' ? `venue page — Playwright render (${pageUrl})` : `venue page — HTTP fetch (${pageUrl})`;

  const dateMatch = extractDateFromText(text);
  if (dateMatch) facts.push({ field: 'date', value: dateMatch, source, sourceUrl: pageUrl });

  const timeMatch = extractTimeFromText(text);
  if (timeMatch) facts.push({ field: 'time', value: timeMatch, source, sourceUrl: pageUrl });

  const priceMatch = extractPriceFromText(text);
  if (priceMatch) facts.push({ field: 'price', value: priceMatch, source, sourceUrl: pageUrl });

  if (text.length > 80) {
    facts.push({ field: 'description', value: text.slice(0, 500), source, sourceUrl: pageUrl });
  }

  return facts;
}

/**
 * 1. One targeted SerpAPI google_events call scoped to this specific topic
 *    (not a bulk per-city sweep).
 * 2. If the best-matching result has a link, fetch it directly (HTTP, then
 *    Playwright fallback) — primary-source depth beyond the aggregator.
 * 3. Facts come from whatever combination of sources is actually available;
 *    SerpAPI-only is fine, but primarySourceFound is only true when the
 *    venue/ticket page itself was successfully fetched.
 * 4. No category keyword gate — every topic routed here is attempted.
 */
async function gatherEventSources(topic: TopicInput): Promise<SourceGatheringResult> {
  const query = buildEventsQuery(topic);
  const location = resolveLocationHint(topic) || 'Arizona, United States';
  console.log(`[source-gathering] events: SerpAPI query="${query}" location="${location}"`);

  let events: SerpGoogleEventResult[] = [];
  try {
    const { data, status } = await axios.get<SerpEventsApiResponse>(SERPAPI_SEARCH, {
      params: {
        engine: 'google_events',
        api_key: config.serpApi.apiKey,
        q: query,
        location,
        hl: 'en',
        gl: 'us',
      },
      validateStatus: () => true,
    });
    if (status === 200 && Array.isArray(data.events_results)) {
      events = data.events_results;
      console.log(`[source-gathering] events: SerpAPI returned ${events.length} result(s)`);
    } else {
      console.warn(
        `[source-gathering] events: SerpAPI httpStatus=${status}${data.error ? `, error=${data.error}` : ''}`
      );
    }
  } catch (err: unknown) {
    console.warn('[source-gathering] events: SerpAPI call failed:', err instanceof Error ? err.message : err);
  }

  const best = pickBestMatch(topic.title, events);
  if (!best) {
    const checkerNote = `No SerpAPI Events match found for query "${query}".`;
    console.warn(`[source-gathering] events: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }
  console.log(`[source-gathering] events: best match = "${(best.title || '(untitled)').slice(0, 90)}"`);

  const facts: Fact[] = [...buildSerpApiEventFacts(best)];

  const pageUrl = pickPageUrl(best);
  let primarySourceFound = false;
  if (pageUrl) {
    const pageResult = await fetchVenuePageText(pageUrl);
    if (pageResult && pageResult.text.length > 80) {
      primarySourceFound = true;
      facts.push(...buildVenuePageFacts(pageResult.text, pageUrl, pageResult.method));
      console.log(
        `[source-gathering] events: venue page fetched via ${pageResult.method} (${pageResult.text.length} chars) — ${pageUrl}`
      );
    } else {
      console.warn(`[source-gathering] events: venue page fetch yielded nothing usable — ${pageUrl}`);
    }
  } else {
    console.log('[source-gathering] events: no link on the matched SerpAPI result; nothing to fetch.');
  }

  return { topic, facts, primarySourceFound, factCount: facts.length };
}

// ---------------------------------------------------------------------------
// Default checker — general-purpose, not scoped to any single category.
// Stage 3's primary path for any topic the events checker doesn't claim.
// ---------------------------------------------------------------------------

/** Real outlet name from a URL's hostname — same pattern used for attribution elsewhere in this pipeline. */
function deriveOutletName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}

/**
 * A single fact carrying an explicit writing instruction, included
 * alongside the fetched article text whenever the default checker
 * succeeds. This is the only channel available to reach Stage 5 without
 * modifying articleWriter.ts or its prompt file (out of scope for this
 * build) — Stage 5 already reads every fact in AVAILABLE FACTS, so this
 * rides the same path real content facts use. Not attributed to a real
 * source (no sourceUrl) since it isn't sourced content — it's an
 * editorial instruction about how to use the sourced content next to it.
 */
const WRITING_GUIDANCE_FACT: Fact = {
  field: 'writingGuidance',
  value:
    'Write an original piece informed by this source material — do not closely paraphrase, closely follow, or mirror the structure of the sourced article text. Attribute claims to their source, same standard as every other checker.',
  source: 'source-gathering (Stage 3 editorial instruction)',
};

/**
 * General-purpose default checker: fetches the real source article from
 * topic.link (same fetch-then-Playwright-fallback as fetchVenuePageText —
 * reused directly, not duplicated) and returns its text as a single
 * long-form fact, tagged with the real outlet name + URL. Stage 4/5/6
 * don't need this broken into individual fields the way event facts are —
 * one "sourced article text" fact is the whole point of this checker.
 */
async function gatherDefaultSources(topic: TopicInput): Promise<SourceGatheringResult> {
  const link = topic.link;
  if (!link) {
    const checkerNote = 'No topic.link available — the default checker requires a source URL to fetch.';
    console.warn(`[source-gathering] default: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  console.log(`[source-gathering] default: fetching source article — ${link}`);
  const pageResult = await fetchVenuePageText(link);
  if (!pageResult || pageResult.text.length <= 80) {
    const checkerNote = `Fetched ${pageResult?.text.length ?? 0} usable char(s) from ${link} — below the meaningful-content threshold; nothing to write from.`;
    console.warn(`[source-gathering] default: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  const outlet = deriveOutletName(link);
  const source = `${outlet} — ${pageResult.method === 'playwright' ? 'Playwright render' : 'HTTP fetch'} (${link})`;

  const facts: Fact[] = [
    { field: 'sourceArticleText', value: pageResult.text, source, sourceUrl: link },
    WRITING_GUIDANCE_FACT,
  ];

  console.log(
    `[source-gathering] default: fetched via ${pageResult.method} (${pageResult.text.length} chars) from ${outlet} — ${link}`
  );
  return { topic, facts, primarySourceFound: true, factCount: facts.length };
}

// ---------------------------------------------------------------------------
// Generic shell — dispatch
// ---------------------------------------------------------------------------

/** Words/phrases in a freeform subjectTag that suggest event-shaped content. Routing heuristic only — does not exclude anything from being gathered, it only picks which checker to try; anything not matched here still gets a real attempt via the default checker. */
const EVENT_SUBJECT_TAG_HINTS = [
  'event', 'concert', 'festival', 'show', 'yoga', 'trivia', 'class', 'workshop', 'conference',
  'tour', 'exhibit', 'screening', 'performance', 'meetup', 'gig', 'live music', 'market', 'expo',
  'game', 'tournament', 'film festival',
];

function resolveCategoryForTopic(topic: TopicInput): 'events' | 'default' {
  const tag = (topic.subjectTag || '').toLowerCase();
  if (tag && EVENT_SUBJECT_TAG_HINTS.some((h) => tag.includes(h))) return 'events';
  if (topic.section === 'nightlife') return 'events';
  return 'default';
}

const CATEGORY_CHECKERS: Record<'events' | 'default', CategoryChecker> = {
  events: gatherEventSources,
  default: gatherDefaultSources,
};

/**
 * Generic Stage 3 entry point. Dispatches to a category-specific checker
 * based on the topic's subjectTag (preferred — more precise than section,
 * since Stage 0-2's section enum has no "events" value) or section as a
 * fallback; anything that isn't event-shaped goes to the general-purpose
 * default checker. No topic falls through to an unhandled/silent path.
 */
export async function gatherSources(topic: TopicInput): Promise<SourceGatheringResult> {
  const category = resolveCategoryForTopic(topic);
  return CATEGORY_CHECKERS[category](topic);
}

// ---------------------------------------------------------------------------
// Shadow-mode test harness — 5 hand-picked real events, plus one bonus
// non-event topic to confirm the "no checker implemented" path works.
// ---------------------------------------------------------------------------

const TEST_TOPICS: TopicInput[] = [
  {
    title: 'Steel Pulse with Eli-Mac',
    snippet:
      'Reggae legends Steel Pulse play The Van Buren in Phoenix, AZ on Aug 13, 2026 at 8:00pm, with support from Eli-Mac.',
    section: 'nightlife',
    verdict: 'direct-local',
    subjectTag: 'concert',
    location: 'Phoenix, AZ',
  },
  {
    title: 'Mesa International Film Festival',
    snippet:
      'The Mesa International Film Festival runs Aug 12-16, 2026 at the Mesa Convention Center and other venues around Mesa, AZ.',
    section: 'news',
    verdict: 'direct-local',
    subjectTag: 'film festival',
    location: 'Mesa, AZ',
  },
  {
    title: 'Trivia Night at Arizona Wilderness Brewing Co.',
    snippet: 'Weekly trivia night every Wednesday at Arizona Wilderness Brewing Co.',
    section: 'nightlife',
    verdict: 'direct-local',
    subjectTag: 'trivia',
    location: 'Gilbert, AZ',
  },
  {
    title: 'Sunday Yoga',
    snippet: 'Sunday Yoga at Kähvi Coffee + Cafe in Downtown Phoenix, AZ on Aug 16, 2026 at 10:30am.',
    section: 'health-wellness',
    verdict: 'direct-local',
    subjectTag: 'yoga class',
    location: 'Phoenix, AZ',
  },
  {
    title: 'WordCamp US 2026',
    snippet: 'WordCamp US 2026 takes place Aug 16-19, 2026 at the Phoenix Convention Center North in Phoenix, AZ.',
    section: 'news',
    verdict: 'direct-local',
    subjectTag: 'conference',
    location: 'Phoenix, AZ',
  },
];

const BONUS_NON_EVENT_TOPIC: TopicInput = {
  title: 'New taco spot opens in Tempe',
  snippet: 'A new taco restaurant opened this week in downtown Tempe.',
  section: 'food',
  verdict: 'direct-local',
  subjectTag: 'restaurant opening',
};

function writeShadowLog(payload: unknown): string {
  mkdirSync(SHADOW_OUTPUT_DIR, { recursive: true });
  const filename = `source-gathering-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outPath = join(SHADOW_OUTPUT_DIR, filename);
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  return outPath;
}

async function runShadowTestHarness(): Promise<void> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  console.log('[source-gathering] ========== SHADOW TEST HARNESS start ==========');

  const results: { topic: TopicInput; result: SourceGatheringResult }[] = [];
  for (const topic of TEST_TOPICS) {
    console.log(`\n[source-gathering] --- Testing: "${topic.title}" ---`);
    const result = await gatherSources(topic);
    results.push({ topic, result });
    console.log(
      `[source-gathering] "${topic.title}" → factCount=${result.factCount}, primarySourceFound=${result.primarySourceFound}`
    );
  }

  console.log('\n[source-gathering] --- Bonus: non-events category (dispatch check) ---');
  const bonusResult = await gatherSources(BONUS_NON_EVENT_TOPIC);
  console.log(
    `[source-gathering] "${BONUS_NON_EVENT_TOPIC.title}" → factCount=${bonusResult.factCount}, primarySourceFound=${bonusResult.primarySourceFound}, checkerNote=${bonusResult.checkerNote ?? '(none)'}`
  );

  const outPath = writeShadowLog({
    generatedAt: new Date().toISOString(),
    results,
    bonusNonEventCheck: { topic: BONUS_NON_EVENT_TOPIC, result: bonusResult },
  });

  console.log('\n\n########## SOURCE GATHERING TEST HARNESS SUMMARY ##########');
  for (const { topic, result } of results) {
    console.log(`\n--- ${topic.title} ---`);
    console.log(`factCount=${result.factCount} primarySourceFound=${result.primarySourceFound}`);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('\n--- Bonus: non-events dispatch check ---');
  console.log(JSON.stringify(bonusResult, null, 2));
  console.log(`\nOutput log: ${outPath}`);
  console.log('[source-gathering] ========== SHADOW TEST HARNESS end ==========');
}

if (require.main === module) {
  runShadowTestHarness().catch((err) => {
    console.error('[source-gathering] Fatal:', err);
    process.exit(1);
  });
}

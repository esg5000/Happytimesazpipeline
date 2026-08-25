/**
 * Stage 3 — Source Gathering (pipeline-redesign-architecture.md).
 *
 * Generic shell: gatherSources(topic) dispatches to a category-specific
 * checker based on the topic's subjectTag/section, falling back to a
 * general-purpose default checker (gatherDefaultSources) for anything
 * that doesn't match a more specific one. Event-shaped topics (subjectTag
 * hints, or section=nightlife) go through gatherEventSourcesTiered:
 * Ticketmaster's Discovery API first (clean structured JSON straight from
 * the ticketing provider, no scraping), then whatsupeastvalley.com's East
 * Valley Events listing, then dtphx.org's events calendar (both static-HTML
 * listing pages, regex-parsed per card), falling back to the SerpAPI-based
 * gatherEventSources when none of the three has a confident match. The
 * default checker is Stage 3's primary path for everything else —
 * it fetches the real source article, preferring topic.link but falling
 * back through topic.searchSummaries URLs in order when topic.link
 * doesn't yield substantial content, and returns whichever succeeded as
 * a single long-form fact tagged with its real URL/outlet — rather than
 * the old "no checker implemented" stub. There is no more silent/
 * unhandled category: every topic gets either the events checker or the
 * default checker.
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
  /**
   * Mirrors topicDiscovery.ts's Stage 1 SearchSummary[] shape (not
   * imported — redefined locally, per this file's decoupling pattern).
   * Alternate URLs the web_search step turned up while verifying the
   * topic — sometimes a better primary source than topic.link (e.g. a
   * client-rendered discovery-widget link vs. the actual event page).
   */
  searchSummaries?: { title?: string; url?: string; summary?: string }[];
  [key: string]: unknown;
};

export type SourceGatheringResult = {
  topic: TopicInput;
  facts: Fact[];
  primarySourceFound: boolean;
  factCount: number;
  /** Set when nothing could be gathered — no checker for this category, or the checker ran but found no match. Additive to the core shape; Stage 4/5 can ignore it. */
  checkerNote?: string;
  /**
   * Only meaningful when gatherDefaultSources produced a sourceArticleText
   * fact. true = the fetched text cleared isMeaningfulProseText (the
   * `chosen` path below); false = nothing cleared that bar and the text
   * used is the thin last-resort `fallbackChoice` — real bytes came back,
   * but the default checker itself didn't trust it as substantial.
   * Undefined for every other checker / when no sourceArticleText fact
   * exists. primarySourceFound deliberately keeps its existing meaning
   * ("did we get any real source at all, vs. SerpAPI-only") and is NOT
   * repurposed for this — this is a separate, narrower signal so Stage 4
   * can tell the two `final` branches apart instead of both collapsing
   * into primarySourceFound=true (the gap that let a thin placeholder
   * page's text reach Stage 4 looking identical to real substantial
   * content — see 2026-08-25's "No game recap available" incident).
   */
  sourceArticleTextSubstantial?: boolean;
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

/**
 * Raw-HTML counterpart to fetchPagePlainTextWithPlaywright above — returns
 * the rendered DOM's full markup (page.content()) instead of innerText, for
 * checkers that need to regex-parse listing-card structure rather than read
 * prose. Used by fetchRawHtml below when a plain HTTP GET is blocked (e.g. a
 * WAF rejecting non-browser requests) or fails outright.
 */
async function fetchPageRawHtmlWithPlaywright(url: string): Promise<string | null> {
  console.log(`[source-gathering] Playwright raw-HTML fallback triggered for ${url}`);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // Many sites never reach networkidle; `load` above is enough to read the DOM.
    }
    const html = await page.content();
    return html && html.length > 0 ? html : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[source-gathering] Playwright raw-HTML fallback failed:', url, msg);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Plain HTTP fetch first (same headers/timeouts as fetchVenuePageText),
 * Playwright fallback if that fails or returns a trivially small response —
 * used by listing-page checkers (WUEV, dtphx) that need real HTML structure
 * to regex-parse, not the stripped plain text fetchVenuePageText returns.
 */
async function fetchRawHtml(url: string): Promise<{ html: string; method: 'http' | 'playwright' } | null> {
  let axiosHtml: string | null = null;
  try {
    const res = await axios.get<string>(url, {
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
    if (typeof res.data === 'string' && res.data.length > 200) {
      axiosHtml = res.data;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[source-gathering] fetchRawHtml (axios) failed:', url, msg);
  }

  if (axiosHtml) {
    return { html: axiosHtml, method: 'http' };
  }

  const pwHtml = await fetchPageRawHtmlWithPlaywright(url);
  if (pwHtml) {
    return { html: pwHtml, method: 'playwright' };
  }
  return null;
}

/**
 * Decodes/strips markup from a single regex-captured field (a card's title,
 * venue, date span, etc.) — narrower than htmlToPlainText (no truncation,
 * no script/style stripping, since callers only ever hand it small already-
 * isolated fragments) and kept separate so it never risks changing
 * htmlToPlainText's behavior for the default/SerpAPI-events checkers.
 */
function decodeHtmlFieldText(raw: string): string {
  const t = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
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
  return t.replace(/\s+/g, ' ').trim();
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

/**
 * Stricter companion to simpleTitleSimilarity, used only by the WUEV/dtphx
 * pick-best functions below (NOT by pickBestMatch/pickBestTicketmasterMatch
 * above — those, and simpleTitleSimilarity itself, are left exactly as they
 * were). Confirmed live during this build: on dtphx's 152-card calendar,
 * "Popsicle Popup Party" scored 0.25 against an unrelated "LAN Party" card
 * (both share only the generic word "party"), clearing the same 0.2
 * threshold Ticketmaster uses safely on its much larger catalog — WUEV/
 * dtphx's shorter, more genericword-heavy titles need every token of the
 * shorter title to appear in the other before a candidate is even
 * considered, not just a plurality of shared tokens.
 */
function shorterTitleFullyContained(a: string, b: string): boolean {
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
  if (ta.size === 0 || tb.size === 0) return false;
  const [shorter, longer] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const w of shorter) {
    if (!longer.has(w)) return false;
  }
  return true;
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
// Ticketmaster Discovery API checker — TRY-FIRST layer for event-shaped
// topics, ahead of gatherEventSources above. Returns clean structured JSON
// directly from the ticketing provider itself, no HTML scraping needed.
// ---------------------------------------------------------------------------

const TICKETMASTER_DISCOVERY_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
/**
 * Downtown Phoenix — centers a radius search so metro-area venues (Tempe,
 * Scottsdale, Glendale, Chandler, Mesa) are reached, not just events
 * literally tagged city=Phoenix. Confirmed live: `city=Phoenix&stateCode=AZ`
 * alone returns ~1,428 total events for the metro; a 30-mile radius search
 * from this point returns ~2,318 and includes real Tempe (Marquee Theatre)
 * and Scottsdale (ASU Kerr, Talking Stick Resort) venues the city-filtered
 * query misses. Ticketmaster's dmas.json endpoint (the DMA-based
 * alternative) returned a live 404 when checked, so radius/latlong is used
 * instead of dmaId.
 */
const TICKETMASTER_PHOENIX_METRO_LATLONG = '33.4484,-112.0740';
const TICKETMASTER_PHOENIX_METRO_RADIUS_MILES = 30;
/**
 * Below this token-overlap score, the "best" Ticketmaster result is treated
 * as no real match rather than a wrong-event attachment. Needed because
 * Ticketmaster's `keyword` param is a broad full-text search (unlike
 * SerpAPI's events engine above, which is pre-scoped by query+location) —
 * a mismatched topic can still return some loosely related result rather
 * than an empty array, and attaching real Ticketmaster facts to the wrong
 * event would be a factual-accuracy problem even though every individual
 * fact is genuine data.
 */
const TICKETMASTER_MIN_MATCH_SCORE = 0.2;

type TicketmasterVenue = {
  name?: string;
  address?: { line1?: string };
  city?: { name?: string };
  state?: { stateCode?: string };
};

type TicketmasterPriceRange = { type?: string; currency?: string; min?: number; max?: number };

type TicketmasterEvent = {
  name?: string;
  url?: string;
  dates?: { start?: { localDate?: string; localTime?: string } };
  priceRanges?: TicketmasterPriceRange[];
  _embedded?: { venues?: TicketmasterVenue[] };
};

type TicketmasterEventsResponse = {
  _embedded?: { events?: TicketmasterEvent[] };
  page?: { totalElements?: number };
};

/** Same token-overlap approach as simpleTitleSimilarity/pickBestMatch above (reused, not duplicated) — picks the closest-matching Ticketmaster result for this topic's title. */
function pickBestTicketmasterMatch(
  title: string,
  events: TicketmasterEvent[]
): { event: TicketmasterEvent; score: number } | undefined {
  if (events.length === 0) return undefined;
  let best = events[0];
  let bestScore = -1;
  for (const ev of events) {
    const score = simpleTitleSimilarity(title, ev.name || '');
    if (score > bestScore) {
      bestScore = score;
      best = ev;
    }
  }
  return { event: best, score: bestScore };
}

/**
 * Only the fields Ticketmaster's response actually contains become facts —
 * confirmed live that `priceRanges` is frequently absent entirely (not
 * present for either a major touring show or a WNBA game checked during
 * testing), so price is only added when the API itself provides it. No
 * synthesized/placeholder price, same discipline as buildSerpApiEventFacts
 * above.
 */
function buildTicketmasterEventFacts(ev: TicketmasterEvent): Fact[] {
  const facts: Fact[] = [];
  const source = 'Ticketmaster Discovery API';
  const sourceUrl = ev.url;

  const venue = ev._embedded?.venues?.[0];
  if (venue?.name) {
    facts.push({ field: 'venueName', value: venue.name.trim(), source, sourceUrl });
  }
  const addressParts = [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(
    (p): p is string => !!p && p.trim().length > 0
  );
  if (addressParts.length > 0) {
    facts.push({ field: 'address', value: addressParts.join(', '), source, sourceUrl });
  }

  const start = ev.dates?.start;
  if (start?.localDate) {
    facts.push({ field: 'date', value: start.localDate, source, sourceUrl });
  }
  if (start?.localTime) {
    facts.push({ field: 'time', value: start.localTime, source, sourceUrl });
  }

  const priceRange = (ev.priceRanges || []).find(
    (p) => typeof p.min === 'number' || typeof p.max === 'number'
  );
  if (priceRange) {
    const currency = priceRange.currency || 'USD';
    const { min, max } = priceRange;
    const value =
      min != null && max != null && min !== max
        ? `${currency} ${min}–${max}`
        : `${currency} ${min ?? max}`;
    facts.push({ field: 'price', value, source, sourceUrl });
  }

  if (ev.url) {
    facts.push({ field: 'ticketUrl', value: ev.url, source, sourceUrl });
  }

  return facts;
}

/**
 * 1. One targeted Ticketmaster Discovery API call: topic title as keyword,
 *    scoped to the Phoenix metro via radius search (see constants above).
 * 2. If the best match clears TICKETMASTER_MIN_MATCH_SCORE, its facts come
 *    directly from the API response — no page fetch needed, Ticketmaster
 *    is the primary source for its own ticketing/pricing data.
 * 3. No match (empty results, or best result too dissimilar) returns the
 *    same empty/no-results shape every other checker uses, so the caller
 *    can fall back cleanly.
 */
async function gatherTicketmasterEventSources(topic: TopicInput): Promise<SourceGatheringResult> {
  if (!config.ticketmaster.apiKey) {
    const checkerNote = 'TICKETMASTER_API_KEY is not set.';
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  const keyword = topic.title.trim();
  console.log(`[source-gathering] ticketmaster: keyword="${keyword}"`);

  let events: TicketmasterEvent[] = [];
  let totalElements: number | undefined;
  try {
    const res = await axios.get<TicketmasterEventsResponse>(TICKETMASTER_DISCOVERY_URL, {
      params: {
        apikey: config.ticketmaster.apiKey,
        keyword,
        latlong: TICKETMASTER_PHOENIX_METRO_LATLONG,
        radius: TICKETMASTER_PHOENIX_METRO_RADIUS_MILES,
        unit: 'miles',
        size: 10,
      },
      validateStatus: () => true,
    });
    if (res.status === 200) {
      events = res.data?._embedded?.events || [];
      totalElements = res.data?.page?.totalElements;
      console.log(
        `[source-gathering] ticketmaster: returned ${events.length} result(s) (${totalElements ?? '?'} total)`
      );
    } else if (res.status === 404) {
      // Ticketmaster returns 404 (not an empty 200) when a keyword search matches nothing.
      console.log('[source-gathering] ticketmaster: HTTP 404 (no matches for this keyword).');
    } else {
      console.warn(`[source-gathering] ticketmaster: HTTP ${res.status}`);
    }
  } catch (err: unknown) {
    console.warn('[source-gathering] ticketmaster: call failed:', err instanceof Error ? err.message : err);
  }

  const bestMatch = pickBestTicketmasterMatch(topic.title, events);
  if (!bestMatch || bestMatch.score < TICKETMASTER_MIN_MATCH_SCORE) {
    const checkerNote = bestMatch
      ? `No Ticketmaster match found for "${keyword}" — closest candidate "${(bestMatch.event.name || '').trim()}" scored ${bestMatch.score.toFixed(2)}, below the ${TICKETMASTER_MIN_MATCH_SCORE} threshold.`
      : `No Ticketmaster results for "${keyword}".`;
    console.log(`[source-gathering] ticketmaster: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  console.log(
    `[source-gathering] ticketmaster: best match = "${(bestMatch.event.name || '').trim()}" (score=${bestMatch.score.toFixed(2)})`
  );
  const facts = buildTicketmasterEventFacts(bestMatch.event);
  return { topic, facts, primarySourceFound: facts.length > 0, factCount: facts.length };
}

// ---------------------------------------------------------------------------
// WUEV checker — whatsupeastvalley.com/east-valley-events/, TRY-SECOND
// tier (after Ticketmaster, ahead of dtphx and the SerpAPI fallback). Static
// server-rendered HTML: listing cards on this one page already carry title,
// category, venue+address, date, and description — no detail-page follow-
// through needed. Card markup confirmed live: WordPress "wp-event-solution"
// plugin output, `.etn-event-item` blocks with stable `etn-*` class names.
// ---------------------------------------------------------------------------

const WUEV_EVENTS_URL = 'https://whatsupeastvalley.com/east-valley-events/';
/** Same reasoning as TICKETMASTER_MIN_MATCH_SCORE above — below this score the "best" card is treated as no real match rather than a wrong-event attachment. */
const WUEV_MIN_MATCH_SCORE = 0.2;

type WuevCard = {
  title: string;
  detailUrl?: string;
  category?: string;
  locationBlob?: string;
  date?: string;
  description?: string;
};

/**
 * Card markup (confirmed live, whitespace-collapsed):
 * <div class="etn-event-item">...<a href="URL" ... aria-label="East Valley Events">...
 *   <div class="etn-event-category"><span>Category</span></div> ...
 *   <div class="etn-event-location"><i .../> Venue Name, Street, City, AZ ZIP</div>
 *   <h3 class="etn-title etn-event-title"><a ...>Title</a></h3>
 *   <p>Description</p>
 *   <div class="etn-event-date"><span><i .../> Month D, YYYY</span></div>
 * Regex-per-card, same "deliberately conservative" approach as the rest of
 * this file — split on the item-marker class, then extract each field from
 * its own chunk.
 */
function parseWuevCards(html: string): WuevCard[] {
  const norm = html.replace(/\s+/g, ' ');
  const chunks = norm.split('etn-event-item').slice(1);
  const cards: WuevCard[] = [];
  for (const chunk of chunks) {
    const titleMatch = chunk.match(/<h3 class="etn-title etn-event-title">\s*<a[^>]*>([^<]*)<\/a>/);
    if (!titleMatch) continue;
    const linkMatch = chunk.match(/<a href="([^"]+)"[^>]*aria-label="East Valley Events">/);
    const categoryMatch = chunk.match(/<div class="etn-event-category">\s*<span>([^<]*)<\/span>/);
    const locationMatch = chunk.match(/<div class="etn-event-location">(?:<i[^>]*><\/i>)?\s*([^<]*)<\/div>/);
    const descMatch = chunk.match(/<\/h3>\s*<p>([^<]*)<\/p>/);
    const dateMatch = chunk.match(/<div class="etn-event-date">\s*<span>\s*(?:<i[^>]*><\/i>)?\s*([^<]*)<\/span>/);

    cards.push({
      title: decodeHtmlFieldText(titleMatch[1]),
      detailUrl: linkMatch ? linkMatch[1] : undefined,
      category: categoryMatch ? decodeHtmlFieldText(categoryMatch[1]) : undefined,
      locationBlob: locationMatch ? decodeHtmlFieldText(locationMatch[1]) : undefined,
      date: dateMatch ? decodeHtmlFieldText(dateMatch[1]) : undefined,
      description: descMatch ? decodeHtmlFieldText(descMatch[1]) : undefined,
    });
  }
  return cards;
}

/** The location blob is "Venue Name, street, city, state zip" as one string — venue name is everything before the first comma, address is the rest. */
function splitWuevLocationBlob(blob: string): { venueName?: string; address?: string } {
  const text = blob.trim();
  if (!text) return {};
  const firstComma = text.indexOf(',');
  if (firstComma === -1) return { venueName: text };
  return {
    venueName: text.slice(0, firstComma).trim() || undefined,
    address: text.slice(firstComma + 1).trim() || undefined,
  };
}

function pickBestWuevMatch(title: string, cards: WuevCard[]): { card: WuevCard; score: number } | undefined {
  const candidates = cards.filter((card) => shorterTitleFullyContained(title, card.title));
  if (candidates.length === 0) return undefined;
  let best = candidates[0];
  let bestScore = -1;
  for (const card of candidates) {
    const score = simpleTitleSimilarity(title, card.title);
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return { card: best, score: bestScore };
}

function buildWuevEventFacts(card: WuevCard): Fact[] {
  const facts: Fact[] = [];
  const source = "What's Up East Valley — East Valley Events listing";
  const sourceUrl = card.detailUrl || WUEV_EVENTS_URL;

  if (card.category) facts.push({ field: 'category', value: card.category, source, sourceUrl });

  const { venueName, address } = splitWuevLocationBlob(card.locationBlob || '');
  if (venueName) facts.push({ field: 'venueName', value: venueName, source, sourceUrl });
  if (address) facts.push({ field: 'address', value: address, source, sourceUrl });

  if (card.date) facts.push({ field: 'date', value: card.date, source, sourceUrl });
  if (card.description) facts.push({ field: 'description', value: card.description, source, sourceUrl });
  if (card.detailUrl) facts.push({ field: 'ticketUrl', value: card.detailUrl, source, sourceUrl });

  return facts;
}

/**
 * 1. Fetch the one East Valley Events listing page (fetchRawHtml — plain
 *    HTTP, Playwright fallback if blocked).
 * 2. Parse every listing card, pick the closest title match.
 * 3. Below WUEV_MIN_MATCH_SCORE, treat as no match (same discipline as
 *    Ticketmaster's checker) so the caller falls through to dtphx/SerpAPI
 *    instead of attaching facts to the wrong event.
 */
async function gatherWuevEventSources(topic: TopicInput): Promise<SourceGatheringResult> {
  console.log(`[source-gathering] wuev: fetching ${WUEV_EVENTS_URL}`);
  const raw = await fetchRawHtml(WUEV_EVENTS_URL);
  if (!raw) {
    const checkerNote = `Could not fetch ${WUEV_EVENTS_URL} (WUEV East Valley Events listing).`;
    console.warn(`[source-gathering] wuev: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  const cards = parseWuevCards(raw.html);
  console.log(`[source-gathering] wuev: parsed ${cards.length} listing card(s) via ${raw.method}`);

  const bestMatch = pickBestWuevMatch(topic.title, cards);
  if (!bestMatch || bestMatch.score < WUEV_MIN_MATCH_SCORE) {
    const checkerNote = bestMatch
      ? `No WUEV match for "${topic.title}" — closest candidate "${bestMatch.card.title}" scored ${bestMatch.score.toFixed(2)}, below the ${WUEV_MIN_MATCH_SCORE} threshold.`
      : cards.length > 0
        ? `Parsed ${cards.length} WUEV listing card(s), but none share every word of "${topic.title}" — no confident match.`
        : `No WUEV listing cards parsed from ${WUEV_EVENTS_URL}.`;
    console.log(`[source-gathering] wuev: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  console.log(`[source-gathering] wuev: best match = "${bestMatch.card.title}" (score=${bestMatch.score.toFixed(2)})`);
  const facts = buildWuevEventFacts(bestMatch.card);
  return { topic, facts, primarySourceFound: facts.length > 0, factCount: facts.length };
}

// ---------------------------------------------------------------------------
// dtphx checker — dtphx.org/events/calendar, TRY-THIRD tier (after
// Ticketmaster and WUEV, ahead of the SerpAPI fallback). Static server-
// rendered HTML: confirmed live that the full card list (title, time, day,
// date, venue, detail-page link) is present in the plain HTTP response
// itself — `a.pcrd` cards from the "Picnic" calendar widget CivicPlus
// (dtphx.org's CMS vendor) renders server-side, no JS execution required.
// ---------------------------------------------------------------------------

const DTPHX_CALENDAR_URL = 'https://dtphx.org/events/calendar';
const DTPHX_BASE_URL = 'https://dtphx.org';
/** Same reasoning as TICKETMASTER_MIN_MATCH_SCORE/WUEV_MIN_MATCH_SCORE above. */
const DTPHX_MIN_MATCH_SCORE = 0.2;

type DtphxCard = {
  title: string;
  detailUrl?: string;
  venue?: string;
  time?: string;
  dow?: string;
  day?: string;
  month?: string;
};

/**
 * Card markup (confirmed live, whitespace-collapsed):
 * <a class="pcrd" href="/do/slug">
 *   <div class="pcrd-content-headline">Title</div>
 *   <div class="pcrd-content-time"><span><i .../></span> 9am</div>
 *   <div class="pcrd-content-venue"><span><i .../></span>Venue Name</div>
 *   <div class="pcrd-date-box">
 *     <div class="pcrd-date-dow">Monday</div>
 *     <div class="pcrd-date-day">17</div>
 *     <div class="pcrd-date-month">Aug</div>
 *   </div>
 * </a>
 * No nested <a> inside a card, so a single non-greedy anchor-to-anchor
 * regex safely captures one whole card at a time. No year is shown on the
 * card (only weekday/day/month-abbreviation) — the date fact reports
 * exactly that, no invented year.
 */
function parseDtphxCards(html: string): DtphxCard[] {
  const norm = html.replace(/\s+/g, ' ');
  const cardRe = /<a class="pcrd" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const cards: DtphxCard[] = [];
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(norm)) !== null) {
    const href = m[1];
    const inner = m[2];
    const titleMatch = inner.match(/<div class="pcrd-content-headline">([^<]*)<\/div>/);
    if (!titleMatch) continue;

    const timeMatch = inner.match(/<div class="pcrd-content-time">[\s\S]*?<\/span>\s*([^<]*)<\/div>/);
    const venueMatch = inner.match(/<div class="pcrd-content-venue">[\s\S]*?<\/span>\s*([^<]*)<\/div>/);
    const dowMatch = inner.match(/<div class="pcrd-date-dow">([^<]*)<\/div>/);
    const dayMatch = inner.match(/<div class="pcrd-date-day">([^<]*)<\/div>/);
    const monthMatch = inner.match(/<div class="pcrd-date-month">([^<]*)<\/div>/);

    const detailUrl = href
      ? href.startsWith('http')
        ? href
        : `${DTPHX_BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`
      : undefined;

    cards.push({
      title: decodeHtmlFieldText(titleMatch[1]),
      detailUrl,
      venue: venueMatch ? decodeHtmlFieldText(venueMatch[1]) : undefined,
      time: timeMatch ? decodeHtmlFieldText(timeMatch[1]) : undefined,
      dow: dowMatch ? decodeHtmlFieldText(dowMatch[1]) : undefined,
      day: dayMatch ? decodeHtmlFieldText(dayMatch[1]) : undefined,
      month: monthMatch ? decodeHtmlFieldText(monthMatch[1]) : undefined,
    });
  }
  return cards;
}

function pickBestDtphxMatch(title: string, cards: DtphxCard[]): { card: DtphxCard; score: number } | undefined {
  const candidates = cards.filter((card) => shorterTitleFullyContained(title, card.title));
  if (candidates.length === 0) return undefined;
  let best = candidates[0];
  let bestScore = -1;
  for (const card of candidates) {
    const score = simpleTitleSimilarity(title, card.title);
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return { card: best, score: bestScore };
}

function buildDtphxEventFacts(card: DtphxCard): Fact[] {
  const facts: Fact[] = [];
  const source = 'Downtown Phoenix (DTPHX.org) — events calendar';
  const sourceUrl = card.detailUrl || DTPHX_CALENDAR_URL;

  if (card.venue) facts.push({ field: 'venueName', value: card.venue, source, sourceUrl });

  const dateValue = [card.dow, [card.month, card.day].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (dateValue) facts.push({ field: 'date', value: dateValue, source, sourceUrl });

  if (card.time) facts.push({ field: 'time', value: card.time, source, sourceUrl });
  if (card.detailUrl) facts.push({ field: 'ticketUrl', value: card.detailUrl, source, sourceUrl });

  return facts;
}

/**
 * Same three-step shape as the WUEV checker above: fetch the one calendar
 * page, parse every card, pick the closest title match, and require it to
 * clear DTPHX_MIN_MATCH_SCORE before attaching facts.
 */
async function gatherDtphxEventSources(topic: TopicInput): Promise<SourceGatheringResult> {
  console.log(`[source-gathering] dtphx: fetching ${DTPHX_CALENDAR_URL}`);
  const raw = await fetchRawHtml(DTPHX_CALENDAR_URL);
  if (!raw) {
    const checkerNote = `Could not fetch ${DTPHX_CALENDAR_URL} (dtphx.org events calendar).`;
    console.warn(`[source-gathering] dtphx: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  const cards = parseDtphxCards(raw.html);
  console.log(`[source-gathering] dtphx: parsed ${cards.length} listing card(s) via ${raw.method}`);

  const bestMatch = pickBestDtphxMatch(topic.title, cards);
  if (!bestMatch || bestMatch.score < DTPHX_MIN_MATCH_SCORE) {
    const checkerNote = bestMatch
      ? `No dtphx match for "${topic.title}" — closest candidate "${bestMatch.card.title}" scored ${bestMatch.score.toFixed(2)}, below the ${DTPHX_MIN_MATCH_SCORE} threshold.`
      : cards.length > 0
        ? `Parsed ${cards.length} dtphx listing card(s), but none share every word of "${topic.title}" — no confident match.`
        : `No dtphx listing cards parsed from ${DTPHX_CALENDAR_URL}.`;
    console.log(`[source-gathering] dtphx: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  console.log(`[source-gathering] dtphx: best match = "${bestMatch.card.title}" (score=${bestMatch.score.toFixed(2)})`);
  const facts = buildDtphxEventFacts(bestMatch.card);
  return { topic, facts, primarySourceFound: facts.length > 0, factCount: facts.length };
}

/**
 * Ticketmaster first (clean, free, structured, zero HTML scraping); then
 * WUEV; then dtphx; only then the existing SerpAPI-based gatherEventSources
 * as final fallback — same tiered, try-until-a-confident-match pattern as
 * the Ticketmaster→SerpAPI tiering already had, just with two more real
 * sources spliced into the middle. Each tier is unchanged by this addition:
 * gatherTicketmasterEventSources and gatherEventSources keep their original
 * bodies untouched above.
 */
async function gatherEventSourcesTiered(topic: TopicInput): Promise<SourceGatheringResult> {
  const tm = await gatherTicketmasterEventSources(topic);
  if (tm.factCount > 0) {
    return tm;
  }
  console.log(
    `[source-gathering] events: Ticketmaster had no usable match (${tm.checkerNote || 'no reason given'}) — trying WUEV.`
  );

  const wuev = await gatherWuevEventSources(topic);
  if (wuev.factCount > 0) {
    return wuev;
  }
  console.log(
    `[source-gathering] events: WUEV had no usable match (${wuev.checkerNote || 'no reason given'}) — trying dtphx.`
  );

  const dtphx = await gatherDtphxEventSources(topic);
  if (dtphx.factCount > 0) {
    return dtphx;
  }
  console.log(
    `[source-gathering] events: dtphx had no usable match (${dtphx.checkerNote || 'no reason given'}) — falling back to SerpAPI events checker.`
  );

  return gatherEventSources(topic);
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
type FetchCandidate = { url: string; label: string };

/**
 * topic.link first, then topic.searchSummaries URLs in order — a
 * fallback chain, not a fetch-everything sweep. topic.link is sometimes
 * a client-rendered discovery/widget URL with no real content, while
 * Stage 1's web_search already turned up better primary sources in
 * searchSummaries (confirmed tonight: an azcentral.com "Things To Do"
 * widget link vs. arizonarestaurantweek.com's own FAQ page with the
 * real dates).
 */
function buildFetchCandidates(topic: TopicInput): FetchCandidate[] {
  const candidates: FetchCandidate[] = [];
  const seen = new Set<string>();

  const add = (url: string | undefined, label: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, label });
  };

  add(topic.link, 'topic.link (primary)');
  for (const s of topic.searchSummaries || []) {
    add(s?.url, 'searchSummaries fallback');
  }

  return candidates;
}

async function gatherDefaultSources(topic: TopicInput): Promise<SourceGatheringResult> {
  const candidates = buildFetchCandidates(topic);
  if (candidates.length === 0) {
    const checkerNote = 'No topic.link or searchSummaries URLs available — the default checker requires at least one source URL to fetch.';
    console.warn(`[source-gathering] default: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  let chosen: { url: string; pageResult: { text: string; method: 'http' | 'playwright' } } | null = null;
  let fallbackChoice: { url: string; pageResult: { text: string; method: 'http' | 'playwright' } } | null = null;

  for (const candidate of candidates) {
    console.log(`[source-gathering] default: trying ${candidate.label} — ${candidate.url}`);
    const pageResult = await fetchVenuePageText(candidate.url);
    if (!pageResult || pageResult.text.length <= 80) {
      console.log(`[source-gathering] default: nothing usable from ${candidate.url}`);
      continue;
    }
    if (isMeaningfulProseText(pageResult.text)) {
      console.log(`[source-gathering] default: substantial content found at ${candidate.url} — stopping fallback chain here.`);
      chosen = { url: candidate.url, pageResult };
      break;
    }
    // Not substantial, but keep the first non-empty fetch as a last-resort
    // fallback in case every candidate (including searchSummaries) is thin —
    // a thin fact is still better than nothing for a 'blurb'-level decision.
    if (!fallbackChoice) {
      fallbackChoice = { url: candidate.url, pageResult };
    }
    console.log(`[source-gathering] default: ${candidate.url} fetched but not substantial (${pageResult.text.length} chars) — trying next candidate if any.`);
  }

  const final = chosen ?? fallbackChoice;
  if (!final) {
    const checkerNote = `Fetched nothing usable from ${candidates.length} candidate URL(s) (topic.link + searchSummaries).`;
    console.warn(`[source-gathering] default: ${checkerNote}`);
    return { topic, facts: [], primarySourceFound: false, factCount: 0, checkerNote };
  }

  const outlet = deriveOutletName(final.url);
  const source = `${outlet} — ${final.pageResult.method === 'playwright' ? 'Playwright render' : 'HTTP fetch'} (${final.url})`;

  const facts: Fact[] = [
    { field: 'sourceArticleText', value: final.pageResult.text, source, sourceUrl: final.url },
    WRITING_GUIDANCE_FACT,
  ];

  console.log(
    `[source-gathering] default: fetched via ${final.pageResult.method} (${final.pageResult.text.length} chars) from ${outlet} — ${final.url}${chosen ? '' : ' (fallback: not substantial, used as best available)'}`
  );
  return {
    topic,
    facts,
    primarySourceFound: true,
    factCount: facts.length,
    sourceArticleTextSubstantial: chosen != null,
  };
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
  events: gatherEventSourcesTiered,
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

/**
 * Small/local real events picked specifically to exercise the WUEV and
 * dtphx tiers — none of these are the kind of touring/ticketed show
 * Ticketmaster would carry, so (assuming Ticketmaster has no match, logged
 * per-topic below) the tier should fall through to WUEV or dtphx and stop
 * there, never reaching the SerpAPI fallback. Confirmed live on the
 * respective listing pages as of 2026-08-17.
 */
const WUEV_DTPHX_TEST_TOPICS: TopicInput[] = [
  {
    title: 'Popsicle Popup Party',
    snippet: 'East Valley Moms brings its free Popsicle Popup Party to Eastmark Great Park in Mesa, AZ.',
    section: 'family',
    verdict: 'direct-local',
    subjectTag: 'community event',
    location: 'Mesa, AZ',
  },
  {
    title: 'Free Summer Concert: Stilicho the Band',
    snippet: 'A free evening of traditional Irish music at Chandler Community Center as part of the Chandler summer concert series.',
    section: 'nightlife',
    verdict: 'direct-local',
    subjectTag: 'concert',
    location: 'Chandler, AZ',
  },
  {
    title: 'Comedy Rumble: Gilbert Edition',
    snippet: "An audience-powered stand-up comedy tournament at JP's Comedy Club in Gilbert, AZ.",
    section: 'nightlife',
    verdict: 'direct-local',
    subjectTag: 'comedy show',
    location: 'Gilbert, AZ',
  },
  {
    title: 'Trivia Night at GenuWine Arizona Wine Bar',
    snippet: 'Weekly trivia night at GenuWine Arizona Wine Bar in downtown Phoenix, AZ.',
    section: 'nightlife',
    verdict: 'direct-local',
    subjectTag: 'trivia',
    location: 'Phoenix, AZ',
  },
];

/** Which tier actually resolved a result — derived from facts[0].source (each checker tags its own facts distinctly), for the tier-skip check in the test report. */
function resolvedTierLabel(result: SourceGatheringResult): string {
  const src = result.facts[0]?.source;
  if (!src) return '(no match — checkerNote: ' + (result.checkerNote ?? 'none') + ')';
  if (src.includes('Ticketmaster')) return 'Ticketmaster';
  if (src.includes('What\'s Up East Valley')) return 'WUEV';
  if (src.includes('Downtown Phoenix')) return 'dtphx';
  if (src.includes('SerpAPI')) return 'SerpAPI';
  return src;
}

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

  console.log('\n[source-gathering] --- WUEV/dtphx tier: 4 small/local real events Ticketmaster likely can\'t cover ---');
  const wuevDtphxResults: { topic: TopicInput; result: SourceGatheringResult }[] = [];
  for (const topic of WUEV_DTPHX_TEST_TOPICS) {
    console.log(`\n[source-gathering] --- Testing: "${topic.title}" ---`);
    const result = await gatherSources(topic);
    wuevDtphxResults.push({ topic, result });
    console.log(
      `[source-gathering] "${topic.title}" → factCount=${result.factCount}, primarySourceFound=${result.primarySourceFound}, resolvedTier=${resolvedTierLabel(result)}`
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
    wuevDtphxResults,
    bonusNonEventCheck: { topic: BONUS_NON_EVENT_TOPIC, result: bonusResult },
  });

  console.log('\n\n########## SOURCE GATHERING TEST HARNESS SUMMARY ##########');
  for (const { topic, result } of results) {
    console.log(`\n--- ${topic.title} ---`);
    console.log(`factCount=${result.factCount} primarySourceFound=${result.primarySourceFound} resolvedTier=${resolvedTierLabel(result)}`);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log('\n########## WUEV/DTPHX TIER RESULTS ##########');
  for (const { topic, result } of wuevDtphxResults) {
    console.log(`\n--- ${topic.title} ---`);
    console.log(`factCount=${result.factCount} primarySourceFound=${result.primarySourceFound} resolvedTier=${resolvedTierLabel(result)}`);
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

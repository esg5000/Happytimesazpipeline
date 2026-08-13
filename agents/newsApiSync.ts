import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { config } from '../config';
import {
  getExistingNewsSourceUrls,
  getExistingSlugs,
  parseGoogleNewsSlotId,
  publishGoogleNewsArticleToSanity,
  resolveGoogleNewsPrimaryCategorySlug,
  uploadImageBufferToSanity,
} from './sanityPublisher';
import { Article, validateArticle } from '../utils/validator';
import { ensureUniqueSlug, generateSlug } from '../utils/slug';
import { generateImage, generateImagePrompt } from './imageAgent';
import { fetchUnsplashHeroImageBuffer } from './unsplashHero';
import { scoreArticleQuality } from './editorAgent';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

/** SerpApi `num` — cap news results per query (default is much higher). Wired to GOOGLE_NEWS_MAX_FETCH via config. */
const SERP_NEWS_NUM = config.googleNews.maxFetch;
/** After per-slot URL dedupe, keep at most this many candidates (newest first) before OpenAI scoring. */
const SLOT_CANDIDATE_POOL_CAP = 10;

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'googleNewsRewrite.prompt.txt');

/** OpenAI model for SerpApi Google News candidate scoring + topic/exclude gate. */
const OPENAI_MODEL_GOOGLE_NEWS_SCORE = 'gpt-5.4-mini';
/** OpenAI model for SerpApi Google News article rewrite → HappyTimesAZ JSON. */
const OPENAI_MODEL_GOOGLE_NEWS_REWRITE = 'gpt-5.4-mini';

/** Slot 1 — Arizona/Phoenix Local News */
const SLOT1_LOCAL_QUERIES = [
  'Phoenix local news today',
  'Arizona community news today',
  'Valley Arizona news today',
  'Phoenix city news today',
] as const;

/** Slot 3 — Food, Nightlife and Lifestyle */
const SLOT3_LIFESTYLE_QUERIES = [
  'Phoenix restaurants new openings today',
  'Scottsdale nightlife bars Phoenix today',
  'Phoenix things to do this week',
  'Valley food drink events Arizona today',
  'Phoenix wellness fitness lifestyle today',
] as const;

/** Slot 4 — Cannabis Arizona */
const SLOT4_CANNABIS_AZ_QUERIES = [
  'Arizona cannabis dispensary news today',
  'Phoenix dispensary deals Arizona today',
  'Arizona marijuana law today',
  'cannabis Arizona local news today',
] as const;

/** Slot 5 — Cannabis National */
const SLOT5_CANNABIS_NATIONAL_QUERIES = [
  'cannabis federal law news today',
  'marijuana legalization state law today',
  'THC delta-9 legislation news today',
  'cannabis industry trends today',
  'marijuana policy news today',
] as const;

const HARD_LOCAL_NEWS_RE =
  /\b(city council|city of phoenix|city of scottsdale|city of tempe|mayor|maricopa county|board of supervisors|DPS|ADOT|flood warning|power outage|water main|school board|bond measure|ballot measure|prop\s*\d+|lane closure|road closure|brush fire|wildfire|red flag|heat warning|excessive heat|i-10|i-17|loop\s*101|sr\s*51|valley metro|light rail|transit delay|public safety|missing (child|person)|amber alert|evacuation|shooting|homicide|arrested|charged|sentenced)\b/i;

/** Fast reject before AI — crime, tragedy, serious accidents, national partisan frame (headline-level). */
const NEGATIVE_HEADLINE_RE =
  /murder|homicide|mass\s*shooting|killed in (a )?shooting|fatal (crash|collision|accident)|deadly (crash|collision|wreck)|terror(ist|ism)?|suicide|sexual assault|kidnap|rape\b|school\s*shooting|armed robbery|stabbed|shot dead|police\s+shooting|charged with|sentenced to|arrested for|domestic violence|child abuse|overdose death|capitol\s*riot|january\s*6|impeachment|white\s*house|mar[- ]a[- ]lago|\bGOP\b|\bDNC\b|presidential\s*campaign|midterm\s*election|election\s*fraud|stop\s*the\s*steal|congressional\s*hearing|supreme\s*court\s*(rules?|decides)/i;

type SerpGoogleNewsItem = {
  title: string;
  link: string;
  thumbnail: string | null;
  snippet?: string;
  /** Parsed from SerpApi when available (iso_date or relative date string). */
  publishedAt?: Date;
};

type SerpGoogleNewsResponse = {
  search_metadata?: { status?: string };
  error?: string;
  news_results?: unknown[];
};

type ScoreResult = {
  relevanceScore: number;
  exclude: boolean;
  excludeReason?: string;
  /** Same real-world event/thread → same key (max one article per run). */
  topicDedupeKey?: string;
  /**
   * Slot 3 only: Sanity category slug chosen by scorer — exactly one of
   * food | nightlife | health-wellness.
   */
  category?: string;
};

/** Phoenix metro core sports — never exclude; floor score 7 (enforced after model scores). */
const LOCAL_CORE_SPORTS_RE =
  /\bphoenix\s+suns\b|\barizona\s+cardinals\b|\barizona\s+diamondbacks\b|\barizona\s+coyotes\b|\basu\s+sun\s+devils\b|\bsun\s+devils\b/i;

function isLocalCoreSportsItem(item: SerpGoogleNewsItem): boolean {
  return LOCAL_CORE_SPORTS_RE.test(`${item.title}\n${item.snippet || ''}`);
}

function applyGoogleNewsScoringOverrides(
  item: SerpGoogleNewsItem,
  gate: ScoreResult
): ScoreResult {
  const blob = `${item.title}\n${item.snippet || ''}`;
  if (LOCAL_CORE_SPORTS_RE.test(blob)) {
    return {
      relevanceScore: Math.max(7, gate.relevanceScore),
      exclude: false,
      excludeReason: undefined,
    };
  }
  return { ...gate };
}

async function generateAndUploadHeroForGoogleNews(
  article: Article,
  sectionSlug: string,
  filenameBase: string,
  label: string
): Promise<string | undefined> {
  // Try Unsplash first
  const unsplashBuf = await fetchUnsplashHeroImageBuffer(article.title, sectionSlug);
  if (unsplashBuf) {
    console.log(`[google-news] ${label} hero from Unsplash → Sanity`);
    const heroId = await uploadImageBufferToSanity(
      unsplashBuf,
      filenameBase.replace(/\.jpg$/, '-unsplash.jpg')
    );
    console.log(`[google-news] ${label} hero asset (Unsplash)=${heroId}`);
    return heroId;
  }

  // Fall back to gpt-image-1
  const headline = article.title.trim();
  const modelScene =
    typeof article.heroImagePrompt === 'string' && article.heroImagePrompt.trim().length >= 20
      ? article.heroImagePrompt.trim()
      : 'Photorealistic editorial photograph suited to the headline; Arizona / greater Phoenix context where appropriate.';
  const basePrompt = `HappyTimesAZ ${sectionSlug} (greater Phoenix, Arizona metro): "${headline}".\n\nHero scene direction: ${modelScene}\n\nNo overlaid text, watermarks, third-party logos, or identifiable news outlet branding in the image.`;

  console.log(`[google-news] ${label} Unsplash returned nothing; falling back to gpt-image-1 (section=${sectionSlug})`);
  const enhanced = await generateImagePrompt(basePrompt, article.visualStyle);
  const imageBuf = await generateImage(enhanced);
  if (!imageBuf) {
    console.warn(`[google-news] ${label} gpt-image-1 also failed; continuing without hero`);
    return undefined;
  }
  console.log(`[google-news] ${label} hero from gpt-image-1 → Sanity`);
  const heroId = await uploadImageBufferToSanity(imageBuf, filenameBase);
  console.log(`[google-news] ${label} hero asset (gpt-image-1)=${heroId}`);
  return heroId;
}

function parseRelativeNewsDate(s: string): Date | undefined {
  const t = Date.now();
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const u = m[2]!.toLowerCase();
    const ms =
      u.startsWith('minute')
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
  return undefined;
}

function parseItemPublishedAt(src: Record<string, unknown>): Date | undefined {
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

function isStoryOlderThan7Days(item: SerpGoogleNewsItem): boolean {
  const p = item.publishedAt;
  if (!p) return false;
  return Date.now() - p.getTime() > 7 * 24 * 3600 * 1000;
}

function isStoryWithin48Hours(item: SerpGoogleNewsItem): boolean {
  const p = item.publishedAt;
  if (!p) return false;
  const age = Date.now() - p.getTime();
  return age >= 0 && age <= 48 * 3600 * 1000;
}

function flattenGoogleNewsResults(raw: unknown[] | undefined): SerpGoogleNewsItem[] {
  const out: SerpGoogleNewsItem[] = [];
  const seen = new Set<string>();

  const push = (
    title: unknown,
    link: unknown,
    thumbnail: unknown | undefined,
    snippet: unknown | undefined,
    dateSrc?: Record<string, unknown>
  ) => {
    if (typeof title !== 'string' || typeof link !== 'string' || !link.startsWith('http')) return;
    if (seen.has(link)) return;
    seen.add(link);
    const publishedAt = dateSrc ? parseItemPublishedAt(dateSrc) : undefined;
    out.push({
      title,
      link,
      thumbnail: typeof thumbnail === 'string' ? thumbnail : null,
      snippet: typeof snippet === 'string' ? snippet : undefined,
      publishedAt,
    });
  };

  for (const entry of raw || []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (e.highlight && typeof e.highlight === 'object') {
      const h = e.highlight as Record<string, unknown>;
      push(h.title, h.link, h.thumbnail, h.snippet, h);
    }

    if (Array.isArray(e.stories)) {
      for (const st of e.stories) {
        if (st && typeof st === 'object') {
          const s = st as Record<string, unknown>;
          const merged: Record<string, unknown> = { ...s };
          if (merged.iso_date == null && typeof e.iso_date === 'string') merged.iso_date = e.iso_date;
          if (merged.date == null && typeof e.date === 'string') merged.date = e.date;
          push(s.title, s.link, s.thumbnail, s.snippet, merged);
        }
      }
    }

    if (!Array.isArray(e.stories) && e.title && e.link) {
      push(e.title, e.link, e.thumbnail, e.snippet, e);
    }
  }

  return out;
}

async function openAiJson<T>(system: string, user: string, model: string): Promise<T> {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}

async function scoreAndGate(
  item: SerpGoogleNewsItem,
  label: string,
  slotRules?: string
): Promise<ScoreResult> {
  const text = [item.title, item.snippet || ''].join('\n\n').slice(0, 12000);
  console.log(
    `[google-news] ${label} → OpenAI (${OPENAI_MODEL_GOOGLE_NEWS_SCORE}): relevance scoring + topic/exclude gate…`
  );

  const systemBase = `You are an editor for HappyTimesAZ, a Phoenix AZ local lifestyle site covering the **greater Phoenix metro** (e.g. Phoenix, Scottsdale, Tempe, Mesa, Glendale, Peoria, Chandler, Gilbert, Surprise, Goodyear, Sun City, Fountain Hills, Cave Creek, Paradise Valley).

Score how relevant and valuable this story is for **local readers** (1–10). **Strongly prefer** when the angle fits: feel-good **community** stories; **local heroes** and **charity**; **food & dining** openings; **arts & culture**; **local business** and **entrepreneurs**; **health & wellness**; **real estate / development**; **tourism & attractions**; **parks & outdoor** activities; **local people** profiles; **Arizona / local policy** that affects daily life (**schools**, **city** decisions, **infrastructure**, **housing**, **local government** initiatives)—not national partisan noise.

**LOCAL PRO & COLLEGE SPORTS (MANDATORY):** Coverage of **Phoenix Suns**, **Arizona Cardinals**, **Arizona Diamondbacks**, **Arizona Coyotes**, or **ASU Sun Devils** (games, trades, injuries, standings, arena/stadium, Valley fan angle) is **core HappyTimesAZ content**. For those teams you MUST set **exclude=false** and **relevanceScore ≥ 7** (use 7–10 when the story is genuinely about the team or game).

**NATIONAL POLITICAL FIGURE — IN-PERSON VALLEY EVENT:** If a **national political figure** held or will hold a **rally, speech, fundraiser, or public event physically in the greater Phoenix metro** (not a generic national op-ed), treat it as **local news** because of **local impact** (traffic/road closures, venue, security, Valley attendance, local business, community reaction). Score **6–7** when that local-event frame is clear. Do **NOT** set **exclude=true** *only* because the story involves national politics if the **event happened or will happen in person in the Valley**.

Set **exclude=true** if the story is mainly: **crime**, **violence**, **tragedy**, **serious accidents**; **pure national** partisan noise with **no** Phoenix-area hook; **war**; **celebrity gossip** with no Arizona tie; or **remote** national political commentary with **no** in-person Valley event angle.

**topicDedupeKey** (required): a short stable identifier for the **one** main real-world story thread or event (use lowercase words separated by underscores, 2–8 segments, ≤80 chars). Every article about the **same** rally, game, press conference, or incident must reuse the **identical** key (e.g. three headlines about the same Trump rally in Phoenix → same key). Unrelated stories → different keys.

Return JSON only:
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <short string or omit>, "topicDedupeKey": "<string>"}`;

  const system =
    systemBase +
    (slotRules && slotRules.trim()
      ? `\n\n--- SLOT-SPECIFIC RULES (apply strictly) ---\n${slotRules.trim()}`
      : '');

  const user = `Headline & snippet:\n${text}\n\nSource URL: ${item.link}`;

  const raw = await openAiJson<ScoreResult>(system, user, OPENAI_MODEL_GOOGLE_NEWS_SCORE);
  const relevanceScore = Math.min(10, Math.max(1, Math.round(Number(raw.relevanceScore)) || 1));
  let topicDedupeKey: string | undefined;
  if (typeof raw.topicDedupeKey === 'string' && raw.topicDedupeKey.trim()) {
    topicDedupeKey = raw.topicDedupeKey
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 80);
    if (!topicDedupeKey) topicDedupeKey = undefined;
  }
  let category: string | undefined;
  if (typeof raw.category === 'string' && raw.category.trim()) {
    category = raw.category.trim().toLowerCase();
  }

  const result: ScoreResult = {
    relevanceScore,
    exclude: Boolean(raw.exclude),
    excludeReason: raw.excludeReason,
    topicDedupeKey,
    ...(category ? { category } : {}),
  };
  console.log(
    `[google-news] ${label} → score: relevanceScore=${result.relevanceScore}, exclude=${result.exclude}` +
      (result.excludeReason ? `, excludeReason="${result.excludeReason}"` : '') +
      (result.category ? `, category=${result.category}` : '')
  );
  return result;
}

const SEO_TITLE_MAX = 70;

function truncateSeoTitleIfNeeded(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const o = raw as Record<string, unknown>;
  const s = o.seoTitle;
  if (typeof s !== 'string') return;
  if (s.length <= SEO_TITLE_MAX) return;
  const cut = s.slice(0, SEO_TITLE_MAX).trimEnd();
  o.seoTitle = cut.length >= 10 ? cut : s.slice(0, SEO_TITLE_MAX);
  console.log(
    `[google-news] seoTitle exceeded ${SEO_TITLE_MAX} chars; truncated before validation (${s.length} → ${(o.seoTitle as string).length})`
  );
}

const BODY_MARKDOWN_SAFETY_MAX = 6800;
const EXCERPT_SAFETY_MAX = 190;
const BODY_MARKDOWN_SCHEMA_MIN = 500;

/** Truncate at the last complete sentence ending at or before `maxLen` (., !, ? followed by space/end). */
function truncateBodyMarkdownAtLastSentence(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;
  const window = body.slice(0, maxLen);
  let bestCut = -1;
  for (let i = 0; i < window.length; i++) {
    const ch = window[i]!;
    if (
      (ch === '.' || ch === '!' || ch === '?') &&
      (i === window.length - 1 || /\s/.test(window[i + 1]!))
    ) {
      bestCut = i + 1;
    }
  }
  if (bestCut >= BODY_MARKDOWN_SCHEMA_MIN) return window.slice(0, bestCut).trimEnd();
  return window.trimEnd();
}

/** Truncate at the last word boundary at or before `maxLen`. */
function truncateExcerptAtLastWord(excerpt: string, maxLen: number): string {
  if (excerpt.length <= maxLen) return excerpt;
  const slice = excerpt.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  let out = lastSpace > 20 ? slice.slice(0, lastSpace).trimEnd() : slice.trimEnd();
  if (out.length < 50 && excerpt.length >= 50) {
    out = excerpt.slice(0, maxLen).trimEnd();
  }
  return out;
}

function truncateRewriteLengthsIfNeeded(raw: unknown, label: string): void {
  if (!raw || typeof raw !== 'object') return;
  const o = raw as Record<string, unknown>;
  const body = o.bodyMarkdown;
  if (typeof body === 'string' && body.length > BODY_MARKDOWN_SAFETY_MAX) {
    const next = truncateBodyMarkdownAtLastSentence(body, BODY_MARKDOWN_SAFETY_MAX);
    console.warn(
      `[google-news] ${label} bodyMarkdown safety truncate: ${body.length} → ${next.length} chars (cap ${BODY_MARKDOWN_SAFETY_MAX})`
    );
    o.bodyMarkdown = next;
  }
  const ex = o.excerpt;
  if (typeof ex === 'string' && ex.length > EXCERPT_SAFETY_MAX) {
    const next = truncateExcerptAtLastWord(ex, EXCERPT_SAFETY_MAX);
    console.warn(
      `[google-news] ${label} excerpt safety truncate: ${ex.length} → ${next.length} chars (cap ${EXCERPT_SAFETY_MAX})`
    );
    o.excerpt = next;
  }
}

async function rewriteArticle(item: SerpGoogleNewsItem, label: string): Promise<Article> {
  console.log(
    `[google-news] ${label} → AI rewrite starting (model=${OPENAI_MODEL_GOOGLE_NEWS_REWRITE})`
  );
  const systemBase = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
  const basis = [
    `Title: ${item.title}`,
    item.snippet ? `Snippet: ${item.snippet}` : '',
    `Link: ${item.link}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const user = `Rewrite this into a full HappyTimesAZ article JSON.\n\n${basis}`;

  const parsed = await openAiJson<Record<string, unknown>>(
    systemBase,
    user,
    OPENAI_MODEL_GOOGLE_NEWS_REWRITE
  );

  truncateSeoTitleIfNeeded(parsed);
  truncateRewriteLengthsIfNeeded(parsed, label);

  if (parsed && typeof parsed === 'object' && 'title' in parsed) {
    const o = parsed as { title: string; slug?: string };
    if (!o.slug?.trim()) {
      o.slug = generateSlug(o.title);
    }
  }

  const validation = validateArticle(parsed);
  if (!validation.success) {
    throw new Error(`Rewrite validation failed: ${validation.errors?.join(', ')}`);
  }

  console.log(
    `[google-news] ${label} → AI rewrite done: slug=${validation.data!.slug}`
  );
  return validation.data!;
}

async function rewriteArticleWithSlotRules(
  item: SerpGoogleNewsItem,
  label: string,
  slotRewriteRules?: string
): Promise<Article> {
  const hadSlotRules = Boolean(slotRewriteRules?.trim());
  try {
    if (!hadSlotRules) {
      return await rewriteArticle(item, label);
    }
    const systemBase = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
    const system =
      systemBase +
      `\n\n--- SLOT-SPECIFIC REWRITE RULES (apply strictly) ---\n${slotRewriteRules!.trim()}\n`;

    console.log(
      `[google-news] ${label} → AI rewrite starting (model=${OPENAI_MODEL_GOOGLE_NEWS_REWRITE}, slotRules=yes)`
    );
    const basis = [
      `Title: ${item.title}`,
      item.snippet ? `Snippet: ${item.snippet}` : '',
      `Link: ${item.link}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const user = `Rewrite this into a full HappyTimesAZ article JSON.\n\n${basis}`;

    const parsed = await openAiJson<Record<string, unknown>>(
      system,
      user,
      OPENAI_MODEL_GOOGLE_NEWS_REWRITE
    );

    truncateSeoTitleIfNeeded(parsed);
    truncateRewriteLengthsIfNeeded(parsed, label);

    if (parsed && typeof parsed === 'object' && 'title' in parsed) {
      const o = parsed as { title: string; slug?: string };
      if (!o.slug?.trim()) {
        o.slug = generateSlug(o.title);
      }
    }

    const validation = validateArticle(parsed);
    if (!validation.success) {
      throw new Error(`Rewrite validation failed: ${validation.errors?.join(', ')}`);
    }

    console.log(
      `[google-news] ${label} → AI rewrite done: slug=${validation.data!.slug}`
    );
    return validation.data!;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error && e.stack ? e.stack : '(no stack)';
    console.error(`[google-news] ${label} rewriteArticleWithSlotRules failed: ${msg}`);
    console.error(stack);
    if (!hadSlotRules) {
      throw e;
    }
    console.warn(
      `[google-news] ${label} → falling back to base rewrite prompt (slot-specific rules skipped)`
    );
    return rewriteArticle(item, label);
  }
}

function passesKeywordGate(item: SerpGoogleNewsItem): boolean {
  const blob = `${item.title}\n${item.snippet || ''}`;
  if (NEGATIVE_HEADLINE_RE.test(blob)) return false;
  return true;
}

async function fetchSerpGoogleNews(
  q: string,
  label: string,
  usage: SerpRunUsage
): Promise<{ data: SerpGoogleNewsResponse; httpStatus: number }> {
  usage.apiCalls += 1;
  console.log(`[google-news] ${label}: calling GET ${SERPAPI_SEARCH}`);
  console.log(
    `[google-news] ${label}: params engine=google_news, gl=us, hl=en, num=${SERP_NEWS_NUM}`
  );
  console.log(`[google-news] ${label}: q (exact)= ${q}`);

  const { data, status } = await axios.get<SerpGoogleNewsResponse>(SERPAPI_SEARCH, {
    params: {
      engine: 'google_news',
      api_key: config.serpApi.apiKey,
      q,
      gl: 'us',
      hl: 'en',
      num: SERP_NEWS_NUM,
    },
    validateStatus: () => true,
  });

  const metaStatus = data.search_metadata?.status ?? 'n/a';
  const n = data.news_results?.length ?? 0;
  console.log(
    `[google-news] ${label}: httpStatus=${status}, search_metadata.status=${metaStatus}, news_results.length=${n}`
  );

  // Detection parity with agents/serpApiEventsSync.ts's fetchEventsForCity: a
  // non-200 or an `error` field (SerpApi represents "no results for this
  // query" via this same field, not just true failures) is a thrown
  // exception, not a silently-swallowed warning. Caught per-query by
  // fetchSlotCandidatePool below, which counts it distinctly from
  // scoring/publish errors.
  if (status !== 200) {
    throw new Error(`SerpApi HTTP ${status}: ${data.error || 'request failed'}`);
  }
  if (data.error) {
    throw new Error(data.error);
  }

  return { data, httpStatus: status };
}

type RunCounters = {
  skipped: number;
  errors: number;
  /** SerpApi fetch failures specifically (non-200 or an `error` field) — distinct from scoring/publish errors above, so a run where every query fails is visibly different from a run with a few unrelated publish errors. */
  serpApiErrors: number;
  /** A few example SerpApi error messages from this run, capped — not every failure, just enough to diagnose. */
  serpApiErrorSample: string[];
};

const SERP_ERROR_SAMPLE_MAX = 5;

/** Counts each HTTP request to SerpApi in this sync run (for usage tracking). */
type SerpRunUsage = { apiCalls: number };

type PickedSlotStory = {
  item: SerpGoogleNewsItem;
  gate: ScoreResult;
  label: string;
  slotLog: string;
};

type Slot2Mode = 'diamondbacks' | 'cardinals' | 'asu' | 'sunday_mix';

function getPhoenixCalendarWeekday0Sun(now: Date): number {
  const w = now.toLocaleString('en-US', { timeZone: 'America/Phoenix', weekday: 'short' });
  const head = w.slice(0, 3).toLowerCase();
  const map: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return map[head] ?? now.getDay();
}

function getPhoenixYmdMonthLongYear(now: Date): { ymd: string; monthLong: string; year: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Phoenix',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const monthLong = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix',
    month: 'long',
  }).format(now);
  const year = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', year: 'numeric' }).format(now),
    10
  );
  return { ymd, monthLong, year };
}

function getSlot2Mode(now: Date): { mode: Slot2Mode; teamLabel: string } {
  const d = getPhoenixCalendarWeekday0Sun(now);
  if (d === 1 || d === 4) return { mode: 'diamondbacks', teamLabel: 'Arizona Diamondbacks' };
  if (d === 2 || d === 5) return { mode: 'cardinals', teamLabel: 'Arizona Cardinals' };
  if (d === 3 || d === 6) return { mode: 'asu', teamLabel: 'ASU Sun Devils' };
  return { mode: 'sunday_mix', teamLabel: 'Arizona sports' };
}

function buildSlot2Queries(mode: Slot2Mode, teamLabel: string, year: number): readonly string[] {
  if (mode === 'sunday_mix') {
    return [
      'Arizona Coyotes news today',
      'Arizona Diamondbacks news today',
      'Phoenix Rising FC news today',
      'Arizona Cardinals news today',
      'ASU Sun Devils news today',
    ];
  }
  return [`${teamLabel} news today`, `${teamLabel} latest update`, `${teamLabel} Arizona ${year}`];
}

function slot2Prefilter(item: SerpGoogleNewsItem, mode: Slot2Mode): boolean {
  const b = `${item.title}\n${item.snippet || ''}`;
  if (/\bphoenix\s+suns\b|\bphx\s+suns\b/i.test(b)) return false;
  if (/\bsuns\b/i.test(b) && /\bnba\b/i.test(b)) return false;
  if (mode === 'sunday_mix') {
    return /coyotes|diamondbacks|dbacks|cardinals|sun\s+devils|\basu\b|rising\s+fc|mercury|wnba/i.test(b);
  }
  if (mode === 'diamondbacks') return /diamondbacks|dbacks|mlb|chase/i.test(b);
  if (mode === 'cardinals') return /cardinals|nfl|kyler|glendale/i.test(b);
  if (mode === 'asu') return /\basu\b|sun\s+devils/i.test(b);
  return false;
}

/** Slot 1 (local news): strictly non-sports Phoenix/Arizona local — drop obvious sports stories before scoring. */
function nonSportsLocalPrefilter(item: SerpGoogleNewsItem): boolean {
  const b = `${item.title}\n${item.snippet || ''}`;
  if (LOCAL_CORE_SPORTS_RE.test(b)) return false;
  if (
    /\b(nfl|nba|mlb|nhl|wnba|ncaa|mls|super bowl|world series|stanley cup|final four|march madness|playoff|playoffs|overtime|touchdown|quarterback|pitcher|home run|hat trick|starting lineup|injury report|trade deadline|nba draft|nfl draft|game recap|box score)\b/i.test(
      b
    )
  ) {
    return false;
  }
  return true;
}

/** Slot 3 (lifestyle): drop core-sports and hard local-news stories before scoring. */
function lifestylePrefilter(item: SerpGoogleNewsItem): boolean {
  const blob = `${item.title}\n${item.snippet || ''}`;
  if (LOCAL_CORE_SPORTS_RE.test(blob)) return false;
  if (HARD_LOCAL_NEWS_RE.test(blob)) return false;
  return true;
}

/** Keep newest `max` items by `publishedAt`; undated items sort last. */
function capSlotPoolByRecency(items: SerpGoogleNewsItem[], max: number): SerpGoogleNewsItem[] {
  if (items.length <= max) return items;
  const tagged = items.map((it, idx) => ({ it, idx }));
  tagged.sort((a, b) => {
    const ta = a.it.publishedAt?.getTime();
    const tb = b.it.publishedAt?.getTime();
    if (ta != null && tb != null && tb !== ta) return tb - ta;
    if (ta != null && tb == null) return -1;
    if (ta == null && tb != null) return 1;
    return a.idx - b.idx;
  });
  return tagged.slice(0, max).map((x) => x.it);
}

async function fetchSlotCandidatePool(
  queries: readonly string[],
  slotTag: string,
  usage: SerpRunUsage,
  counters: RunCounters
): Promise<SerpGoogleNewsItem[]> {
  const seen = new Set<string>();
  const out: SerpGoogleNewsItem[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const label = `${slotTag} serp ${i + 1}/${queries.length}`;
    try {
      const { data } = await fetchSerpGoogleNews(q, label, usage);
      for (const it of flattenGoogleNewsResults(data.news_results)) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        out.push(it);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      counters.serpApiErrors++;
      if (counters.serpApiErrorSample.length < SERP_ERROR_SAMPLE_MAX) {
        counters.serpApiErrorSample.push(`${label}: ${msg}`);
      }
      console.warn(`[google-news] ${label} ERROR:`, msg);
    }
  }
  const capped = capSlotPoolByRecency(out, SLOT_CANDIDATE_POOL_CAP);
  if (out.length > capped.length) {
    console.log(
      `[google-news] ${slotTag} pool cap: ${out.length} unique → ${capped.length} newest (max ${SLOT_CANDIDATE_POOL_CAP}) before scoring`
    );
  }
  return capped;
}

function pickBestEligibleScored(
  scored: PickedSlotStory[],
  minScore: number
): PickedSlotStory | undefined {
  const ok = scored.filter((s) => !s.gate.exclude && s.gate.relevanceScore >= minScore);
  ok.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);
  return ok[0];
}

function pickTopEligibleScored(
  scored: PickedSlotStory[],
  minScore: number,
  maxPicks: number
): PickedSlotStory[] {
  if (maxPicks <= 0) return [];
  const ok = scored.filter((s) => !s.gate.exclude && s.gate.relevanceScore >= minScore);
  ok.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);
  return ok.slice(0, maxPicks);
}

async function runSlotPick(params: {
  slotLog: string;
  items: SerpGoogleNewsItem[];
  existingUrls: Set<string>;
  chosenThisRun: Set<string>;
  counters: RunCounters;
  require48h: boolean;
  preScoreFilter: (it: SerpGoogleNewsItem) => boolean;
  slotScoreRules?: string;
  applyOverrides: boolean;
}): Promise<PickedSlotStory | null> {
  const {
    slotLog,
    items,
    existingUrls,
    chosenThisRun,
    counters,
    require48h,
    preScoreFilter,
    slotScoreRules,
    applyOverrides,
  } = params;
  const pool: SerpGoogleNewsItem[] = [];
  for (const it of items) {
    if (existingUrls.has(it.link) || chosenThisRun.has(it.link)) continue;
    if (!passesKeywordGate(it)) {
      counters.skipped++;
      continue;
    }
    if (isStoryOlderThan7Days(it)) {
      counters.skipped++;
      continue;
    }
    if (require48h && !isStoryWithin48Hours(it)) {
      counters.skipped++;
      continue;
    }
    if (!preScoreFilter(it)) {
      counters.skipped++;
      continue;
    }
    pool.push(it);
  }
  if (pool.length === 0) {
    console.warn(`[google-news] ${slotLog} no candidates after filters; skipping slot.`);
    return null;
  }

  const scored: PickedSlotStory[] = [];
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i]!;
    const label = `${slotLog} score ${i + 1}/${pool.length}`;
    try {
      let gate = await scoreAndGate(item, label, slotScoreRules);
      if (applyOverrides) gate = applyGoogleNewsScoringOverrides(item, gate);
      scored.push({ item, gate, label, slotLog });
    } catch (e) {
      counters.errors++;
      console.error(`[google-news] ${label} scoring ERROR:`, e instanceof Error ? e.message : e);
    }
  }

  const pick = pickBestEligibleScored(scored, 5);
  if (!pick) {
    console.warn(`[google-news] ${slotLog} no eligible story (score ≥5) after scoring; skipping slot.`);
    return null;
  }
  return pick;
}

async function runSlotPickTopN(params: {
  slotLog: string;
  items: SerpGoogleNewsItem[];
  existingUrls: Set<string>;
  chosenThisRun: Set<string>;
  counters: RunCounters;
  require48h: boolean;
  preScoreFilter: (it: SerpGoogleNewsItem) => boolean;
  slotScoreRules?: string;
  applyOverrides: boolean;
  maxPicks: number;
  minScore: number;
}): Promise<PickedSlotStory[]> {
  const {
    slotLog,
    items,
    existingUrls,
    chosenThisRun,
    counters,
    require48h,
    preScoreFilter,
    slotScoreRules,
    applyOverrides,
    maxPicks,
    minScore,
  } = params;

  const pool: SerpGoogleNewsItem[] = [];
  for (const it of items) {
    if (existingUrls.has(it.link) || chosenThisRun.has(it.link)) continue;
    if (!passesKeywordGate(it)) {
      counters.skipped++;
      continue;
    }
    if (isStoryOlderThan7Days(it)) {
      counters.skipped++;
      continue;
    }
    if (require48h && !isStoryWithin48Hours(it)) {
      counters.skipped++;
      continue;
    }
    if (!preScoreFilter(it)) {
      counters.skipped++;
      continue;
    }
    pool.push(it);
  }
  if (pool.length === 0) {
    console.warn(`[google-news] ${slotLog} no candidates after filters; skipping slot.`);
    return [];
  }

  const scored: PickedSlotStory[] = [];
  for (let i = 0; i < pool.length; i++) {
    const item = pool[i]!;
    const label = `${slotLog} score ${i + 1}/${pool.length}`;
    try {
      let gate = await scoreAndGate(item, label, slotScoreRules);
      if (applyOverrides) gate = applyGoogleNewsScoringOverrides(item, gate);
      scored.push({ item, gate, label, slotLog });
    } catch (e) {
      counters.errors++;
      console.error(`[google-news] ${label} scoring ERROR:`, e instanceof Error ? e.message : e);
    }
  }

  const picks = pickTopEligibleScored(scored, minScore, maxPicks);
  if (picks.length === 0) {
    console.warn(
      `[google-news] ${slotLog} no eligible stories (score ≥${minScore}) after scoring; skipping slot.`
    );
    return [];
  }
  return picks;
}

/**
 * SerpApi Google News — slots: Arizona/Phoenix local news, rotating AZ sports, food/nightlife/lifestyle,
 * cannabis (Arizona), cannabis (national).
 * Each slot: own Serp queries → filter (incl. 7d recency, 48h for sports slot) → score → up to two picks per slot (min score threshold in code).
 * Manual: POST /api/command { "command": "syncNews" }. Uses SERPAPI_API_KEY.
 */
export async function syncNewsApiToSanity(): Promise<{
  fetched: number;
  published: number;
  skipped: number;
  errors: number;
  /** SerpApi fetch failures specifically — see RunCounters.serpApiErrors. */
  serpApiErrors: number;
  serpApiErrorSample: string[];
}> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  const maxPublish = config.googleNews.maxPublishPerRun;
  const now = new Date();
  const { ymd: phoenixYmd, year } = getPhoenixYmdMonthLongYear(now);
  const { mode: slot2Mode, teamLabel: slot2Team } = getSlot2Mode(now);

  const counters: RunCounters = { skipped: 0, errors: 0, serpApiErrors: 0, serpApiErrorSample: [] };
  const serpUsage: SerpRunUsage = { apiCalls: 0 };
  let fetched = 0;

  console.log('[google-news] ========== syncNewsApiToSanity start ==========');
  console.log(
    `[google-news] Config: maxPublishPerRun=${maxPublish} (top 2 per slot, hard min score 5). Phoenix calendar date=${phoenixYmd}; slot-2 mode=${slot2Mode} (${slot2Team}).`
  );

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();
  console.log(
    `[google-news] Dedup: ${existingUrls.size} existing URL(s) in Sanity, ${existingSlugs.length} slug(s)`
  );

  const chosenThisRun = new Set<string>();
  const picked: PickedSlotStory[] = [];

  const SLOT1_LOCAL_RULES = `This slot is ONLY for genuinely local greater-Phoenix metro / Arizona news. No national partisan politics. No crime/violence. Must be relevant to Phoenix metro or Arizona residents.`;
  const poolLocal = await fetchSlotCandidatePool(
    SLOT1_LOCAL_QUERIES,
    '[slot-1-local]',
    serpUsage,
    counters
  );
  fetched += poolLocal.length;
  const sLocalPicks = await runSlotPickTopN({
    slotLog: '[slot-1-local]',
    items: poolLocal,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: nonSportsLocalPrefilter,
    slotScoreRules: SLOT1_LOCAL_RULES,
    applyOverrides: false,
    maxPicks: 2,
    minScore: 5,
  });
  sLocalPicks.forEach((s, idx) => {
    picked.push(s);
    chosenThisRun.add(s.item.link);
    console.log(
      `[google-news] [slot-1-local] pick #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 100)}`
    );
  });

  const SLOT2_RULES =
    slot2Mode === 'sunday_mix'
      ? `This slot is for Arizona pro/college sports other than the Phoenix Suns (e.g. Coyotes, Diamondbacks, Cardinals, ASU, Phoenix Rising). exclude=true for Suns/NBA-centric stories.`
      : `This slot is ONLY for ${slot2Team} (not Phoenix Suns). exclude=true if the story is not primarily about ${slot2Team}.`;
  const pool2 = await fetchSlotCandidatePool(
    buildSlot2Queries(slot2Mode, slot2Team, year),
    '[slot-2-sports]',
    serpUsage,
    counters
  );
  fetched += pool2.length;
  const s2Picks = await runSlotPickTopN({
    slotLog: '[slot-2-sports]',
    items: pool2,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: true,
    preScoreFilter: (it) => slot2Prefilter(it, slot2Mode),
    slotScoreRules: SLOT2_RULES,
    applyOverrides: true,
    maxPicks: 2,
    minScore: 5,
  });
  s2Picks.forEach((s, idx) => {
    picked.push(s);
    chosenThisRun.add(s.item.link);
    console.log(
      `[google-news] [slot-2-sports] pick #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 100)}`
    );
  });

  const SLOT3_LIFESTYLE_RULES = `This slot is Phoenix metro food, nightlife, and lifestyle. Focus on Valley businesses, venues, and experiences. Lifestyle wellness is fine — fitness, spas, mental health — but no clinical medical news. Set exclude=true for sports or hard-news-dominant pieces.

**category (required in JSON):** Pick the single best Sanity category slug for this story — exactly one of: **food**, **nightlife**, **health-wellness** (use these exact strings). Examples: restaurant opening or chef → food; bars, clubs, live music venue → nightlife; fitness, spa, mental health, wellness → health-wellness.

Return JSON including **category** (in addition to relevanceScore, exclude, topicDedupeKey, and excludeReason when applicable):
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <string or omit>, "topicDedupeKey": "<string>", "category": "food"|"nightlife"|"health-wellness"}`;
  const poolLifestyle = await fetchSlotCandidatePool(SLOT3_LIFESTYLE_QUERIES, '[slot-3-lifestyle]', serpUsage, counters);
  fetched += poolLifestyle.length;
  const s3Picks = await runSlotPickTopN({
    slotLog: '[slot-3-lifestyle]',
    items: poolLifestyle,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: lifestylePrefilter,
    slotScoreRules: SLOT3_LIFESTYLE_RULES,
    applyOverrides: false,
    maxPicks: 2,
    minScore: 5,
  });
  s3Picks.forEach((s, idx) => {
    picked.push(s);
    chosenThisRun.add(s.item.link);
    console.log(
      `[google-news] [slot-3-lifestyle] pick #${idx + 1} score=${s.gate.relevanceScore} category=${s.gate.category ?? 'n/a'} — ${s.item.title.slice(0, 100)}`
    );
  });

  const SLOT4_CANNABIS_AZ_RULES = `This slot is ONLY for Arizona cannabis news. Must be relevant to Arizona cannabis consumers. Only mention brands and dispensaries available in Arizona. No out-of-state brand promotions.`;
  const poolCannabisAz = await fetchSlotCandidatePool(SLOT4_CANNABIS_AZ_QUERIES, '[slot-4-cannabis-az]', serpUsage, counters);
  fetched += poolCannabisAz.length;
  const s4Picks = await runSlotPickTopN({
    slotLog: '[slot-4-cannabis-az]',
    items: poolCannabisAz,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: () => true,
    slotScoreRules: SLOT4_CANNABIS_AZ_RULES,
    applyOverrides: false,
    maxPicks: 2,
    minScore: 5,
  });
  s4Picks.forEach((s, idx) => {
    picked.push(s);
    chosenThisRun.add(s.item.link);
    console.log(
      `[google-news] [slot-4-cannabis-az] pick #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 100)}`
    );
  });

  const SLOT5_CANNABIS_NATIONAL_RULES = `This slot is for national cannabis policy, federal law changes, state legislation, and industry trends — all valid. When brands are mentioned, note they may not be available in Arizona — never frame out-of-state brands as something Arizona readers can go purchase.`;
  const poolCannabisNational = await fetchSlotCandidatePool(
    SLOT5_CANNABIS_NATIONAL_QUERIES,
    '[slot-5-cannabis-national]',
    serpUsage,
    counters
  );
  fetched += poolCannabisNational.length;
  const s5Picks = await runSlotPickTopN({
    slotLog: '[slot-5-cannabis-national]',
    items: poolCannabisNational,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: () => true,
    slotScoreRules: SLOT5_CANNABIS_NATIONAL_RULES,
    applyOverrides: false,
    maxPicks: 2,
    minScore: 5,
  });
  s5Picks.forEach((s, idx) => {
    picked.push(s);
    chosenThisRun.add(s.item.link);
    console.log(
      `[google-news] [slot-5-cannabis-national] pick #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 100)}`
    );
  });

  const toPublish = picked.slice(0, maxPublish);

  console.log(
    `[google-news] Final publish queue: ${toPublish.length} total (cap ${maxPublish}). Serp candidate rows merged this run ≈ ${fetched}.`
  );
  toPublish.forEach((s, idx) => {
    console.log(
      `[google-news]   #${idx + 1}/${toPublish.length} slot=${s.slotLog} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 90)}`
    );
  });

  let published = 0;
  const publishedSlugsThisRun = new Set<string>();

  const SLOT4_CANNABIS_AZ_REWRITE_RULES = `This article is for Arizona cannabis consumers. Only mention dispensaries, brands, and products available in Arizona. Never reference out-of-state dispensaries or brands as something readers can purchase. Always ground the story in Arizona — mention specific Valley dispensaries or AZ cannabis businesses where relevant. Do not use clinical or legal disclaimer language — write like a local cannabis insider, not a compliance officer.`;

  const SLOT5_CANNABIS_NATIONAL_REWRITE_RULES = `This article covers national cannabis news for a Phoenix Arizona audience. Cover the policy, law, or trend factually and explain why it matters to Arizona consumers or the broader cannabis industry. If out-of-state or national brands are mentioned, treat them as industry news only — never suggest Arizona readers can go purchase them locally. Keep the tone informed and reader-friendly, not academic or clinical.`;

  for (let p = 0; p < toPublish.length; p++) {
    const row = toPublish[p]!;
    const pubLabel = `${row.slotLog} publish ${p + 1}/${toPublish.length}`;

    try {
      const slotId = parseGoogleNewsSlotId(row.slotLog);
      const rewriteRules =
        slotId === 'slot-4-cannabis-az'
          ? SLOT4_CANNABIS_AZ_REWRITE_RULES
          : slotId === 'slot-5-cannabis-national'
            ? SLOT5_CANNABIS_NATIONAL_REWRITE_RULES
            : undefined;
      const article = await rewriteArticleWithSlotRules(
        row.item,
        `${row.label} / ${pubLabel}`,
        rewriteRules
      );
      article.slug = ensureUniqueSlug(article.slug || generateSlug(article.title), existingSlugs);

      if (publishedSlugsThisRun.has(article.slug)) {
        console.warn(
          `[google-news] ${pubLabel} SKIP: slug "${article.slug}" already published successfully this run (duplicate publish guard).`
        );
        counters.skipped++;
        continue;
      }

      existingSlugs.push(article.slug);

      // Editor quality gate
      let editorScore: number | null = null;
      let editorReason = '';
      try {
        const editorResult = await scoreArticleQuality(article);
        editorScore = editorResult.score;
        editorReason = editorResult.reason;
      } catch (editorError) {
        const editorMsg =
          editorError instanceof Error ? editorError.message : String(editorError);
        console.error(
          `[google-news] ${pubLabel} editor quality check failed (publishing anyway): ${editorMsg}`
        );
      }

      if (editorScore !== null && editorScore < 6) {
        console.warn(
          `[google-news] ${pubLabel} SKIP: "${article.title}" editor score ${editorScore}/10 — ${editorReason}`
        );
        counters.skipped++;
        continue;
      }

      const filename = `google-news-${article.slug.slice(0, 24)}.jpg`;
      const slot = slotId;
      const publishMeta = {
        slot,
        ...(slot === 'slot-3-lifestyle' ? { lifestyleCategory: row.gate.category } : {}),
      };
      const sectionSlug = resolveGoogleNewsPrimaryCategorySlug(publishMeta);
      const heroId = await generateAndUploadHeroForGoogleNews(
        article,
        sectionSlug,
        filename,
        pubLabel
      );

      console.log(`[google-news] ${pubLabel} → Sanity publish… slug=${article.slug}`);
      await publishGoogleNewsArticleToSanity(article, heroId, row.item.link, publishMeta);
      publishedSlugsThisRun.add(article.slug);
      existingUrls.add(row.item.link);
      published++;
      console.log(`[google-news] ${pubLabel} ✓ published: ${article.title}`);
    } catch (e) {
      counters.errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[google-news] ${pubLabel} ERROR: ${msg}`);
      if (e instanceof Error && e.stack) console.error(e.stack);
    }
  }

  console.log(
    `[google-news] ========== end: fetched=${fetched}, published=${published}, skipped=${counters.skipped}, errors=${counters.errors}, serpApiErrors=${counters.serpApiErrors}, serpApiCalls=${serpUsage.apiCalls} ==========`
  );
  return {
    fetched,
    published,
    skipped: counters.skipped,
    errors: counters.errors,
    serpApiErrors: counters.serpApiErrors,
    serpApiErrorSample: counters.serpApiErrorSample,
  };
}

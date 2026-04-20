import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { config } from '../config';
import {
  getExistingNewsSourceUrls,
  getExistingSlugs,
  parseGoogleNewsSlotId,
  publishGoogleNewsArticleToSanity,
  uploadImageToSanity,
} from './sanityPublisher';
import { Article, validateArticle } from '../utils/validator';
import { ensureUniqueSlug, generateSlug } from '../utils/slug';
import { generateImage, generateImagePrompt } from './imageAgent';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'googleNewsRewrite.prompt.txt');

/** OpenAI model for SerpApi Google News candidate scoring + topic/exclude gate. */
const OPENAI_MODEL_GOOGLE_NEWS_SCORE = 'gpt-5.4-mini';
/** OpenAI model for SerpApi Google News article rewrite → HappyTimesAZ JSON. */
const OPENAI_MODEL_GOOGLE_NEWS_REWRITE = 'gpt-5.4';

/** Slot 1 — Suns / NBA */
const SLOT1_QUERIES = [
  'Phoenix Suns news today',
  'Suns game result today',
  'Phoenix Suns playoffs 2026',
] as const;

/** Slot 3 — Phoenix local */
const SLOT3_QUERIES = [
  'Phoenix Arizona local news today',
  'Phoenix community news today',
  'Arizona local development news',
  'Phoenix city news today',
] as const;

/** Slot 4 — lifestyle / food / entertainment (no sports, no hard news) */
const SLOT4_QUERIES = [
  'Phoenix restaurant news today',
  'Scottsdale food entertainment news',
  'Phoenix arts culture news today',
  'Arizona lifestyle news today',
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
   * Slot 4 only: Sanity category slug chosen by scorer — exactly one of
   * food | nightlife | health-wellness | cannabis.
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

function isValidHttpUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const t = url.trim();
  if (t.length < 10) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function generateAndUploadHeroForGoogleNews(
  article: Article,
  filenameBase: string,
  label: string
): Promise<string> {
  const basePrompt =
    (article as unknown as { heroImagePrompt?: unknown }).heroImagePrompt &&
    typeof (article as unknown as { heroImagePrompt?: unknown }).heroImagePrompt === 'string'
      ? ((article as unknown as { heroImagePrompt?: string }).heroImagePrompt as string)
      : `A realistic editorial photo illustrating: ${article.title} (Phoenix, Arizona local news)`;

  console.log(`[google-news] ${label} AI hero: generating image prompt…`);
  const enhanced = await generateImagePrompt(basePrompt, article.visualStyle);
  console.log(`[google-news] ${label} AI hero: generating image…`);
  const imageUrl = await generateImage(enhanced);
  console.log(`[google-news] ${label} AI hero: uploading to Sanity…`);
  const heroId = await uploadImageToSanity(imageUrl, filenameBase);
  console.log(`[google-news] ${label} AI hero asset=${heroId}`);
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

const BODY_MARKDOWN_SAFETY_MAX = 4800;
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
    console.log(
      `[google-news] ${label} bodyMarkdown safety truncate: ${body.length} → ${next.length} chars (cap ${BODY_MARKDOWN_SAFETY_MAX})`
    );
    o.bodyMarkdown = next;
  }
  const ex = o.excerpt;
  if (typeof ex === 'string' && ex.length > EXCERPT_SAFETY_MAX) {
    const next = truncateExcerptAtLastWord(ex, EXCERPT_SAFETY_MAX);
    console.log(
      `[google-news] ${label} excerpt safety truncate: ${ex.length} → ${next.length} chars (cap ${EXCERPT_SAFETY_MAX})`
    );
    o.excerpt = next;
  }
}

async function rewriteArticle(item: SerpGoogleNewsItem, label: string): Promise<Article> {
  console.log(
    `[google-news] ${label} → AI rewrite starting (model=${OPENAI_MODEL_GOOGLE_NEWS_REWRITE})`
  );
  const system = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
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
}

function passesKeywordGate(item: SerpGoogleNewsItem): boolean {
  const blob = `${item.title}\n${item.snippet || ''}`;
  if (NEGATIVE_HEADLINE_RE.test(blob)) return false;
  return true;
}

async function fetchSerpGoogleNews(
  q: string,
  label: string
): Promise<{ data: SerpGoogleNewsResponse; httpStatus: number }> {
  console.log(`[google-news] ${label}: calling GET ${SERPAPI_SEARCH}`);
  console.log(`[google-news] ${label}: params engine=google_news, gl=us, hl=en`);
  console.log(`[google-news] ${label}: q (exact)= ${q}`);

  const { data, status } = await axios.get<SerpGoogleNewsResponse>(SERPAPI_SEARCH, {
    params: {
      engine: 'google_news',
      api_key: config.serpApi.apiKey,
      q,
      gl: 'us',
      hl: 'en',
    },
    validateStatus: () => true,
  });

  const metaStatus = data.search_metadata?.status ?? 'n/a';
  const n = data.news_results?.length ?? 0;
  console.log(
    `[google-news] ${label}: httpStatus=${status}, search_metadata.status=${metaStatus}, news_results.length=${n}`
  );
  if (data.error) {
    console.warn(`[google-news] ${label}: SerpApi error field: ${data.error}`);
  }

  return { data, httpStatus: status };
}

type RunCounters = { skipped: number; errors: number };

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

function buildSlot5Queries(monthLong: string, year: number): readonly string[] {
  return [
    'Phoenix events this weekend',
    'Arizona festivals upcoming 2026',
    'Phoenix concerts this week',
    'things to do Phoenix this weekend',
    `Arizona events ${monthLong} ${year}`,
  ];
}

function isSunsSlot1Candidate(item: SerpGoogleNewsItem): boolean {
  const b = `${item.title}\n${item.snippet || ''}`.toLowerCase();
  return (
    /\bphoenix\s+suns\b|\bphx\s+suns\b/.test(b) ||
    (/\bsuns\b/.test(b) && /\b(nba|basketball|playoff|play-in|game|booker|durant|footprint)\b/.test(b))
  );
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

/** Slot 3: strictly non-sports Phoenix local — drop obvious sports stories before scoring. */
function slot3NonSportsPrefilter(item: SerpGoogleNewsItem): boolean {
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

function slot4Prefilter(item: SerpGoogleNewsItem): boolean {
  const blob = `${item.title}\n${item.snippet || ''}`;
  if (LOCAL_CORE_SPORTS_RE.test(blob)) return false;
  if (HARD_LOCAL_NEWS_RE.test(blob)) return false;
  return true;
}

async function fetchSlotCandidatePool(
  queries: readonly string[],
  slotTag: string
): Promise<SerpGoogleNewsItem[]> {
  const seen = new Set<string>();
  const out: SerpGoogleNewsItem[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    const label = `${slotTag} serp ${i + 1}/${queries.length}`;
    try {
      const { data, httpStatus } = await fetchSerpGoogleNews(q, label);
      if (httpStatus !== 200 || data.error) continue;
      for (const it of flattenGoogleNewsResults(data.news_results)) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        out.push(it);
      }
    } catch (e) {
      console.warn(`[google-news] ${label} ERROR:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

function pickBestEligibleScored(
  scored: PickedSlotStory[],
  minScore: number
): PickedSlotStory | undefined {
  const ok = scored.filter((s) => !s.gate.exclude && s.gate.relevanceScore >= minScore);
  ok.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);
  return ok[0];
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

  let pick = pickBestEligibleScored(scored, 6);
  if (!pick) {
    console.log(`[google-news] ${slotLog} no eligible score ≥6; trying threshold ≥4 for this slot only.`);
    pick = pickBestEligibleScored(scored, 4);
  }
  if (!pick) {
    console.warn(`[google-news] ${slotLog} no eligible story (≥4) after scoring; skipping slot.`);
    return null;
  }
  return pick;
}

/**
 * SerpApi Google News — five independent slots (Suns/NBA, rotating AZ sports, local, lifestyle, events).
 * Each slot: own Serp queries → filter (incl. 7d recency, 48h for sports slots) → score (6+, else 4 for that slot) → publish at most one.
 * Manual: POST /api/command { "command": "syncNews" }. Uses SERPAPI_API_KEY.
 */
export async function syncNewsApiToSanity(): Promise<{
  fetched: number;
  published: number;
  skipped: number;
  errors: number;
}> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  const maxPublish = Math.min(5, config.googleNews.maxPublishPerRun);
  const now = new Date();
  const { ymd: phoenixYmd, monthLong, year } = getPhoenixYmdMonthLongYear(now);
  const { mode: slot2Mode, teamLabel: slot2Team } = getSlot2Mode(now);

  const counters: RunCounters = { skipped: 0, errors: 0 };
  let fetched = 0;

  console.log('[google-news] ========== syncNewsApiToSanity (5-slot) start ==========');
  console.log(
    `[google-news] Config: maxPublishPerRun=${maxPublish} (one story per slot, max 5). Phoenix calendar date=${phoenixYmd}; slot-2 mode=${slot2Mode} (${slot2Team}).`
  );

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();
  console.log(
    `[google-news] Dedup: ${existingUrls.size} existing URL(s) in Sanity, ${existingSlugs.length} slug(s)`
  );

  const chosenThisRun = new Set<string>();
  const picked: PickedSlotStory[] = [];

  const SLOT1_RULES = `This slot is ONLY for Phoenix Suns / NBA (games, results, playoffs, roster). exclude=true if the story is not primarily about the Phoenix Suns or NBA tied to the Suns.`;
  const pool1 = await fetchSlotCandidatePool(SLOT1_QUERIES, '[slot-1-suns]');
  fetched += pool1.length;
  const s1 = await runSlotPick({
    slotLog: '[slot-1-suns]',
    items: pool1,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: true,
    preScoreFilter: isSunsSlot1Candidate,
    slotScoreRules: SLOT1_RULES,
    applyOverrides: true,
  });
  if (s1) {
    picked.push(s1);
    chosenThisRun.add(s1.item.link);
    console.log(
      `[google-news] [slot-1-suns] winner score=${s1.gate.relevanceScore} — ${s1.item.title.slice(0, 100)}`
    );
  }

  const SLOT2_RULES =
    slot2Mode === 'sunday_mix'
      ? `This slot is for Arizona pro/college sports other than the Phoenix Suns (e.g. Coyotes, Diamondbacks, Cardinals, ASU, Phoenix Rising). exclude=true for Suns/NBA-centric stories.`
      : `This slot is ONLY for ${slot2Team} (not Phoenix Suns). exclude=true if the story is not primarily about ${slot2Team}.`;
  const pool2 = await fetchSlotCandidatePool(
    buildSlot2Queries(slot2Mode, slot2Team, year),
    '[slot-2-sports]'
  );
  fetched += pool2.length;
  const s2 = await runSlotPick({
    slotLog: '[slot-2-sports]',
    items: pool2,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: true,
    preScoreFilter: (it) => slot2Prefilter(it, slot2Mode),
    slotScoreRules: SLOT2_RULES,
    applyOverrides: true,
  });
  if (s2) {
    picked.push(s2);
    chosenThisRun.add(s2.item.link);
    console.log(
      `[google-news] [slot-2-sports] winner score=${s2.gate.relevanceScore} — ${s2.item.title.slice(0, 100)}`
    );
  }

  const SLOT3_RULES = `This slot is for genuinely local greater-Phoenix metro news (city, neighborhoods, development, community, business, infrastructure, environment, civic life). exclude=true for pure national politics with no physical Phoenix/Valley hook.

**MANDATORY — NO SPORTS IN SLOT 3:** Set **exclude=true** for any story that is **primarily** about a **sports team, game, player, coach, trade, injury, standings, draft, season, stadium/arena, league, or sporting event** (pro, college, or high school). Slot 3 is **strictly non-sports** local Phoenix news — even a high-scoring sports story must be excluded.`;
  const pool3 = await fetchSlotCandidatePool(SLOT3_QUERIES, '[slot-3-local]');
  fetched += pool3.length;
  const s3 = await runSlotPick({
    slotLog: '[slot-3-local]',
    items: pool3,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: slot3NonSportsPrefilter,
    slotScoreRules: SLOT3_RULES,
    applyOverrides: true,
  });
  if (s3) {
    picked.push(s3);
    chosenThisRun.add(s3.item.link);
    console.log(
      `[google-news] [slot-3-local] winner score=${s3.gate.relevanceScore} — ${s3.item.title.slice(0, 100)}`
    );
  }

  const SLOT4_RULES = `This slot is Phoenix metro lifestyle, food, arts, dining, and entertainment — NOT sports and NOT hard breaking news (crime, disasters, heavy politics). Set exclude=true for sports or hard-news-dominant pieces.

**category (required in JSON):** Pick the single best Sanity category slug for this story — exactly one of: **food**, **nightlife**, **health-wellness**, **cannabis** (use these exact strings). Examples: restaurant opening or chef → food; bars, clubs, live music venue → nightlife; medical study, fitness, spa, mental health → health-wellness; dispensary, regulation, cannabis industry → cannabis.

Return JSON including **category** (in addition to relevanceScore, exclude, topicDedupeKey, and excludeReason when applicable):
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <string or omit>, "topicDedupeKey": "<string>", "category": "food"|"nightlife"|"health-wellness"|"cannabis"}`;
  const pool4 = await fetchSlotCandidatePool(SLOT4_QUERIES, '[slot-4-lifestyle]');
  fetched += pool4.length;
  const s4 = await runSlotPick({
    slotLog: '[slot-4-lifestyle]',
    items: pool4,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: slot4Prefilter,
    slotScoreRules: SLOT4_RULES,
    applyOverrides: false,
  });
  if (s4) {
    picked.push(s4);
    chosenThisRun.add(s4.item.link);
    console.log(
      `[google-news] [slot-4-lifestyle] winner score=${s4.gate.relevanceScore} category=${s4.gate.category ?? 'n/a'} — ${s4.item.title.slice(0, 100)}`
    );
  }

  const SLOT5_RULES = `This slot is ONLY for upcoming Phoenix/Valley events (concerts, festivals, things to do) where the main event date is on or after ${phoenixYmd} (America/Phoenix). exclude=true if the event is clearly in the past or the piece is not event-focused.`;
  const pool5 = await fetchSlotCandidatePool(buildSlot5Queries(monthLong, year), '[slot-5-events]');
  fetched += pool5.length;
  const s5 = await runSlotPick({
    slotLog: '[slot-5-events]',
    items: pool5,
    existingUrls,
    chosenThisRun,
    counters,
    require48h: false,
    preScoreFilter: () => true,
    slotScoreRules: SLOT5_RULES,
    applyOverrides: false,
  });
  if (s5) {
    picked.push(s5);
    chosenThisRun.add(s5.item.link);
    console.log(
      `[google-news] [slot-5-events] winner score=${s5.gate.relevanceScore} — ${s5.item.title.slice(0, 100)}`
    );
  }

  const toPublish = picked.slice(0, maxPublish);

  console.log(
    `[google-news] Final publish queue: ${toPublish.length} (cap ${maxPublish}). Serp candidate rows merged this run ≈ ${fetched}.`
  );
  toPublish.forEach((s, idx) => {
    console.log(
      `[google-news]   ${s.slotLog} #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 90)}`
    );
  });

  let published = 0;
  const publishedSlugsThisRun = new Set<string>();

  for (let p = 0; p < toPublish.length; p++) {
    const row = toPublish[p]!;
    const pubLabel = `${row.slotLog} publish ${p + 1}/${toPublish.length}`;

    try {
      const article = await rewriteArticle(row.item, `${row.label} / ${pubLabel}`);
      article.slug = ensureUniqueSlug(article.slug || generateSlug(article.title), existingSlugs);

      if (publishedSlugsThisRun.has(article.slug)) {
        console.warn(
          `[google-news] ${pubLabel} SKIP: slug "${article.slug}" already published successfully this run (duplicate publish guard).`
        );
        counters.skipped++;
        continue;
      }

      existingSlugs.push(article.slug);

      let heroId: string | undefined;
      const filename = `google-news-${article.slug.slice(0, 24)}.jpg`;
      const thumb = row.item.thumbnail?.trim() || '';
      if (thumb && isValidHttpUrl(thumb)) {
        console.log(`[google-news] ${pubLabel} hero upload (SerpAPI thumbnail)…`);
        try {
          heroId = await uploadImageToSanity(thumb, filename);
          console.log(`[google-news] ${pubLabel} hero asset=${heroId}`);
        } catch (e) {
          console.warn(
            `[google-news] ${pubLabel} hero upload failed; falling back to AI hero:`,
            e instanceof Error ? e.message : e
          );
        }
      } else if (thumb) {
        console.log(
          `[google-news] ${pubLabel} thumbnail invalid; falling back to AI hero`
        );
      } else {
        console.log(`[google-news] ${pubLabel} no thumbnail; falling back to AI hero`);
      }

      if (!heroId) {
        heroId = await generateAndUploadHeroForGoogleNews(article, filename, pubLabel);
      }

      console.log(`[google-news] ${pubLabel} → Sanity publish… slug=${article.slug}`);
      const slot = parseGoogleNewsSlotId(row.slotLog);
      await publishGoogleNewsArticleToSanity(article, heroId, row.item.link, {
        slot,
        ...(slot === 'slot-4-lifestyle' ? { slot4LifestyleCategory: row.gate.category } : {}),
      });
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
    `[google-news] ========== end: fetched=${fetched}, published=${published}, skipped=${counters.skipped}, errors=${counters.errors} ==========`
  );
  return {
    fetched,
    published,
    skipped: counters.skipped,
    errors: counters.errors,
  };
}

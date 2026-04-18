import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { config } from '../config';
import {
  getExistingNewsSourceUrls,
  getExistingSlugs,
  publishGoogleNewsArticleToSanity,
  uploadImageToSanity,
} from './sanityPublisher';
import { Article, validateArticle } from '../utils/validator';
import { ensureUniqueSlug, generateSlug } from '../utils/slug';
import { generateImage, generateImagePrompt } from './imageAgent';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'googleNewsRewrite.prompt.txt');

/**
 * Core team queries — run first; every unique URL from these is kept **without** counting
 * toward `maxFetch` (general queries fill up to `maxFetch` after).
 */
const GOOGLE_NEWS_PRIORITY_QUERIES: readonly string[] = [
  'Phoenix Suns news today',
  'Arizona Diamondbacks news today',
  'Arizona Cardinals news today',
  'ASU Sun Devils news today',
];

/**
 * Targeted SerpApi `q` strings: greater Phoenix metro + topic (after priority batch).
 * Fetched in order until enough unique URLs from this list alone reach `maxFetch` (priority URLs excluded from that count).
 */
const GOOGLE_NEWS_SEARCH_QUERIES: readonly string[] = [
  'Phoenix Arizona news today',
  'Scottsdale Tempe Mesa local news today',
  'Phoenix cannabis dispensary news Arizona',
  'Arizona marijuana cannabis industry news',
  'Phoenix restaurant bar opening closing news',
  'Phoenix nightlife entertainment news',
  'Arizona food drink scene news',
  'Phoenix events concerts festivals this week',
  'Phoenix Scottsdale health wellness news',
  'Arizona local business news today',
  'Phoenix real estate development news',
  'Arizona sports news today',
  'Phoenix community local heroes news',
  'Scottsdale arts culture events news',
  'Arizona outdoor recreation hiking news',
  'Phoenix metro crime safety news',
  'Arizona politics government news today',
  'Phoenix weather emergency news Arizona',
  'Arizona cannabis legalization policy news',
  'Phoenix food truck pop up events',
  'Phoenix Rising FC news today',
];

/** Fast reject before AI — crime, tragedy, serious accidents, national partisan frame (headline-level). */
const NEGATIVE_HEADLINE_RE =
  /murder|homicide|mass\s*shooting|killed in (a )?shooting|fatal (crash|collision|accident)|deadly (crash|collision|wreck)|terror(ist|ism)?|suicide|sexual assault|kidnap|rape\b|school\s*shooting|armed robbery|stabbed|shot dead|police\s+shooting|charged with|sentenced to|arrested for|domestic violence|child abuse|overdose death|capitol\s*riot|january\s*6|impeachment|white\s*house|mar[- ]a[- ]lago|\bGOP\b|\bDNC\b|presidential\s*campaign|midterm\s*election|election\s*fraud|stop\s*the\s*steal|congressional\s*hearing|supreme\s*court\s*(rules?|decides)/i;

type SerpGoogleNewsItem = {
  title: string;
  link: string;
  thumbnail: string | null;
  snippet?: string;
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

function flattenGoogleNewsResults(raw: unknown[] | undefined): SerpGoogleNewsItem[] {
  const out: SerpGoogleNewsItem[] = [];
  const seen = new Set<string>();

  const push = (title: unknown, link: unknown, thumbnail?: unknown, snippet?: unknown) => {
    if (typeof title !== 'string' || typeof link !== 'string' || !link.startsWith('http')) return;
    if (seen.has(link)) return;
    seen.add(link);
    out.push({
      title,
      link,
      thumbnail: typeof thumbnail === 'string' ? thumbnail : null,
      snippet: typeof snippet === 'string' ? snippet : undefined,
    });
  };

  for (const entry of raw || []) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    if (e.highlight && typeof e.highlight === 'object') {
      const h = e.highlight as Record<string, unknown>;
      push(h.title, h.link, h.thumbnail, h.snippet);
    }

    if (Array.isArray(e.stories)) {
      for (const st of e.stories) {
        if (st && typeof st === 'object') {
          const s = st as Record<string, unknown>;
          push(s.title, s.link, s.thumbnail, s.snippet);
        }
      }
    }

    if (!Array.isArray(e.stories) && e.title && e.link) {
      push(e.title, e.link, e.thumbnail, e.snippet);
    }
  }

  return out;
}

async function openAiJson<T>(system: string, user: string): Promise<T> {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: config.openai.model,
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

async function scoreAndGate(item: SerpGoogleNewsItem, label: string): Promise<ScoreResult> {
  const text = [item.title, item.snippet || ''].join('\n\n').slice(0, 12000);
  console.log(`[google-news] ${label} → OpenAI: relevance scoring + topic/exclude gate…`);

  const system = `You are an editor for HappyTimesAZ, a Phoenix AZ local lifestyle site covering the **greater Phoenix metro** (e.g. Phoenix, Scottsdale, Tempe, Mesa, Glendale, Peoria, Chandler, Gilbert, Surprise, Goodyear, Sun City, Fountain Hills, Cave Creek, Paradise Valley).

Score how relevant and valuable this story is for **local readers** (1–10). **Strongly prefer** when the angle fits: feel-good **community** stories; **local heroes** and **charity**; **food & dining** openings; **arts & culture**; **local business** and **entrepreneurs**; **health & wellness**; **real estate / development**; **tourism & attractions**; **parks & outdoor** activities; **local people** profiles; **Arizona / local policy** that affects daily life (**schools**, **city** decisions, **infrastructure**, **housing**, **local government** initiatives)—not national partisan noise.

**LOCAL PRO & COLLEGE SPORTS (MANDATORY):** Coverage of **Phoenix Suns**, **Arizona Cardinals**, **Arizona Diamondbacks**, **Arizona Coyotes**, or **ASU Sun Devils** (games, trades, injuries, standings, arena/stadium, Valley fan angle) is **core HappyTimesAZ content**. For those teams you MUST set **exclude=false** and **relevanceScore ≥ 7** (use 7–10 when the story is genuinely about the team or game).

**NATIONAL POLITICAL FIGURE — IN-PERSON VALLEY EVENT:** If a **national political figure** held or will hold a **rally, speech, fundraiser, or public event physically in the greater Phoenix metro** (not a generic national op-ed), treat it as **local news** because of **local impact** (traffic/road closures, venue, security, Valley attendance, local business, community reaction). Score **6–7** when that local-event frame is clear. Do **NOT** set **exclude=true** *only* because the story involves national politics if the **event happened or will happen in person in the Valley**.

Set **exclude=true** if the story is mainly: **crime**, **violence**, **tragedy**, **serious accidents**; **pure national** partisan noise with **no** Phoenix-area hook; **war**; **celebrity gossip** with no Arizona tie; or **remote** national political commentary with **no** in-person Valley event angle.

**topicDedupeKey** (required): a short stable identifier for the **one** main real-world story thread or event (use lowercase words separated by underscores, 2–8 segments, ≤80 chars). Every article about the **same** rally, game, press conference, or incident must reuse the **identical** key (e.g. three headlines about the same Trump rally in Phoenix → same key). Unrelated stories → different keys.

Return JSON only:
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <short string or omit>, "topicDedupeKey": "<string>"}`;

  const user = `Headline & snippet:\n${text}\n\nSource URL: ${item.link}`;

  const raw = await openAiJson<ScoreResult>(system, user);
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
  const result = {
    relevanceScore,
    exclude: Boolean(raw.exclude),
    excludeReason: raw.excludeReason,
    topicDedupeKey,
  };
  console.log(
    `[google-news] ${label} → score: relevanceScore=${result.relevanceScore}, exclude=${result.exclude}` +
      (result.excludeReason ? `, excludeReason="${result.excludeReason}"` : '')
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

async function rewriteArticle(item: SerpGoogleNewsItem, label: string): Promise<Article> {
  console.log(`[google-news] ${label} → AI rewrite starting (model=${config.openai.model})`);
  const system = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
  const basis = [
    `Title: ${item.title}`,
    item.snippet ? `Snippet: ${item.snippet}` : '',
    `Link: ${item.link}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const user = `Rewrite this into a full HappyTimesAZ article JSON.\n\n${basis}`;

  const parsed = await openAiJson<Record<string, unknown>>(system, user);

  truncateSeoTitleIfNeeded(parsed);

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

type ScoredAttempt = { item: SerpGoogleNewsItem; gate: ScoreResult; label: string };

function topicKeyForAttempt(a: ScoredAttempt): string {
  const k = a.gate.topicDedupeKey?.trim();
  if (k && k.length > 0) return k;
  return `url:${a.item.link}`;
}

/** Walk `sorted` (best score first); keep at most `max` items with unique topicDedupeKey. */
function pickDiversifiedByTopic(sorted: ScoredAttempt[], max: number): ScoredAttempt[] {
  const usedTopics = new Set<string>();
  const out: ScoredAttempt[] = [];
  for (const a of sorted) {
    const key = topicKeyForAttempt(a);
    if (usedTopics.has(key)) continue;
    usedTopics.add(key);
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * If any Phoenix metro core sports candidate scored ≥5 and is not excluded, ensure one such
 * story appears in `picks` by replacing the lowest-scoring non-sports slot when needed.
 */
function ensureAtLeastOneSportsStoryInPicks(
  picks: ScoredAttempt[],
  maxPublish: number,
  attempts: ScoredAttempt[]
): ScoredAttempt[] {
  const sportPool = attempts.filter(
    (a) =>
      isLocalCoreSportsItem(a.item) &&
      !a.gate.exclude &&
      a.gate.relevanceScore >= 5
  );
  if (sportPool.length === 0) return picks;

  const hasSport = (arr: ScoredAttempt[]) => arr.some((a) => isLocalCoreSportsItem(a.item));
  if (hasSport(picks)) return picks;

  const bestSport = [...sportPool].sort(
    (a, b) => b.gate.relevanceScore - a.gate.relevanceScore
  )[0]!;
  if (picks.length === 0) {
    return [bestSport].slice(0, maxPublish);
  }

  const next = picks.slice(0, maxPublish);
  let worstIdx = -1;
  let worstScore = Infinity;
  for (let i = 0; i < next.length; i++) {
    const a = next[i]!;
    if (isLocalCoreSportsItem(a.item)) continue;
    if (a.gate.relevanceScore < worstScore) {
      worstScore = a.gate.relevanceScore;
      worstIdx = i;
    }
  }
  if (worstIdx < 0) return next;
  next[worstIdx] = bestSport;
  next.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);
  return next;
}

/**
 * Priority queries (no cap), then general queries until `maxGeneralNew` new unique URLs
 * from general queries are merged (priority URLs do not count toward that cap).
 */
async function collectGoogleNewsCandidates(maxGeneralNew: number): Promise<{
  items: SerpGoogleNewsItem[];
  queriesUsed: number;
  lastError?: string;
  priorityCount: number;
  generalNewCount: number;
}> {
  const seen = new Set<string>();
  const items: SerpGoogleNewsItem[] = [];
  let queriesUsed = 0;
  let lastError: string | undefined;
  let generalNewCount = 0;

  for (let qi = 0; qi < GOOGLE_NEWS_PRIORITY_QUERIES.length; qi++) {
    const q = GOOGLE_NEWS_PRIORITY_QUERIES[qi]!;
    const label = `priority ${qi + 1}/${GOOGLE_NEWS_PRIORITY_QUERIES.length}`;
    queriesUsed++;

    try {
      const { data, httpStatus } = await fetchSerpGoogleNews(q, label);
      if (httpStatus !== 200 || data.error) {
        const msg = data.error || `HTTP ${httpStatus}`;
        lastError = msg;
        console.warn(`[google-news] ${label} SKIP: ${msg}`);
        continue;
      }

      const flat = flattenGoogleNewsResults(data.news_results);
      let added = 0;
      for (const it of flat) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
        added++;
      }

      console.log(
        `[google-news] ${label}: +${added} new URL(s) from priority (uncapped); pool=${items.length}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      console.warn(`[google-news] ${label} ERROR: ${msg}`);
    }
  }

  const priorityCount = items.length;

  for (
    let qi = 0;
    qi < GOOGLE_NEWS_SEARCH_QUERIES.length && generalNewCount < maxGeneralNew;
    qi++
  ) {
    const q = GOOGLE_NEWS_SEARCH_QUERIES[qi]!;
    const label = `query ${qi + 1}/${GOOGLE_NEWS_SEARCH_QUERIES.length}`;
    queriesUsed++;

    try {
      const { data, httpStatus } = await fetchSerpGoogleNews(q, label);
      if (httpStatus !== 200 || data.error) {
        const msg = data.error || `HTTP ${httpStatus}`;
        lastError = msg;
        console.warn(`[google-news] ${label} SKIP: ${msg}`);
        continue;
      }

      const flat = flattenGoogleNewsResults(data.news_results);
      let addedThisQuery = 0;
      for (const it of flat) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
        generalNewCount++;
        addedThisQuery++;
        if (generalNewCount >= maxGeneralNew) break;
      }

      console.log(
        `[google-news] ${label}: +${addedThisQuery} toward general cap (${generalNewCount}/${maxGeneralNew}); pool=${items.length}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      console.warn(`[google-news] ${label} ERROR: ${msg}`);
    }
  }

  return { items, queriesUsed, lastError, priorityCount, generalNewCount };
}

/**
 * SerpApi Google News → score candidates → keep top stories (score ≥ 6 by default; if fewer than 2 qualify, ≥ 5 for that run), topic diversity (≤1 per topicDedupeKey), sports floor, then rewrite → Sanity (`news`, `google_news`).
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

  const maxFetch = config.googleNews.maxFetch;
  const maxPublish = config.googleNews.maxPublishPerRun;

  console.log('[google-news] ========== syncNewsApiToSanity (SerpApi Google News) start ==========');
  console.log(
    `[google-news] Config: maxFetch=${maxFetch}, maxPublishPerRun=${maxPublish} (default min score 6; if <2 eligible, min 5 for that run)`
  );
  console.log(
    `[google-news] Search strategy: ${GOOGLE_NEWS_PRIORITY_QUERIES.length} priority queries (uncapped), then ${GOOGLE_NEWS_SEARCH_QUERIES.length} general queries (cap ${maxFetch} new URLs from general only)`
  );

  const {
    items: flat,
    queriesUsed,
    lastError,
    priorityCount,
    generalNewCount,
  } = await collectGoogleNewsCandidates(maxFetch);

  if (flat.length === 0) {
    throw new Error(
      lastError
        ? `SerpApi Google News: no stories after ${queriesUsed} query/queries. Last error: ${lastError}`
        : `SerpApi Google News: no stories after ${queriesUsed} query/queries`
    );
  }

  const fetched = flat.length;
  console.log(
    `[google-news] Flattened stories to process: ${fetched} (priority URLs=${priorityCount}, from general cap=${generalNewCount}/${maxFetch})`
  );

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();
  console.log(
    `[google-news] Dedup: ${existingUrls.size} existing URL(s) in Sanity, ${existingSlugs.length} slug(s)`
  );

  const attempts: ScoredAttempt[] = [];
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < flat.length; i++) {
    const item = flat[i];
    const label = `candidate ${i + 1}/${flat.length}`;

    console.log(
      `[google-news] --- ${label} --- "${item.title.slice(0, 100)}${item.title.length > 100 ? '…' : ''}"`
    );
    console.log(`[google-news] ${label} link=${item.link}`);

    if (existingUrls.has(item.link)) {
      console.log(`[google-news] ${label} SKIP: URL already in Sanity`);
      skipped++;
      continue;
    }

    if (!passesKeywordGate(item)) {
      console.log(`[google-news] ${label} SKIP: keyword gate`);
      skipped++;
      continue;
    }

    try {
      let gate = await scoreAndGate(item, label);
      gate = applyGoogleNewsScoringOverrides(item, gate);
      attempts.push({ item, gate, label });
      console.log(
        `[google-news] ${label} scored: exclude=${gate.exclude}, score=${gate.relevanceScore}`
      );
    } catch (e) {
      errors++;
      console.error(
        `[google-news] ${label} scoring ERROR:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  let publishMinScore = 6;
  let eligible = attempts.filter((a) => !a.gate.exclude && a.gate.relevanceScore >= publishMinScore);
  if (eligible.length < 2) {
    publishMinScore = 5;
    eligible = attempts.filter((a) => !a.gate.exclude && a.gate.relevanceScore >= publishMinScore);
    if (attempts.length > 0) {
      console.log(
        `[google-news] Fewer than 2 candidates at ≥6; using threshold ≥${publishMinScore} for this run (${eligible.length} eligible).`
      );
    }
  }

  const eligibleLinks = new Set(eligible.map((e) => e.item.link));
  for (const a of attempts) {
    if (!eligibleLinks.has(a.item.link)) {
      console.log(
        `[google-news] ${a.label} not eligible at ≥${publishMinScore}: exclude=${a.gate.exclude}, score=${a.gate.relevanceScore}`
      );
      skipped++;
    }
  }

  eligible.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);

  const diversified = pickDiversifiedByTopic(eligible, maxPublish);
  const beforeSports = diversified.slice();
  const toPublish = ensureAtLeastOneSportsStoryInPicks(diversified, maxPublish, attempts);

  const hadSportBefore = beforeSports.some((a) => isLocalCoreSportsItem(a.item));
  const hasSportAfter = toPublish.some((a) => isLocalCoreSportsItem(a.item));
  if (!hadSportBefore && hasSportAfter) {
    console.log(
      '[google-news] Sports floor: ensured at least one Phoenix metro core sports story in this run (any such candidate scored ≥5; may have replaced the lowest-scoring non-sports pick).'
    );
  }

  const publishLinks = new Set(toPublish.map((t) => t.item.link));
  const eligibleNotPublished = eligible.filter((e) => !publishLinks.has(e.item.link));
  skipped += eligibleNotPublished.length;
  if (eligibleNotPublished.length > 0) {
    console.log(
      `[google-news] ${eligibleNotPublished.length} eligible story/stories not published (topic diversity, publish cap, or sports swap superseded).`
    );
  }

  console.log(
    `[google-news] After scoring: ${eligible.length} eligible (≥${publishMinScore}, not excluded). Publishing ${toPublish.length} (max ${maxPublish}, ≤1 per topicDedupeKey):`
  );
  toPublish.forEach((s, idx) => {
    const tk = s.gate.topicDedupeKey ? ` topic=${s.gate.topicDedupeKey}` : '';
    console.log(
      `[google-news]   #${idx + 1} score=${s.gate.relevanceScore}${tk} — ${s.item.title.slice(0, 90)}`
    );
  });

  let published = 0;

  for (let p = 0; p < toPublish.length; p++) {
    const { item, label } = toPublish[p];
    const pubLabel = `publish ${p + 1}/${toPublish.length}`;

    try {
      const article = await rewriteArticle(item, `${label} / ${pubLabel}`);
      article.slug = ensureUniqueSlug(article.slug || generateSlug(article.title), existingSlugs);
      existingSlugs.push(article.slug);

      let heroId: string | undefined;
      const filename = `google-news-${article.slug.slice(0, 24)}.jpg`;
      const thumb = item.thumbnail?.trim() || '';
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
      await publishGoogleNewsArticleToSanity(article, heroId, item.link);
      existingUrls.add(item.link);
      published++;
      console.log(`[google-news] ${pubLabel} ✓ published: ${article.title}`);
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[google-news] ${pubLabel} ERROR: ${msg}`);
      if (e instanceof Error && e.stack) console.error(e.stack);
    }
  }

  console.log(
    `[google-news] ========== end: fetched=${fetched}, published=${published}, skipped=${skipped}, errors=${errors} ==========`
  );
  return { fetched, published, skipped, errors };
}

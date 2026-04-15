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
 * Targeted SerpApi `q` strings: greater Phoenix metro + topic. Fetched in order until
 * we have enough unique URLs (maxFetch). Last entry is a broad Valley fallback.
 */
const GOOGLE_NEWS_SEARCH_QUERIES: readonly string[] = [
  // Metro clusters + community / lifestyle
  'Phoenix Scottsdale Tempe feel good community stories Arizona',
  'Mesa Chandler Gilbert local heroes charity volunteering Arizona',
  'Glendale Peoria Surprise Goodyear positive community news Arizona',
  'Sun City Fountain Hills Cave Creek Paradise Valley Arizona local community',
  'Scottsdale Phoenix restaurant opening food dining Arizona',
  'Phoenix Tempe Mesa arts culture museums Arizona',
  'Chandler Gilbert Scottsdale local business entrepreneurs Arizona',
  // Pro sports (local angle)
  'Phoenix Suns Arizona',
  'Arizona Cardinals Glendale',
  'Arizona Diamondbacks Phoenix',
  'Scottsdale Phoenix health wellness Arizona',
  'Phoenix metro real estate development Arizona',
  'Phoenix Scottsdale tourism attractions Arizona',
  'Phoenix metro parks hiking outdoor recreation Arizona',
  'Phoenix Arizona local people profiles inspiring stories',
  // Local / state policy affecting daily life (not national partisan news)
  'Arizona local government city council schools infrastructure housing policy',
  'Phoenix Mesa education funding city policy Arizona',
  // Broad Valley fallback if earlier queries return thin results
  'Phoenix metro Arizona local lifestyle community',
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
};

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

Score how relevant and valuable this story is for **local readers** (1–10). **Strongly prefer** when the angle fits: feel-good **community** stories; **local heroes** and **charity**; **food & dining** openings; **arts & culture**; **local business** and **entrepreneurs**; **Phoenix Suns**, **Arizona Cardinals**, **Arizona Diamondbacks**; **health & wellness**; **real estate / development**; **tourism & attractions**; **parks & outdoor** activities; **local people** profiles; **Arizona / local policy** that affects daily life (**schools**, **city** decisions, **infrastructure**, **housing**, **local government** initiatives)—not national partisan noise.

Set **exclude=true** if the story is mainly: **crime**, **violence**, **tragedy**, **serious accidents**; **national partisan politics**, **election controversies**, **divisive opinion** pieces; **war**; **celebrity gossip** with no Arizona tie; or **pure national** stories with no local hook.

Return JSON only:
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <short string or omit>}`;

  const user = `Headline & snippet:\n${text}\n\nSource URL: ${item.link}`;

  const raw = await openAiJson<ScoreResult>(system, user);
  const relevanceScore = Math.min(10, Math.max(1, Math.round(Number(raw.relevanceScore)) || 1));
  const result = {
    relevanceScore,
    exclude: Boolean(raw.exclude),
    excludeReason: raw.excludeReason,
  };
  console.log(
    `[google-news] ${label} → score: relevanceScore=${result.relevanceScore}, exclude=${result.exclude}` +
      (result.excludeReason ? `, excludeReason="${result.excludeReason}"` : '')
  );
  return result;
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

/**
 * Run targeted queries in order; merge unique stories by URL until `maxItems` or queries exhausted.
 */
async function collectGoogleNewsCandidates(
  maxItems: number
): Promise<{ items: SerpGoogleNewsItem[]; queriesUsed: number; lastError?: string }> {
  const seen = new Set<string>();
  const items: SerpGoogleNewsItem[] = [];
  let queriesUsed = 0;
  let lastError: string | undefined;

  for (let qi = 0; qi < GOOGLE_NEWS_SEARCH_QUERIES.length && items.length < maxItems; qi++) {
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
      for (const it of flat) {
        if (seen.has(it.link)) continue;
        seen.add(it.link);
        items.push(it);
        if (items.length >= maxItems) break;
      }

      console.log(
        `[google-news] ${label}: merged unique so far=${items.length} (target ≤${maxItems})`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      console.warn(`[google-news] ${label} ERROR: ${msg}`);
    }
  }

  return { items, queriesUsed, lastError };
}

/**
 * SerpApi Google News → score up to 10 headlines → keep top stories with score ≥ 6 → rewrite → Sanity (`news`, `google_news`).
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
    `[google-news] Config: maxFetch=${maxFetch}, maxPublishPerRun=${maxPublish} (top stories scoring ≥6)`
  );
  console.log(
    `[google-news] Search strategy: ${GOOGLE_NEWS_SEARCH_QUERIES.length} targeted metro/topic queries (merge unique URLs, cap ${maxFetch})`
  );

  const { items: flat, queriesUsed, lastError } = await collectGoogleNewsCandidates(maxFetch);

  if (flat.length === 0) {
    throw new Error(
      lastError
        ? `SerpApi Google News: no stories after ${queriesUsed} query/queries. Last error: ${lastError}`
        : `SerpApi Google News: no stories after ${queriesUsed} query/queries`
    );
  }

  const fetched = flat.length;
  console.log(`[google-news] Flattened stories to process: ${fetched} (cap maxFetch=${maxFetch})`);

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();
  console.log(
    `[google-news] Dedup: ${existingUrls.size} existing URL(s) in Sanity, ${existingSlugs.length} slug(s)`
  );

  type Scored = { item: SerpGoogleNewsItem; gate: ScoreResult; label: string };
  const scored: Scored[] = [];
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
      const gate = await scoreAndGate(item, label);
      if (gate.exclude || gate.relevanceScore < 6) {
        console.log(
          `[google-news] ${label} SKIP: exclude=${gate.exclude}, score=${gate.relevanceScore} (need ≥6)`
        );
        skipped++;
        continue;
      }
      scored.push({ item, gate, label });
    } catch (e) {
      errors++;
      console.error(
        `[google-news] ${label} scoring ERROR:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  scored.sort((a, b) => b.gate.relevanceScore - a.gate.relevanceScore);
  const toPublish = scored.slice(0, maxPublish);

  console.log(
    `[google-news] After scoring: ${scored.length} eligible (≥6, not excluded). Publishing top ${toPublish.length} (max ${maxPublish}):`
  );
  toPublish.forEach((s, idx) => {
    console.log(
      `[google-news]   #${idx + 1} score=${s.gate.relevanceScore} — ${s.item.title.slice(0, 90)}`
    );
  });

  if (scored.length > toPublish.length) {
    skipped += scored.length - toPublish.length;
    console.log(
      `[google-news] ${scored.length - toPublish.length} eligible story/stories not published (beyond maxPublishPerRun)`
    );
  }

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

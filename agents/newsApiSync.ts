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

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'googleNewsRewrite.prompt.txt');

const PRIMARY_Q = 'Phoenix Arizona local news';
const FALLBACK_Q = 'Arizona news';

/** Fast reject before AI — crime / tragedy / politics / accidents. */
const NEGATIVE_HEADLINE_RE =
  /murder|homicide|mass\s*shooting|killed in (a )?shooting|fatal (crash|collision|accident)|terror(ist|ism)?|suicide|sexual assault|kidnap|rape\b|school\s*shooting|capitol\s*riot|impeachment|white\s*house|congressional\s*hearing|supreme\s*court\s*(rules?|decides)|\bGOP\b|\bDNC\b|presidential\s*campaign|midterm\s*election/i;

export type SerpGoogleNewsItem = {
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

  const system = `You are an editor for HappyTimesAZ, a Phoenix AZ local lifestyle site.

Score how relevant and valuable this story is for **Phoenix-area locals** (1–10). Strongly prefer topics: **local business**, **economy**, **sports** (incl. Suns, Cardinals, Diamondbacks), **real estate / development**, **entertainment**, **tourism**, **community** news.

Set exclude=true if the story is primarily about: **crime**, **violence**, **tragedy**, **serious accidents**, **national or partisan politics** (Congress, campaigns, federal drama) as the main angle, **war**, or **celebrity gossip** with no Arizona/Phoenix tie.

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
 * SerpApi Google News → score up to 10 headlines → keep top 1–3 with score ≥ 7 → rewrite → Sanity (`news`, `google_news`).
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
    `[google-news] Config: maxFetch=${maxFetch}, maxPublishPerRun=${maxPublish} (top stories scoring ≥7)`
  );

  let { data, httpStatus } = await fetchSerpGoogleNews(PRIMARY_Q, 'primary');

  if (httpStatus !== 200 || data.error) {
    throw new Error(
      data.error || `SerpApi Google News HTTP ${httpStatus}`
    );
  }

  let flat = flattenGoogleNewsResults(data.news_results).slice(0, maxFetch);

  if (flat.length === 0) {
    console.log('[google-news] No results for primary q — trying fallback q…');
    const second = await fetchSerpGoogleNews(FALLBACK_Q, 'fallback');
    if (second.httpStatus !== 200 || second.data.error) {
      throw new Error(second.data.error || `SerpApi fallback HTTP ${second.httpStatus}`);
    }
    data = second.data;
    flat = flattenGoogleNewsResults(data.news_results).slice(0, maxFetch);
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
      if (gate.exclude || gate.relevanceScore < 7) {
        console.log(
          `[google-news] ${label} SKIP: exclude=${gate.exclude}, score=${gate.relevanceScore} (need ≥7)`
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
    `[google-news] After scoring: ${scored.length} eligible (≥7, not excluded). Publishing top ${toPublish.length} (max ${maxPublish}):`
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
      if (item.thumbnail) {
        console.log(`[google-news] ${pubLabel} hero upload…`);
        try {
          heroId = await uploadImageToSanity(
            item.thumbnail,
            `google-news-${article.slug.slice(0, 24)}.jpg`
          );
          console.log(`[google-news] ${pubLabel} hero asset=${heroId}`);
        } catch (e) {
          console.warn(
            `[google-news] ${pubLabel} hero upload failed:`,
            e instanceof Error ? e.message : e
          );
        }
      } else {
        console.log(`[google-news] ${pubLabel} no thumbnail; publishing without hero`);
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

import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';

import { config } from '../config';
import {
  getExistingNewsSourceUrls,
  getExistingSlugs,
  publishNewsApiArticleToSanity,
  uploadImageToSanity,
} from './sanityPublisher';
import { Article, validateArticle } from '../utils/validator';
import { ensureUniqueSlug, generateSlug } from '../utils/slug';

const NEWS_API_EVERYTHING = 'https://newsapi.org/v2/everything';

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'newsApiRewrite.prompt.txt');

/** Broad Phoenix-local query; last 24h + English + relevancy sort. */
const PHOENIX_QUERY = [
  '("Phoenix" OR "Maricopa County" OR Scottsdale OR Tempe OR Mesa OR Glendale OR Chandler)',
  'AND',
  '("Arizona" OR AZ)',
  'AND',
  '(',
  [
    'business',
    'economy',
    'development',
    '"real estate"',
    'city council',
    'community',
    'tourism',
    'entertainment',
    'Suns',
    'Cardinals',
    'Diamondbacks',
    'opening',
    'closing',
    'downtown',
    'stadium',
  ].join(' OR '),
  ')',
].join(' ');

/** Fast reject before AI — crime / tragedy / national politics noise. */
const NEGATIVE_HEADLINE_RE =
  /murder|homicide|mass\s*shooting|killed in (a )?shooting|fatal (crash|collision|accident)|terror(ist|ism)?|suicide|sexual assault|kidnapp|rape\b|school\s*shooting|capitol\s*riot|impeachment|white\s*house\s*briefing|congressional\s*hearing|supreme\s*court\s*(rules?|decides)/i;

type NewsApiArticle = {
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content?: string | null;
};

type NewsApiResponse = {
  status: string;
  totalResults?: number;
  articles?: NewsApiArticle[];
  message?: string;
  code?: string;
};

type ScoreResult = {
  relevanceScore: number;
  exclude: boolean;
  excludeReason?: string;
};

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

async function scoreAndGate(item: NewsApiArticle, label: string): Promise<ScoreResult> {
  const text = [item.title, item.description || '', item.content || ''].join('\n\n').slice(0, 12000);
  console.log(`[newsapi] ${label} → OpenAI: relevance scoring + exclude gate starting…`);

  const system = `You are an editor for a Phoenix AZ local lifestyle site HappyTimesAZ.

Score how relevant this story is to **Phoenix-area locals** (1-10): daily life, neighborhoods, local business, real estate, city projects, Valley economy, AZ pro sports (Suns, Cardinals, Diamondbacks), local entertainment, tourism, major community stories.

Set exclude=true if the story is primarily: crime/violence/tragedy, serious accidents, national politics (Congress/presidential campaigns/federal policy as main topic), war/international crisis, or gossip with no local Phoenix tie.

Return JSON only:
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <short string or omit>}`;

  const user = `Article:\n${text}\n\nSource URL: ${item.url}`;

  const raw = await openAiJson<ScoreResult>(system, user);
  const relevanceScore = Math.min(10, Math.max(1, Math.round(Number(raw.relevanceScore)) || 1));
  const result = {
    relevanceScore,
    exclude: Boolean(raw.exclude),
    excludeReason: raw.excludeReason,
  };
  console.log(
    `[newsapi] ${label} → score result: relevanceScore=${result.relevanceScore}, exclude=${result.exclude}` +
      (result.excludeReason ? `, excludeReason="${result.excludeReason}"` : '')
  );
  return result;
}

async function rewriteArticle(item: NewsApiArticle, label: string): Promise<Article> {
  console.log(`[newsapi] ${label} → AI rewrite starting (model=${config.openai.model})`);
  const system = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
  const basis = [
    `Title: ${item.title}`,
    item.description ? `Summary: ${item.description}` : '',
    item.content ? `Detail: ${item.content.slice(0, 8000)}` : '',
    `Link: ${item.url}`,
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
    throw new Error(`News rewrite validation failed: ${validation.errors?.join(', ')}`);
  }

  console.log(
    `[newsapi] ${label} → AI rewrite finished: title="${validation.data!.title.slice(0, 80)}${validation.data!.title.length > 80 ? '…' : ''}" slug=${validation.data!.slug}`
  );
  return validation.data!;
}

function passesKeywordGate(item: NewsApiArticle): boolean {
  const blob = `${item.title}\n${item.description || ''}`;
  if (NEGATIVE_HEADLINE_RE.test(blob)) return false;
  return true;
}

/**
 * Fetches Phoenix-area headlines from NewsAPI (24h), scores with AI (≥7 + not excluded), rewrites, publishes to Sanity.
 */
export async function syncNewsApiToSanity(): Promise<{
  fetched: number;
  published: number;
  skipped: number;
  errors: number;
}> {
  if (!config.newsApi.apiKey) {
    throw new Error('NEWS_API_KEY is not set');
  }

  const max = Math.min(10, config.newsApi.maxArticles);
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  console.log('[newsapi] ========== syncNewsApiToSanity start ==========');
  console.log(
    `[newsapi] Config: maxArticles=${max}, from=${from} (last 24h window end=now), sortBy=relevancy, language=en`
  );
  console.log(`[newsapi] Calling NewsAPI GET ${NEWS_API_EVERYTHING} (pageSize=${max})…`);

  const { data, status } = await axios.get<NewsApiResponse>(NEWS_API_EVERYTHING, {
    params: {
      q: PHOENIX_QUERY,
      language: 'en',
      sortBy: 'relevancy',
      pageSize: max,
      from,
      apiKey: config.newsApi.apiKey,
    },
    validateStatus: () => true,
  });

  console.log(
    `[newsapi] NewsAPI response: httpStatus=${status}, apiStatus=${data.status ?? 'n/a'}, totalResults=${data.totalResults ?? 'n/a'}`
  );

  if (status !== 200 || data.status !== 'ok' || !data.articles) {
    const errMsg = data.message || data.code || `NewsAPI error (HTTP ${status})`;
    console.error(`[newsapi] NewsAPI request failed or empty articles: ${errMsg}`);
    throw new Error(errMsg);
  }

  const returnedCount = data.articles.length;
  console.log(`[newsapi] Stories returned in this page: ${returnedCount} (capped by pageSize=${max})`);

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();
  console.log(
    `[newsapi] Dedup context: ${existingUrls.size} existing originalSourceUrl(s) in Sanity, ${existingSlugs.length} existing slug(s)`
  );

  let published = 0;
  let skipped = 0;
  let errors = 0;

  const articles = data.articles.slice(0, max);
  const fetched = articles.length;

  for (let i = 0; i < articles.length; i++) {
    const item = articles[i];
    const label = `story ${i + 1}/${articles.length}`;

    console.log(
      `[newsapi] --- ${label} --- title="${(item.title || '').slice(0, 100)}${(item.title || '').length > 100 ? '…' : ''}"`
    );
    console.log(`[newsapi] ${label} url=${item.url || '(missing)'}`);

    if (!item.url || !item.title) {
      console.log(`[newsapi] ${label} SKIP: missing url or title`);
      skipped++;
      continue;
    }

    if (existingUrls.has(item.url)) {
      console.log(`[newsapi] ${label} SKIP: duplicate originalSourceUrl already in Sanity`);
      skipped++;
      continue;
    }

    if (!passesKeywordGate(item)) {
      console.log(`[newsapi] ${label} SKIP: keyword gate (crime/tragedy/politics headline filter)`);
      skipped++;
      continue;
    }

    try {
      const gate = await scoreAndGate(item, label);
      console.log(
        `[newsapi] ${label} relevanceScore=${gate.relevanceScore} (need ≥7), exclude=${gate.exclude}`
      );

      if (gate.exclude) {
        console.log(
          `[newsapi] ${label} SKIP: AI exclude gate (${gate.excludeReason || 'no reason given'})`
        );
        skipped++;
        continue;
      }
      if (gate.relevanceScore < 7) {
        console.log(`[newsapi] ${label} SKIP: relevanceScore ${gate.relevanceScore} < 7`);
        skipped++;
        continue;
      }

      console.log(
        `[newsapi] ${label} SELECTED for publish pipeline (score ${gate.relevanceScore} ≥ 7, not excluded)`
      );

      const article = await rewriteArticle(item, label);
      article.slug = ensureUniqueSlug(article.slug || generateSlug(article.title), existingSlugs);
      existingSlugs.push(article.slug);

      let heroId: string | undefined;
      if (item.urlToImage) {
        console.log(`[newsapi] ${label} Hero image upload starting: ${item.urlToImage.slice(0, 80)}…`);
        try {
          heroId = await uploadImageToSanity(
            item.urlToImage,
            `newsapi-${article.slug.slice(0, 24)}.jpg`
          );
          console.log(`[newsapi] ${label} Hero image uploaded, asset _id=${heroId}`);
        } catch (e) {
          console.warn(
            `[newsapi] ${label} Hero upload failed (continuing without hero):`,
            e instanceof Error ? e.message : e
          );
        }
      } else {
        console.log(`[newsapi] ${label} No urlToImage from NewsAPI; publishing without hero`);
      }

      console.log(
        `[newsapi] ${label} Calling Sanity publish: slug=${article.slug} originalUrl=${item.url}`
      );
      await publishNewsApiArticleToSanity(article, heroId, item.url);
      existingUrls.add(item.url);
      published++;
      console.log(`[newsapi] ${label} Sanity publish completed ✓ title="${article.title}"`);
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[newsapi] ${label} ERROR: ${msg}`);
      if (e instanceof Error && e.stack) {
        console.error(`[newsapi] ${label} stack: ${e.stack}`);
      }
    }
  }

  console.log(
    `[newsapi] ========== syncNewsApiToSanity end: fetched=${fetched}, published=${published}, skipped=${skipped}, errors=${errors} ==========`
  );
  return { fetched, published, skipped, errors };
}

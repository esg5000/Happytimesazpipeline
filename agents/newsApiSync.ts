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

async function scoreAndGate(item: NewsApiArticle): Promise<ScoreResult> {
  const text = [item.title, item.description || '', item.content || ''].join('\n\n').slice(0, 12000);

  const system = `You are an editor for a Phoenix AZ local lifestyle site HappyTimesAZ.

Score how relevant this story is to **Phoenix-area locals** (1-10): daily life, neighborhoods, local business, real estate, city projects, Valley economy, AZ pro sports (Suns, Cardinals, Diamondbacks), local entertainment, tourism, major community stories.

Set exclude=true if the story is primarily: crime/violence/tragedy, serious accidents, national politics (Congress/presidential campaigns/federal policy as main topic), war/international crisis, or gossip with no local Phoenix tie.

Return JSON only:
{"relevanceScore": <1-10 integer>, "exclude": <boolean>, "excludeReason": <short string or omit>}`;

  const user = `Article:\n${text}\n\nSource URL: ${item.url}`;

  const raw = await openAiJson<ScoreResult>(system, user);
  const relevanceScore = Math.min(10, Math.max(1, Math.round(Number(raw.relevanceScore)) || 1));
  return {
    relevanceScore,
    exclude: Boolean(raw.exclude),
    excludeReason: raw.excludeReason,
  };
}

async function rewriteArticle(item: NewsApiArticle): Promise<Article> {
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

  if (status !== 200 || data.status !== 'ok' || !data.articles) {
    throw new Error(data.message || data.code || `NewsAPI error (HTTP ${status})`);
  }

  const existingUrls = await getExistingNewsSourceUrls();
  const existingSlugs = await getExistingSlugs();

  let published = 0;
  let skipped = 0;
  let errors = 0;

  const articles = data.articles.slice(0, max);
  const fetched = articles.length;

  for (const item of articles) {
    if (!item.url || !item.title) {
      skipped++;
      continue;
    }

    if (existingUrls.has(item.url)) {
      console.log(`[newsapi] Skip duplicate URL: ${item.url}`);
      skipped++;
      continue;
    }

    if (!passesKeywordGate(item)) {
      console.log(`[newsapi] Skip keyword gate: ${item.title}`);
      skipped++;
      continue;
    }

    try {
      const gate = await scoreAndGate(item);
      if (gate.exclude) {
        console.log(`[newsapi] Excluded by AI: ${item.title} (${gate.excludeReason || 'no reason'})`);
        skipped++;
        continue;
      }
      if (gate.relevanceScore < 7) {
        console.log(`[newsapi] Score ${gate.relevanceScore} < 7: ${item.title}`);
        skipped++;
        continue;
      }

      const article = await rewriteArticle(item);
      article.slug = ensureUniqueSlug(article.slug || generateSlug(article.title), existingSlugs);
      existingSlugs.push(article.slug);

      let heroId: string | undefined;
      if (item.urlToImage) {
        try {
          heroId = await uploadImageToSanity(
            item.urlToImage,
            `newsapi-${article.slug.slice(0, 24)}.jpg`
          );
        } catch (e) {
          console.warn(
            `[newsapi] Hero upload failed for "${item.title}":`,
            e instanceof Error ? e.message : e
          );
        }
      }

      await publishNewsApiArticleToSanity(article, heroId, item.url);
      existingUrls.add(item.url);
      published++;
      console.log(`[newsapi] Published: ${article.title}`);
    } catch (e) {
      errors++;
      console.error(`[newsapi] Failed on "${item.title}":`, e instanceof Error ? e.message : e);
    }
  }

  return { fetched, published, skipped, errors };
}

/**
 * Dashboard-driven article length + tone for GPT writer/ingest prompts.
 */

export type ArticleLength = 'short' | 'medium' | 'long';

export type ArticleTone =
  | 'straight-news'
  | 'satirical'
  | 'sarcastic'
  | 'educational'
  | 'opinion'
  | 'interview'
  | 'listicle';

export const DEFAULT_ARTICLE_LENGTH: ArticleLength = 'medium';
export const DEFAULT_ARTICLE_TONE: ArticleTone = 'straight-news';

const LENGTH_WORDS: Record<ArticleLength, number> = {
  short: 300,
  medium: 600,
  long: 1200,
};

const TONE_LABEL: Record<ArticleTone, string> = {
  'straight-news': 'Straight News',
  satirical: 'Satirical',
  sarcastic: 'Sarcastic',
  educational: 'Educational',
  opinion: 'Opinion',
  interview: 'Interview',
  listicle: 'Listicle',
};

const TONE_WRITER_GUIDANCE: Record<ArticleTone, string> = {
  'straight-news':
    'Write in a factual, neutral news style. Prioritize clarity and attribution; avoid unnecessary flourish.',
  satirical:
    'Write in a satirical mode (exaggeration for effect). The piece should read as deliberate satire, not as literal reporting of false events as real.',
  sarcastic:
    'Use dry, cutting sarcasm and wit. Do not fabricate direct quotes attributed to real people or organizations.',
  educational:
    'Explain clearly for a general reader: define terms, give context, and prioritize accuracy and usefulness.',
  opinion:
    'Take a clear editorial stance. First-person or strong thesis is appropriate; argue with reasons, not invented facts.',
  interview:
    'Prefer an interview or Q&A shape when the source material supports it; otherwise use a conversational structure with attributed perspectives.',
  listicle:
    'Lead with a numbered or list-forward structure; keep items scannable with short intros.',
};

/** Shared ending / spin rule for every article GPT call. */
export const ARTICLE_ENDING_AND_SPIN_RULE = `Do not add a positive spin, uplifting conclusion, or silver lining unless the tone selected is Straight News or Educational. End the article consistent with the selected tone. Do not resolve tension that is meant to remain unresolved.`;

export function normalizeArticleLength(raw: unknown): ArticleLength {
  if (typeof raw !== 'string') return DEFAULT_ARTICLE_LENGTH;
  const k = raw.trim().toLowerCase();
  if (k === 'short' || k === 'medium' || k === 'long') return k;
  return DEFAULT_ARTICLE_LENGTH;
}

export function normalizeArticleTone(raw: unknown): ArticleTone {
  if (typeof raw !== 'string') return DEFAULT_ARTICLE_TONE;
  const k = raw.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  const map: Record<string, ArticleTone> = {
    'straight-news': 'straight-news',
    straightnews: 'straight-news',
    news: 'straight-news',
    satirical: 'satirical',
    satire: 'satirical',
    sarcastic: 'sarcastic',
    educational: 'educational',
    education: 'educational',
    opinion: 'opinion',
    interview: 'interview',
    listicle: 'listicle',
  };
  return map[k] ?? DEFAULT_ARTICLE_TONE;
}

export function articleWordTarget(length: ArticleLength): number {
  return LENGTH_WORDS[length];
}

/** Read dashboard JSON/multipart fields `length` / `tone` (aliases: articleLength, articleTone). */
export function extractArticleStyleFromBody(body: unknown): {
  articleLength: ArticleLength;
  articleTone: ArticleTone;
} {
  if (!body || typeof body !== 'object') {
    return {
      articleLength: DEFAULT_ARTICLE_LENGTH,
      articleTone: DEFAULT_ARTICLE_TONE,
    };
  }
  const o = body as Record<string, unknown>;
  return {
    articleLength: normalizeArticleLength(o.length ?? o.articleLength),
    articleTone: normalizeArticleTone(o.tone ?? o.articleTone),
  };
}

/**
 * Appended to the writer system prompt (after base writer.prompt.txt).
 */
export function buildWriterArticleStyleAppend(
  length: ArticleLength,
  tone: ArticleTone
): string {
  const words = LENGTH_WORDS[length];
  const label = TONE_LABEL[tone];
  const toneLine = TONE_WRITER_GUIDANCE[tone];
  return `

---
RUN-SPECIFIC ARTICLE REQUIREMENTS (override any conflicting length/tone lines in the instructions above):

Target length: approximately ${words} words for the article body (bodyMarkdown). Adjust depth and number of sections accordingly.

Editorial tone: ${label}. ${toneLine}

${ARTICLE_ENDING_AND_SPIN_RULE}

Update the JSON instruction for bodyMarkdown length to reflect roughly ${words} words (not the older 650–900 word default when it conflicts).
`;
}

/**
 * Shorter append for ingest (topic extraction) so routing aligns with the eventual article.
 */
export function buildIngestArticleStyleAppend(
  length: ArticleLength,
  tone: ArticleTone
): string {
  const words = LENGTH_WORDS[length];
  const label = TONE_LABEL[tone];
  return `

---
UPCOMING ARTICLE (for topic shaping only):
The following article will target approximately ${words} words and use tone: ${label} (${TONE_WRITER_GUIDANCE[tone]})

${ARTICLE_ENDING_AND_SPIN_RULE}

Shape title, description, and keywords so they fit this tone and scope. Do not write the article here — only the topic JSON.
`;
}

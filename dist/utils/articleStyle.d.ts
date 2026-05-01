/**
 * Dashboard-driven article length + tone for GPT writer/ingest prompts.
 */
export type ArticleLength = 'short' | 'medium' | 'long';
export type ArticleTone = 'straight-news' | 'satirical' | 'sarcastic' | 'educational' | 'opinion' | 'interview' | 'listicle';
export declare const DEFAULT_ARTICLE_LENGTH: ArticleLength;
export declare const DEFAULT_ARTICLE_TONE: ArticleTone;
/** Shared ending / spin rule for every article GPT call. */
export declare const ARTICLE_ENDING_AND_SPIN_RULE = "Do not add a positive spin, uplifting conclusion, or silver lining unless the tone selected is Straight News or Educational. End the article consistent with the selected tone. Do not resolve tension that is meant to remain unresolved.";
export declare function normalizeArticleLength(raw: unknown): ArticleLength;
export declare function normalizeArticleTone(raw: unknown): ArticleTone;
export declare function articleWordTarget(length: ArticleLength): number;
/** Read dashboard JSON/multipart fields `length` / `tone` (aliases: articleLength, articleTone). */
export declare function extractArticleStyleFromBody(body: unknown): {
    articleLength: ArticleLength;
    articleTone: ArticleTone;
};
/**
 * Appended to the writer system prompt (after base writer.prompt.txt).
 */
export declare function buildWriterArticleStyleAppend(length: ArticleLength, tone: ArticleTone): string;
/**
 * Shorter append for ingest (topic extraction) so routing aligns with the eventual article.
 */
export declare function buildIngestArticleStyleAppend(length: ArticleLength, tone: ArticleTone): string;
//# sourceMappingURL=articleStyle.d.ts.map
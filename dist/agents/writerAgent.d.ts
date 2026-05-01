import { Article } from '../utils/validator';
import { Topic } from '../utils/validator';
import { type ArticleLength, type ArticleTone } from '../utils/articleStyle';
/** Byline stored on Sanity for pipeline-written posts (`publishArticleToSanity`). */
export declare const HAPPYTIMESAZ_EDITORIAL_AUTHOR = "HappyTimesAZ Editorial";
/** Stored on article when the editor uploaded real photos; hero is never AI-generated. */
export declare const EDITOR_SUPPLIED_HERO_IMAGE_PROMPT = "Editor-supplied photography only; no AI-generated hero image for this article.";
export type WriteArticleOptions = {
    /**
     * Raw notes from the editor (e.g. Telegram or dashboard). When set, the article body must
     * follow this material — do not substitute an unrelated topic or autonomous angle.
     */
    sourceNotes?: string;
    /**
     * When true, the pipeline will not call DALL·E; heroImagePrompt is set to a fixed placeholder.
     */
    userSuppliedImages?: boolean;
    /**
     * When true (dashboard `source: 'dashboard'` or `X-Client-Source: dashboard`), append length/tone
     * and spin/ending rules. Autonomous and Telegram paths omit this — base writer prompt only.
     */
    applyDashboardArticleStyle?: boolean;
    /** Used only when `applyDashboardArticleStyle` is true. Defaults: medium, straight-news. */
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
};
/**
 * Writes an article based on a topic.
 */
export declare function writeArticle(topic: Topic, options?: WriteArticleOptions): Promise<Article>;
//# sourceMappingURL=writerAgent.d.ts.map
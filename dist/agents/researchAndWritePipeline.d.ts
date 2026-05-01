import { Article } from '../utils/validator';
import { type ArticleLength, type ArticleTone } from '../utils/articleStyle';
import { type Source } from '../src/agents/researchAgent';
export type ResearchAndWriteOptions = {
    notes: string;
    applyDashboardArticleStyle: boolean;
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
    /** Dashboard byline; falls back to HappyTimesAZ Editorial. */
    authorName?: string;
    /**
     * Dig & Write: try Unsplash hero from topic + notes keywords first; otherwise same DALL·E path as below.
     * Just Write / autonomous orchestrator are unchanged.
     */
    digAndWrite?: boolean;
    /** Fired whenever merged sources update (parallel search angles complete). */
    onSourceProgress?: (payload: {
        sources: Source[];
    }) => void;
    /**
     * When true, runs the OpenAI fact-check pass (⚠️ markers) on the draft body before Sources.
     * Default false to save cost on typical Dig & Write runs.
     */
    runFactCheck?: boolean;
};
export type ResearchAndWriteResult = {
    article: Article;
    sources: Source[];
    /** Sanity image asset `_id` for hero (Unsplash or DALL·E). */
    heroImageAssetId?: string;
    heroImageSource: 'unsplash' | 'dall-e';
    /** Sanity draft post `_id` after `publishArticleToSanity`. */
    sanityDocumentId: string;
};
/**
 * Runs web research (with optional progress) in parallel with topic generation, then writes one article
 * using enriched research notes, optional fact-check (`runFactCheck`, default false), Sources section,
 * hero upload, and Sanity draft publish.
 */
export declare function runResearchAndWrite(options: ResearchAndWriteOptions): Promise<ResearchAndWriteResult>;
//# sourceMappingURL=researchAndWritePipeline.d.ts.map
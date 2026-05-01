import { type ArticleLength, type ArticleTone } from './utils/articleStyle';
/** Optional steering for topic generation (e.g. API /publish body `notes`). */
export type RunPipelineOptions = {
    notes?: string;
    /**
     * When true (dashboard-marked HTTP request only), topic + writer get length/tone + spin rules.
     * Cron / autonomous runs omit this — legacy prompts unchanged.
     */
    applyDashboardArticleStyle?: boolean;
    /** Only used when `applyDashboardArticleStyle` is true. */
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
};
/**
 * Main orchestrator for the AI publishing pipeline
 */
declare function runPipeline(options?: RunPipelineOptions): Promise<void>;
export { runPipeline };
//# sourceMappingURL=orchestrator.d.ts.map
import { Topic } from '../utils/validator';
import { type ArticleLength, type ArticleTone } from '../utils/articleStyle';
export type IngestInput = {
    section?: Topic['section'];
    title?: string;
    keywords?: string[];
    notes: string;
    /** Dashboard-only: length/tone + spin rules on ingest prompt. */
    applyDashboardArticleStyle?: boolean;
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
};
/**
 * Converts Telegram notes into a validated Topic JSON object.
 */
export declare function ingestToTopic(input: IngestInput): Promise<Topic>;
//# sourceMappingURL=ingestAgent.d.ts.map
import { Topic } from '../utils/validator';
import { type ArticleLength, type ArticleTone } from '../utils/articleStyle';
export type GenerateTopicsOptions = {
    /** Passed into each topic request to steer angles (e.g. API /publish). */
    notes?: string;
    /** Dashboard-only: length/tone + spin rules on topic prompt. */
    applyDashboardArticleStyle?: boolean;
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
};
/**
 * Generates article topics using OpenAI
 */
export declare function generateTopics(count?: number, options?: GenerateTopicsOptions): Promise<Topic[]>;
//# sourceMappingURL=topicAgent.d.ts.map
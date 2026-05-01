import { SanityClient } from '@sanity/client';
import { Article } from '../utils/validator';
/**
 * Initializes Sanity client
 */
export declare function getSanityClient(): SanityClient;
/**
 * Uploads an image to Sanity assets
 */
export declare function uploadImageToSanity(imageUrl: string, filename: string): Promise<string>;
/**
 * Uploads an image buffer to Sanity assets (e.g., Telegram photo)
 */
export declare function uploadImageBufferToSanity(imageBuffer: Buffer, filename: string): Promise<string>;
/** Upload a video (or any file) buffer to Sanity assets — returns file asset `_id`. */
export declare function uploadVideoBufferToSanity(buffer: Buffer, filename: string, contentType?: string): Promise<string>;
export declare function markdownToPortableText(markdown: string): any[];
export declare function publishArticleToSanity(article: Article, heroImageAssetId: string | undefined, section: string, additionalImageAssetIds?: string[], opts?: {
    videoAssetId?: string;
    authorName?: string;
}): Promise<string>;
/** SerpApi Google News sync slot ids (see agents/newsApiSync.ts). */
export declare const GOOGLE_NEWS_SYNC_SLOT_IDS: readonly ["slot-1-suns", "slot-2-sports", "slot-3-local", "slot-4-lifestyle", "slot-5-events"];
export type GoogleNewsSyncSlotId = (typeof GOOGLE_NEWS_SYNC_SLOT_IDS)[number];
export declare function parseGoogleNewsSlotId(slotLog: string): GoogleNewsSyncSlotId;
export type GoogleNewsPublishMeta = {
    slot: GoogleNewsSyncSlotId;
    /** Required context for slot-4: scorer picks one of food | nightlife | health-wellness | cannabis */
    slot4LifestyleCategory?: string;
};
export declare function resolveGoogleNewsPrimaryCategorySlug(meta: GoogleNewsPublishMeta): string;
/**
 * Publishes a SerpApi Google News wire article: `section` + primary `category` ref from slot metadata, source `google_news`, published + active.
 */
export declare function publishGoogleNewsArticleToSanity(article: Article, heroImageAssetId: string | undefined, originalSourceUrl: string, publishMeta: GoogleNewsPublishMeta): Promise<string>;
/**
 * URLs already ingested from wire sync (NewsAPI / Google News dedupe).
 */
export declare function getExistingNewsSourceUrls(): Promise<Set<string>>;
/**
 * Gets existing post slugs to check for uniqueness
 */
export declare function getExistingSlugs(): Promise<string[]>;
/**
 * Total number of post documents in the configured dataset (for API status).
 */
export declare function countPostDocuments(): Promise<number>;
//# sourceMappingURL=sanityPublisher.d.ts.map
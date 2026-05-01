import type { SectionSlug, VisualStyle } from './utils/validator';
export type TelegramDraftSession = {
    section?: SectionSlug;
    title?: string;
    keywords?: string[];
    visualStyle?: VisualStyle;
    notes: string[];
    photoFileId?: string;
    /** Legacy: single pre-upload hero (still honored if no pending/recent). */
    heroSanityAssetId?: string;
    /** POST /api/upload: rolling queue (max 5), order = upload order — first = hero on publish if no body images. */
    recentUploadAssetIds?: string[];
    /** POST /api/upload-video: single Sanity file asset for optional featured video on the post. */
    draftVideoAssetId?: string;
    /** Dashboard/API: up to 5 Sanity asset ids from publish body — first = hero, rest = additionalImages. */
    pendingImageAssetIds?: string[];
    /** @deprecated Ignored; first pending asset is always hero. Kept for old session JSON. */
    heroImageIndex?: number;
};
/**
 * Load sessions from disk into memory (survives Render cold starts when /tmp or path persists).
 */
export declare function hydrateTelegramSessionsFromDisk(): void;
export declare function persistTelegramSessions(): void;
export declare function getTelegramSession(chatId: number): TelegramDraftSession;
export declare function resetTelegramSession(chatId: number): TelegramDraftSession;
//# sourceMappingURL=telegramSessionStore.d.ts.map
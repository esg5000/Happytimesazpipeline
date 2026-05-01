import { Bot } from 'grammy';
import { type ArticleLength, type ArticleTone } from './utils/articleStyle';
/**
 * Run bot actions from the HTTP API (daemon). Uses the allowed user's private chat id.
 */
export declare function executeTelegramDaemonCommand(bot: Bot, chatId: number, command: '/publish' | '/new' | '/start'): Promise<void>;
/**
 * API/dashboard: treat `sourceNotes` as the full story source (like pasted Telegram text),
 * then run the same ingest → article → Sanity path as /publish in the bot.
 * Non-empty `imageAssetIds` replaces the draft and sets body images only (first = hero).
 * Otherwise merges notes and preserves `recentUploadAssetIds` from POST /api/upload.
 */
export declare function publishStoryFromSourceNotes(bot: Bot, chatId: number, sourceNotes: string, options?: {
    imageAssetIds?: string[];
    /** When true, GPT gets dashboard length/tone + spin rules (HTTP must set from `source: dashboard`). */
    applyDashboardArticleStyle?: boolean;
    articleLength?: ArticleLength;
    articleTone?: ArticleTone;
    /** Dashboard POST /publish: overrides Sanity `author` when non-empty. */
    authorName?: string;
}): Promise<void>;
export declare function registerTelegramHandlers(bot: Bot): void;
//# sourceMappingURL=telegramBotCore.d.ts.map
import { Bot } from 'grammy';
/**
 * Express app + Telegram webhook route, bound for cloud hosts (Render requires 0.0.0.0 + PORT).
 * Registers handlers, calls setWebhook with public URL, logs getWebhookInfo for debugging.
 */
export declare function startTelegramWebhookExpress(bot: Bot): Promise<void>;
//# sourceMappingURL=telegramHttpServer.d.ts.map
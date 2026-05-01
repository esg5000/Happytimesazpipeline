export declare const config: {
    openai: {
        apiKey: string;
        model: string;
    };
    /** Unsplash — Dig & Write hero on `POST /api/command/researchAndWrite` only. */
    unsplash: {
        accessKey: string;
    };
    sanity: {
        projectId: string;
        dataset: string;
        apiToken: string;
        apiVersion: string;
    };
    pipeline: {
        articlesPerDay: number;
        defaultSection: string;
        /** node-cron expression for daemonServer only (default 14:00 daily, server timezone e.g. UTC on Render) */
        cronSchedule: string;
    };
    serpApi: {
        /** SerpApi key — https://serpapi.com/manage-api-key */
        apiKey: string;
        /**
         * Weekly Monday 08:00 (server timezone). Override with SERPAPI_EVENTS_CRON.
         */
        cronSchedule: string;
    };
    /** Deactivate past events in Sanity (isActive → false). Default daily 01:00. */
    eventsCleanup: {
        cronSchedule: string;
    };
    /**
     * SerpApi Google News → Phoenix local rewrite. Uses SERPAPI_API_KEY (same as events).
     * GOOGLE_NEWS_CRON / NEWS_API_CRON: default 10:00 daily.
     */
    googleNews: {
        cronSchedule: string;
        /** Stories to pull from SerpApi per run (max 20). */
        maxFetch: number;
        /** After AI scoring (default ≥6; ≥4 if fewer than 3 remain after subject dedupe), publish at most this many per run (1–5). */
        maxPublishPerRun: number;
    };
    telegram: {
        botToken: string;
        allowedUserId: number;
        /** No trailing slash — avoids https://host//telegram/... when building webhook URL */
        webhookBaseUrl: string;
        webhookPathSecret: string;
        port: number;
    };
};
/** Full HTTPS URL Telegram should POST updates to (matches Express route). */
export declare function getTelegramWebhookFullUrl(): string;
export declare function validateConfig(): void;
export declare function validateTelegramBaseConfig(): void;
export declare function validateTelegramConfig(): void;
//# sourceMappingURL=config.d.ts.map
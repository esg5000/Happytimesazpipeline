/**
 * Scheduled daily batch only. Runs in the background; does not block Telegram HTTP handlers.
 * Overlapping cron ticks are skipped if the previous run is still in progress.
 */
declare function runScheduledPipeline(): Promise<void>;
/**
 * Weekly SerpApi Google Events → Sanity sync (separate schedule from the article pipeline).
 */
declare function runScheduledSerpApiEventsSync(): Promise<void>;
/**
 * Daily SerpApi Google News → rewrite → Sanity (Phoenix local; uses SERPAPI_API_KEY).
 */
declare function runScheduledGoogleNewsSync(): Promise<void>;
/**
 * Daily: set `isActive` false on `event` documents whose `date` is in the past.
 */
declare function runScheduledPastEventsCleanup(): Promise<void>;
/**
 * Long-lived process for Render (or similar): Telegram webhook + daily pipeline via node-cron.
 * Does not exit after a pipeline run. Telegram and the scheduler share the process only; handlers are independent.
 *
 * Browser CORS for /api/* is configured in `telegramHttpServer.ts` via `CORS_ORIGINS` (e.g. your Vercel dashboard URL).
 */
declare function main(): Promise<void>;
export { main, runScheduledGoogleNewsSync, runScheduledPastEventsCleanup, runScheduledSerpApiEventsSync, runScheduledPipeline, };
/** Alias for older imports — same as runScheduledGoogleNewsSync */
export { runScheduledGoogleNewsSync as runScheduledNewsApiSync };
//# sourceMappingURL=daemonServer.d.ts.map
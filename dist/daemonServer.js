"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
exports.runScheduledGoogleNewsSync = runScheduledGoogleNewsSync;
exports.runScheduledNewsApiSync = runScheduledGoogleNewsSync;
exports.runScheduledPastEventsCleanup = runScheduledPastEventsCleanup;
exports.runScheduledSerpApiEventsSync = runScheduledSerpApiEventsSync;
exports.runScheduledPipeline = runScheduledPipeline;
const node_cron_1 = __importDefault(require("node-cron"));
const grammy_1 = require("grammy");
const config_1 = require("./config");
const eventCleanup_1 = require("./agents/eventCleanup");
const newsApiSync_1 = require("./agents/newsApiSync");
const serpApiEventsSync_1 = require("./agents/serpApiEventsSync");
const pipelineRunner_1 = require("./pipelineRunner");
const telegramHttpServer_1 = require("./telegramHttpServer");
let scheduledPipelineRunning = false;
let serpApiEventsSyncRunning = false;
let eventsCleanupRunning = false;
let googleNewsSyncRunning = false;
/**
 * Scheduled daily batch only. Runs in the background; does not block Telegram HTTP handlers.
 * Overlapping cron ticks are skipped if the previous run is still in progress.
 */
async function runScheduledPipeline() {
    if (scheduledPipelineRunning) {
        console.log('[scheduler] Skipping tick: previous scheduled pipeline still running');
        return;
    }
    scheduledPipelineRunning = true;
    try {
        console.log('[scheduler] Starting scheduled daily pipeline…');
        const { skipped } = await (0, pipelineRunner_1.runPipelineJob)();
        if (skipped) {
            console.log('[scheduler] Skipping: a pipeline run is already in progress (e.g. API /publish)');
        }
    }
    catch (err) {
        console.error('[scheduler] Scheduled pipeline failed:', err);
    }
    finally {
        scheduledPipelineRunning = false;
    }
}
/**
 * Weekly SerpApi Google Events → Sanity sync (separate schedule from the article pipeline).
 */
async function runScheduledSerpApiEventsSync() {
    if (!config_1.config.serpApi.apiKey) {
        return;
    }
    if (serpApiEventsSyncRunning) {
        console.log('[serpapi] Skipping tick: previous Google Events sync still running');
        return;
    }
    serpApiEventsSyncRunning = true;
    try {
        console.log('[serpapi] Starting Google Events (SerpApi) → Sanity sync…');
        const { synced, skipped, errors } = await (0, serpApiEventsSync_1.syncSerpApiEventsToSanity)();
        console.log(`[serpapi] Sync done — synced: ${synced}, skipped: ${skipped}, errors: ${errors}`);
    }
    catch (err) {
        console.error('[serpapi] Sync failed:', err);
    }
    finally {
        serpApiEventsSyncRunning = false;
    }
}
/**
 * Daily SerpApi Google News → rewrite → Sanity (Phoenix local; uses SERPAPI_API_KEY).
 */
async function runScheduledGoogleNewsSync() {
    if (!config_1.config.serpApi.apiKey) {
        return;
    }
    if (googleNewsSyncRunning) {
        console.log('[google-news] Skipping tick: previous Google News sync still running');
        return;
    }
    googleNewsSyncRunning = true;
    try {
        console.log('[google-news] Starting SerpApi Google News → Sanity sync…');
        const { fetched, published, skipped, errors } = await (0, newsApiSync_1.syncNewsApiToSanity)();
        console.log(`[google-news] Done — fetched: ${fetched}, published: ${published}, skipped: ${skipped}, errors: ${errors}`);
    }
    catch (err) {
        console.error('[google-news] Sync failed:', err);
    }
    finally {
        googleNewsSyncRunning = false;
    }
}
/**
 * Daily: set `isActive` false on `event` documents whose `date` is in the past.
 */
async function runScheduledPastEventsCleanup() {
    if (eventsCleanupRunning) {
        console.log('[events-cleanup] Skipping tick: previous run still in progress');
        return;
    }
    eventsCleanupRunning = true;
    try {
        console.log('[events-cleanup] Deactivating past events…');
        const { deactivated, errors } = await (0, eventCleanup_1.deactivatePastEvents)();
        console.log(`[events-cleanup] Done — deactivated: ${deactivated}, errors: ${errors}`);
    }
    catch (err) {
        console.error('[events-cleanup] Failed:', err);
    }
    finally {
        eventsCleanupRunning = false;
    }
}
/**
 * Long-lived process for Render (or similar): Telegram webhook + daily pipeline via node-cron.
 * Does not exit after a pipeline run. Telegram and the scheduler share the process only; handlers are independent.
 *
 * Browser CORS for /api/* is configured in `telegramHttpServer.ts` via `CORS_ORIGINS` (e.g. your Vercel dashboard URL).
 */
async function main() {
    (0, config_1.validateConfig)();
    (0, config_1.validateTelegramConfig)();
    const cronExpr = config_1.config.pipeline.cronSchedule;
    node_cron_1.default.schedule(cronExpr, () => {
        void runScheduledPipeline();
    });
    console.log(`[scheduler] Daily pipeline cron registered (${cronExpr}, server local timezone)`);
    const serpCron = config_1.config.serpApi.cronSchedule;
    node_cron_1.default.schedule(serpCron, () => {
        void runScheduledSerpApiEventsSync();
    });
    console.log(`[scheduler] SerpApi Google Events cron registered (${serpCron}, weekly Monday 08:00 default; server local timezone)`);
    const cleanupCron = config_1.config.eventsCleanup.cronSchedule;
    node_cron_1.default.schedule(cleanupCron, () => {
        void runScheduledPastEventsCleanup();
    });
    console.log(`[scheduler] Past-events cleanup cron registered (${cleanupCron}, server local timezone)`);
    const googleNewsCron = config_1.config.googleNews.cronSchedule;
    node_cron_1.default.schedule(googleNewsCron, () => {
        void runScheduledGoogleNewsSync();
    });
    console.log(`[scheduler] SerpApi Google News sync cron registered (${googleNewsCron}, default 10:00 daily; server local timezone)`);
    const bot = new grammy_1.Bot(config_1.config.telegram.botToken);
    await (0, telegramHttpServer_1.startTelegramWebhookExpress)(bot);
}
if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal daemon error:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=daemonServer.js.map
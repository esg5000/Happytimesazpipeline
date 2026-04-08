import cron from 'node-cron';
import { Bot } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { deactivatePastEvents } from './agents/eventCleanup';
import { syncNewsApiToSanity } from './agents/newsApiSync';
import { syncSerpApiEventsToSanity } from './agents/serpApiEventsSync';
import { runPipelineJob } from './pipelineRunner';
import { startTelegramWebhookExpress } from './telegramHttpServer';

let scheduledPipelineRunning = false;
let serpApiEventsSyncRunning = false;
let eventsCleanupRunning = false;
let googleNewsSyncRunning = false;

/**
 * Scheduled daily batch only. Runs in the background; does not block Telegram HTTP handlers.
 * Overlapping cron ticks are skipped if the previous run is still in progress.
 */
async function runScheduledPipeline(): Promise<void> {
  if (scheduledPipelineRunning) {
    console.log(
      '[scheduler] Skipping tick: previous scheduled pipeline still running'
    );
    return;
  }
  scheduledPipelineRunning = true;
  try {
    console.log('[scheduler] Starting scheduled daily pipeline…');
    const { skipped } = await runPipelineJob();
    if (skipped) {
      console.log(
        '[scheduler] Skipping: a pipeline run is already in progress (e.g. API /publish)'
      );
    }
  } catch (err) {
    console.error('[scheduler] Scheduled pipeline failed:', err);
  } finally {
    scheduledPipelineRunning = false;
  }
}

/**
 * Weekly SerpApi Google Events → Sanity sync (separate schedule from the article pipeline).
 */
async function runScheduledSerpApiEventsSync(): Promise<void> {
  if (!config.serpApi.apiKey) {
    return;
  }
  if (serpApiEventsSyncRunning) {
    console.log('[serpapi] Skipping tick: previous Google Events sync still running');
    return;
  }
  serpApiEventsSyncRunning = true;
  try {
    console.log('[serpapi] Starting Google Events (SerpApi) → Sanity sync…');
    const { synced, skipped, errors } = await syncSerpApiEventsToSanity();
    console.log(
      `[serpapi] Sync done — synced: ${synced}, skipped: ${skipped}, errors: ${errors}`
    );
  } catch (err) {
    console.error('[serpapi] Sync failed:', err);
  } finally {
    serpApiEventsSyncRunning = false;
  }
}

/**
 * Daily SerpApi Google News → rewrite → Sanity (Phoenix local; uses SERPAPI_API_KEY).
 */
async function runScheduledGoogleNewsSync(): Promise<void> {
  if (!config.serpApi.apiKey) {
    return;
  }
  if (googleNewsSyncRunning) {
    console.log('[google-news] Skipping tick: previous Google News sync still running');
    return;
  }
  googleNewsSyncRunning = true;
  try {
    console.log('[google-news] Starting SerpApi Google News → Sanity sync…');
    const { fetched, published, skipped, errors } = await syncNewsApiToSanity();
    console.log(
      `[google-news] Done — fetched: ${fetched}, published: ${published}, skipped: ${skipped}, errors: ${errors}`
    );
  } catch (err) {
    console.error('[google-news] Sync failed:', err);
  } finally {
    googleNewsSyncRunning = false;
  }
}

/**
 * Daily: set `isActive` false on `event` documents whose `date` is in the past.
 */
async function runScheduledPastEventsCleanup(): Promise<void> {
  if (eventsCleanupRunning) {
    console.log('[events-cleanup] Skipping tick: previous run still in progress');
    return;
  }
  eventsCleanupRunning = true;
  try {
    console.log('[events-cleanup] Deactivating past events…');
    const { deactivated, errors } = await deactivatePastEvents();
    console.log(
      `[events-cleanup] Done — deactivated: ${deactivated}, errors: ${errors}`
    );
  } catch (err) {
    console.error('[events-cleanup] Failed:', err);
  } finally {
    eventsCleanupRunning = false;
  }
}

/**
 * Long-lived process for Render (or similar): Telegram webhook + daily pipeline via node-cron.
 * Does not exit after a pipeline run. Telegram and the scheduler share the process only; handlers are independent.
 *
 * Browser CORS for /api/* is configured in `telegramHttpServer.ts` via `CORS_ORIGINS` (e.g. your Vercel dashboard URL).
 */
async function main(): Promise<void> {
  validateConfig();
  validateTelegramConfig();

  const cronExpr = config.pipeline.cronSchedule;
  cron.schedule(cronExpr, () => {
    void runScheduledPipeline();
  });
  console.log(
    `[scheduler] Daily pipeline cron registered (${cronExpr}, server local timezone)`
  );

  const serpCron = config.serpApi.cronSchedule;
  cron.schedule(serpCron, () => {
    void runScheduledSerpApiEventsSync();
  });
  console.log(
    `[scheduler] SerpApi Google Events cron registered (${serpCron}, weekly Monday 08:00 default; server local timezone)`
  );

  const cleanupCron = config.eventsCleanup.cronSchedule;
  cron.schedule(cleanupCron, () => {
    void runScheduledPastEventsCleanup();
  });
  console.log(
    `[scheduler] Past-events cleanup cron registered (${cleanupCron}, server local timezone)`
  );

  const googleNewsCron = config.googleNews.cronSchedule;
  cron.schedule(googleNewsCron, () => {
    void runScheduledGoogleNewsSync();
  });
  console.log(
    `[scheduler] SerpApi Google News sync cron registered (${googleNewsCron}, default 10:00 daily; server local timezone)`
  );

  const bot = new Bot(config.telegram.botToken);
  await startTelegramWebhookExpress(bot);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal daemon error:', err);
    process.exit(1);
  });
}

export {
  main,
  runScheduledGoogleNewsSync,
  runScheduledPastEventsCleanup,
  runScheduledSerpApiEventsSync,
  runScheduledPipeline,
};
/** Alias for older imports — same as runScheduledGoogleNewsSync */
export { runScheduledGoogleNewsSync as runScheduledNewsApiSync };

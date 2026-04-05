import cron from 'node-cron';
import { Bot } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { runPipelineJob } from './pipelineRunner';
import { startTelegramWebhookExpress } from './telegramHttpServer';

let scheduledPipelineRunning = false;

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

  const bot = new Bot(config.telegram.botToken);
  await startTelegramWebhookExpress(bot);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal daemon error:', err);
    process.exit(1);
  });
}

export { main, runScheduledPipeline };

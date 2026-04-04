import cron from 'node-cron';
import { Bot } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { recordScheduledPipelineFinish } from './pipelineStatus';
import { runPipeline } from './orchestrator';
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
    await runPipeline();
    recordScheduledPipelineFinish(true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scheduler] Scheduled pipeline failed:', err);
    recordScheduledPipelineFinish(false, msg);
  } finally {
    scheduledPipelineRunning = false;
  }
}

/**
 * Long-lived process for Render (or similar): Telegram webhook + daily pipeline via node-cron.
 * Does not exit after a pipeline run. Telegram and the scheduler share the process only; handlers are independent.
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

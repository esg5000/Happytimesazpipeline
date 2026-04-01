import express from 'express';
import cron from 'node-cron';
import { Bot, webhookCallback } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { registerTelegramHandlers } from './telegramBotCore';
import { runPipeline } from './orchestrator';

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
  } catch (err) {
    console.error('[scheduler] Scheduled pipeline failed:', err);
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
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const webhookPath = `/telegram/webhook/${config.telegram.webhookPathSecret}`;
  app.post(webhookPath, webhookCallback(bot, 'express'));
  app.get('/health', (_req, res) => res.status(200).send('ok'));

  registerTelegramHandlers(bot);

  app.listen(config.telegram.port, async () => {
    const webhookUrl = `${config.telegram.webhookBaseUrl}${webhookPath}`;
    await bot.api.setWebhook(webhookUrl);
    console.log(`Telegram webhook set: ${webhookUrl}`);
    console.log(`Listening on port ${config.telegram.port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal daemon error:', err);
    process.exit(1);
  });
}

export { main, runScheduledPipeline };

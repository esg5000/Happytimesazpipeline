import express from 'express';
import { Bot, webhookCallback } from 'grammy';

import { config, getTelegramWebhookFullUrl } from './config';
import { registerTelegramHandlers } from './telegramBotCore';

const RENDER_HOST = '0.0.0.0';

/**
 * Express app + Telegram webhook route, bound for cloud hosts (Render requires 0.0.0.0 + PORT).
 * Registers handlers, calls setWebhook with public URL, logs getWebhookInfo for debugging.
 */
export async function startTelegramWebhookExpress(bot: Bot): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const webhookPath = `/telegram/webhook/${config.telegram.webhookPathSecret}`;
  app.post(webhookPath, webhookCallback(bot, 'express'));
  app.get('/health', (_req, res) => res.status(200).send('ok'));

  registerTelegramHandlers(bot);

  const webhookUrl = getTelegramWebhookFullUrl();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(
      config.telegram.port,
      RENDER_HOST,
      async () => {
        try {
          console.log(
            `[telegram] HTTP listening on http://${RENDER_HOST}:${config.telegram.port} (POST ${webhookPath})`
          );
          await bot.api.setWebhook(webhookUrl);
          console.log(`[telegram] setWebhook registered: ${webhookUrl}`);

          const info = await bot.api.getWebhookInfo();
          const summary = {
            url: info.url,
            pending_update_count: info.pending_update_count,
            last_error_message: info.last_error_message,
            last_error_date: info.last_error_date,
            max_connections: info.max_connections,
          };
          console.log('[telegram] getWebhookInfo:', JSON.stringify(summary));

          if (info.url && info.url !== webhookUrl) {
            console.warn(
              `[telegram] URL mismatch: Telegram has "${info.url}" but this deploy set "${webhookUrl}". Update TELEGRAM_WEBHOOK_BASE_URL or deleteWebhook + redeploy.`
            );
          }
          if (info.last_error_message) {
            console.warn('[telegram] Telegram last_error_message:', info.last_error_message);
          }

          resolve();
        } catch (err) {
          console.error('[telegram] setWebhook / getWebhookInfo failed:', err);
          reject(err);
        }
      }
    );

    server.on('error', (err) => {
      console.error('[telegram] HTTP server error:', err);
      reject(err);
    });
  });
}

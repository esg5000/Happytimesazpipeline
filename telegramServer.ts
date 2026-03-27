import express from 'express';
import { Bot, webhookCallback } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { registerTelegramHandlers } from './telegramBotCore';

async function main(): Promise<void> {
  validateConfig();
  validateTelegramConfig();

  const bot = new Bot(config.telegram.botToken);

  const app = express();
  app.use(express.json({ limit: '20mb' })); // allow Telegram payloads

  // Webhook endpoint (secret in path)
  const webhookPath = `/telegram/webhook/${config.telegram.webhookPathSecret}`;

  app.post(webhookPath, webhookCallback(bot, 'express'));

  // Basic health route
  app.get('/health', (_req, res) => res.status(200).send('ok'));

  registerTelegramHandlers(bot);

  // Start server + set webhook
  app.listen(config.telegram.port, async () => {
    const webhookUrl = `${config.telegram.webhookBaseUrl}${webhookPath}`;
    await bot.api.setWebhook(webhookUrl);
    console.log(`Telegram webhook set: ${webhookUrl}`);
    console.log(`Listening on port ${config.telegram.port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal Telegram server error:', err);
    process.exit(1);
  });
}

export { main };


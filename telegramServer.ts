import { Bot } from 'grammy';

import { config, validateConfig, validateTelegramConfig } from './config';
import { startTelegramWebhookExpress } from './telegramHttpServer';

async function main(): Promise<void> {
  validateConfig();
  validateTelegramConfig();

  const bot = new Bot(config.telegram.botToken);
  await startTelegramWebhookExpress(bot);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal Telegram server error:', err);
    process.exit(1);
  });
}

export { main };


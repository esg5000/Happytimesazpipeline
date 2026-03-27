import { Bot } from 'grammy';
import {
  config,
  validateConfig,
  validateTelegramBaseConfig,
} from './config';
import { registerTelegramHandlers } from './telegramBotCore';

async function main(): Promise<void> {
  validateConfig();
  validateTelegramBaseConfig();

  const bot = new Bot(config.telegram.botToken);
  registerTelegramHandlers(bot);

  // In polling mode we clear webhook so updates are delivered to getUpdates.
  await bot.api.deleteWebhook({ drop_pending_updates: false });

  await bot.start();
  console.log('Telegram polling dev bot started');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal Telegram polling error:', err);
    process.exit(1);
  });
}

export { main };


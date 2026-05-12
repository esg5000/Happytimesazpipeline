import { validateConfig } from './config';
import { startApiServer } from './telegramHttpServer';

async function main(): Promise<void> {
  validateConfig();
  await startApiServer();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal Telegram server error:', err);
    process.exit(1);
  });
}

export { main };


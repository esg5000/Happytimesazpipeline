import { validateConfig } from '../config';
import { syncDispensariesToSanity } from '../agents/syncDispensaries';

async function main(): Promise<void> {
  validateConfig();
  const { uniqueFound, saved, errors } = await syncDispensariesToSanity();
  console.log('');
  console.log('[dispensaries] Summary');
  console.log(`  Unique dispensaries found (after dedupe): ${uniqueFound}`);
  console.log(`  Saved to Sanity: ${saved}`);
  console.log(`  Errors: ${errors}`);
}

main().catch((e) => {
  console.error('[dispensaries] Fatal:', e);
  process.exit(1);
});

/**
 * Verification script for the Bright Data → SerpAPI Stage 0 provider swap.
 * Runs the real runStage0Discovery() against live Bright Data / SerpAPI and
 * prints the provider usage split plus a sample of the resulting
 * RawNewsItem[] pool, to confirm the Bright Data adapter output matches the
 * shape Stage 1 already expects. Not wired into any pipeline entry point.
 */
import { runStage0Discovery } from '../src/agents/topicDiscovery';

async function main() {
  const result = await runStage0Discovery();

  console.log('\n=== Provider usage ===');
  console.log(JSON.stringify(result.usage, null, 2));

  console.log('\n=== Sample capped pool items (first 5) ===');
  for (const item of result.pool.slice(0, 5)) {
    console.log(JSON.stringify(item, null, 2));
  }

  console.log(`\nTotal capped pool size: ${result.pool.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

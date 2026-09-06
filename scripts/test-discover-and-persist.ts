import { discoverAndPersistTopics } from '../src/agents/orchestratorV2';

async function main() {
  const result = await discoverAndPersistTopics();
  console.log('\n=== Result ===');
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });

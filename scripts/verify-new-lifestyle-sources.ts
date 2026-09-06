/**
 * Full test cycle for the 3 new lifestyle-az queries (Experience Scottsdale,
 * WestWorld of Scottsdale, Visit Mesa/Tempe): runs the real Stage 0 → Stage 1
 * shadow pipeline ONCE end-to-end (live data, so a second separate Stage 0
 * call would fetch a different snapshot and links wouldn't line up) and
 * reports which of the new-source candidates survived dedupe, whether they
 * survived STAGE1_CANDIDATE_CAP, and how each was classified by Stage 1 —
 * kept, skipped (with reason), or cut by the cap before ever reaching
 * Stage 1. No special-casing of any kind is added; this only cross-
 * references the real runTopicDiscoveryShadow() output by link. Throwaway
 * verification script, not wired into any pipeline entry point.
 */
import { runTopicDiscoveryShadow } from '../src/agents/topicDiscovery';

const NEW_QUERIES = new Set([
  '"Experience Scottsdale" event OR festival',
  '"WestWorld of Scottsdale" event',
  '"Visit Mesa" event OR "Visit Tempe" event',
]);

async function main() {
  const shadow = await runTopicDiscoveryShadow();

  const nearDedupedNew = shadow.nearDedupedPool.filter((it) => NEW_QUERIES.has(it.matchedQuery));
  console.log(`\n=== New-source candidates in near-deduped pool (pre-cap) ===`);
  console.log(`${nearDedupedNew.length} item(s)`);
  for (const it of nearDedupedNew) {
    console.log(`  - [${it.matchedQuery}] "${it.title}"`);
  }

  const keptByLink = new Map(shadow.kept.map((k) => [k.link, k]));
  const skippedByLink = new Map(shadow.skipped.map((s) => [s.link, s]));

  console.log(`\n=== Fate of each new-source candidate ===`);
  for (const it of nearDedupedNew) {
    const kept = keptByLink.get(it.link);
    const skipped = skippedByLink.get(it.link);
    if (kept) {
      console.log(`  KEPT     [${it.matchedQuery}] "${it.title}" → section=${(kept as any).section}`);
    } else if (skipped) {
      console.log(`  SKIPPED  [${it.matchedQuery}] "${it.title}" → reason=${skipped.reason}`);
    } else {
      console.log(`  CUT BY CAP (never reached Stage 1) [${it.matchedQuery}] "${it.title}"`);
    }
  }

  const cannabisReserveNote = shadow.reservedLifestyleItems.filter((it) => NEW_QUERIES.has(it.matchedQuery));
  console.log(`\n=== New-source items that won a lifestyle reserved slot ===`);
  console.log(`${cannabisReserveNote.length}/${shadow.reservedLifestyleItems.length} reserved lifestyle slots`);
  for (const it of cannabisReserveNote) {
    console.log(`  - [${it.matchedQuery}] "${it.title}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

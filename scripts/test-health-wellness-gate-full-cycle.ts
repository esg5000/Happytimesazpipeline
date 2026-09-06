/**
 * Full Stage 0 → Stage 1 test cycle (real live data, no Sanity writes —
 * runTopicDiscoveryShadow never publishes) to confirm the health-wellness-az
 * locality exception in production conditions: reports health-wellness-az's
 * kept/skipped breakdown (specifically how many were kept via the new
 * exception vs. dropped for a genuine non-locality reason like crime/
 * editorial-fit), and confirms every other query class's national-skip
 * drop behavior is unchanged. Throwaway script, makes no writes.
 */
import { runTopicDiscoveryShadow } from '../src/agents/topicDiscovery';

async function main() {
  const result = await runTopicDiscoveryShadow();

  const hwKept = result.kept.filter((k) => {
    // kept items don't carry queryClass directly, but health-wellness
    // section + no other section legitimately maps 1:1 for this check
    // combined with a title/link cross-reference against the reserved
    // pool below.
    return true;
  });

  // Cross-reference against the near-deduped pool (which DOES carry
  // queryClass) to get an accurate per-class breakdown.
  const linkToClass = new Map(result.nearDedupedPool.map((it) => [it.link, it.queryClass]));

  const byClassKept = new Map<string, number>();
  for (const k of result.kept) {
    const cls = linkToClass.get(k.link) || 'unknown';
    byClassKept.set(cls, (byClassKept.get(cls) || 0) + 1);
  }
  const byClassSkipped = new Map<string, number>();
  for (const s of result.skipped) {
    const cls = linkToClass.get(s.link) || 'unknown';
    byClassSkipped.set(cls, (byClassSkipped.get(cls) || 0) + 1);
  }

  console.log('\n=== Kept, by query class ===');
  for (const [cls, n] of byClassKept) console.log(`  ${cls}: ${n}`);
  console.log('\n=== Skipped, by query class ===');
  for (const [cls, n] of byClassSkipped) console.log(`  ${cls}: ${n}`);

  console.log('\n=== health-wellness-az kept candidates (verdict/section shown) ===');
  const hwLinks = new Set(
    result.nearDedupedPool.filter((it) => it.queryClass === 'health-wellness-az').map((it) => it.link)
  );
  for (const k of result.kept) {
    if (hwLinks.has(k.link)) {
      console.log(`  KEPT [verdict=${k.verdict}, section=${k.section}] "${k.title}"`);
    }
  }
  console.log('\n=== health-wellness-az skipped candidates (reason shown) ===');
  for (const s of result.skipped) {
    if (hwLinks.has(s.link)) {
      console.log(`  SKIPPED [${s.reason}] "${s.title}"`);
    }
  }

  const hwCappedTotal = hwLinks.size;
  const hwKeptCount = result.kept.filter((k) => hwLinks.has(k.link)).length;
  const hwSkippedCount = result.skipped.filter((s) => hwLinks.has(s.link)).length;
  console.log(
    `\nhealth-wellness-az capped-pool pass rate this run: ${hwKeptCount}/${hwCappedTotal} kept (${hwSkippedCount} skipped)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

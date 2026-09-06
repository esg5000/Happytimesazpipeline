import { getSanityClient } from '../agents/sanityPublisher';

async function main() {
  const client = getSanityClient();
  const rows = await client.fetch<any[]>(
    `*[_type == "topicCandidate"]{ _id, title, sourceUrl, section, status, discoveredAt, processingNote } | order(discoveredAt asc)`
  );

  const byRun = new Map<string, any[]>();
  for (const r of rows) {
    const list = byRun.get(r.discoveredAt) || [];
    list.push(r);
    byRun.set(r.discoveredAt, list);
  }
  const runs = [...byRun.keys()].sort();
  console.log(`Distinct discoverTopics runs (by exact discoveredAt timestamp): ${runs.length}`);
  runs.forEach((t) => console.log(`  ${t}: ${byRun.get(t)!.length} candidates persisted`));

  console.log('\n=== Overlap between each run and the UNION of all prior runs (by sourceUrl) ===');
  const seenUrls = new Set<string>();
  for (const t of runs) {
    const items = byRun.get(t)!;
    const repeats = items.filter((it) => seenUrls.has(it.sourceUrl));
    console.log(`  ${t}: ${items.length} total, ${repeats.length} already seen in an earlier run (${((repeats.length/items.length)*100).toFixed(1)}%)`);
    for (const it of items) seenUrls.add(it.sourceUrl);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

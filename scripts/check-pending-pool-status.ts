import { getSanityClient } from '../agents/sanityPublisher';

async function main() {
  const client = getSanityClient();
  const rows = await client.fetch<any[]>(
    `*[_type == "topicCandidate"]{ _id, title, sourceUrl, section, status, discoveredAt } | order(discoveredAt asc)`
  );
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  console.log('By status:', JSON.stringify(Object.fromEntries(byStatus), null, 2));

  const pending = rows.filter((r) => r.status === 'pending');
  console.log(`\nCurrently PENDING (visible in dashboard pool right now): ${pending.length}`);
  const byDay = new Map<string, number>();
  for (const r of pending) {
    const d = r.discoveredAt.slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  console.log('Pending by discoveredAt day:', JSON.stringify(Object.fromEntries(byDay), null, 2));

  // Duplicate-title groups within the currently-visible pending pool
  const byTitle = new Map<string, any[]>();
  for (const r of pending) {
    const key = r.title.trim().toLowerCase();
    const list = byTitle.get(key) || [];
    list.push(r);
    byTitle.set(key, list);
  }
  const dupGroups = [...byTitle.entries()].filter(([, l]) => l.length > 1);
  const dupDocCount = dupGroups.reduce((sum, [, l]) => sum + l.length, 0);
  console.log(`\nDuplicate-title groups in current pending pool: ${dupGroups.length} groups, ${dupDocCount} docs involved`);
  console.log(`Duplicate fraction of currently-visible pending pool: ${((dupDocCount / pending.length) * 100).toFixed(1)}%`);
  for (const [title, l] of dupGroups) {
    console.log(`  (${l.length}x) [${l.map((r:any)=>r.discoveredAt.slice(0,10)).join(', ')}] "${title}"`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

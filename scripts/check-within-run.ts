import { getSanityClient } from '../agents/sanityPublisher';

const STOPWORDS = new Set(['a','an','the','and','or','but','of','in','on','at','to','for','with','from','by','is','are','was','were','be','been','being','as','it','its','this','that','these','those','today','tonight','tomorrow','yesterday','week','news','update','updates','report','reports','says','say','said','after','before','over','into','about','amid','due','vs','v']);
function normTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter((w) => w && (w.length>2 || /^\d+$/.test(w)) && !STOPWORDS.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size===0||b.size===0) return 0;
  let inter=0; for (const t of a) if (b.has(t)) inter++;
  return inter/(a.size+b.size-inter);
}

async function main() {
  const client = getSanityClient();
  const rows = await client.fetch<any[]>(`*[_type == "topicCandidate"]{ _id, title, sourceUrl, section, discoveredAt } | order(discoveredAt asc)`);
  const byRun = new Map<string, any[]>();
  for (const r of rows) { const l = byRun.get(r.discoveredAt) || []; l.push(r); byRun.set(r.discoveredAt, l); }

  console.log('=== Within-run near-duplicate pairs (same batch, different URL, title Jaccard >= 0.6) ===');
  let total = 0;
  for (const [run, items] of byRun.entries()) {
    for (let i=0;i<items.length;i++) for (let j=i+1;j<items.length;j++) {
      const a=items[i], b=items[j];
      if (a.sourceUrl===b.sourceUrl) continue;
      const sim = jaccard(normTokens(a.title), normTokens(b.title));
      if (sim>=0.6) { total++; console.log(`  [run ${run}] sim=${sim.toFixed(2)} "${a.title}" <-> "${b.title}"`); }
    }
  }
  console.log(`Total within-run near-dup pairs (different-outlet-same-event that slipped past Stage 0's own near-dedupe): ${total}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

import { getSanityClient } from '../agents/sanityPublisher';
import { normalizeSourceUrl } from '../src/agents/dedupeFeature';

async function main() {
  const client = getSanityClient();
  const candidateRows = await client.fetch<{ sourceUrl?: string }[]>(`*[_type == "topicCandidate" && defined(sourceUrl)]{ sourceUrl }`);
  const postRows = await client.fetch<{ originalSourceUrl?: string }[]>(`*[_type == "post" && defined(originalSourceUrl)]{ originalSourceUrl }`);

  const known = new Map<string, string>();
  for (const r of candidateRows) { const n = r.sourceUrl ? normalizeSourceUrl(r.sourceUrl) : undefined; if (n && !known.has(n)) known.set(n, 'existing-candidate'); }
  for (const r of postRows) { const n = r.originalSourceUrl ? normalizeSourceUrl(r.originalSourceUrl) : undefined; if (n) known.set(n, 'published-post'); }

  const testUrls = [
    'https://www.phoenixmag.com/2026/09/02/august-2026-openings-closings/',
    'https://www.phoenixnewtimes.com/arts-culture/420-in-phoenix-your-guide-to-the-best-parties-and-weed-deals-in-2026-40660041/',
    'https://www.phoenixnewtimes.com/arts-culture/best-labor-day-weekend-parties-phoenix-2026-40694993/',
  ];
  console.log(`Known-URL map size: ${known.size} (from ${candidateRows.length} candidate rows + ${postRows.length} post rows)`);
  for (const u of testUrls) {
    const n = normalizeSourceUrl(u);
    console.log(`  "${u}" -> normalized="${n}" -> match=${n ? known.get(n) ?? 'NO MATCH' : 'unparseable'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

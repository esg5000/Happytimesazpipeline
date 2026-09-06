/**
 * Read-only investigation of the ~70% repeat-topic rate reported in the
 * topic-picker dashboard. Pulls all topicCandidate docs (any status),
 * groups by discoveredAt calendar day, and reports:
 *  - per-day counts
 *  - literal sourceUrl repeats across days
 *  - literal exact-title repeats across days
 *  - near-duplicate title repeats across days (same normalized-token
 *    overlap heuristic used by Stage 0's own near-dedupe, so this is an
 *    apples-to-apples measure)
 * Never writes/patches/creates anything. Throwaway script.
 */
import { getSanityClient } from '../agents/sanityPublisher';

type Row = {
  _id: string;
  title: string;
  sourceUrl: string;
  section?: string;
  status: string;
  discoveredAt: string;
  specificSubject?: string;
  subjectTag?: string;
};

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'as', 'it', 'its', 'this', 'that', 'these', 'those',
  'today', 'tonight', 'tomorrow', 'yesterday', 'week', 'news', 'update', 'updates', 'report', 'reports',
  'says', 'say', 'said', 'after', 'before', 'over', 'into', 'about', 'amid', 'due', 'vs', 'v',
]);

function normTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && (w.length > 2 || /^\d+$/.test(w)) && !STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

async function main() {
  const client = getSanityClient();
  const rows = await client.fetch<Row[]>(
    `*[_type == "topicCandidate"]{ _id, title, sourceUrl, section, status, discoveredAt, specificSubject, subjectTag } | order(discoveredAt asc)`
  );

  console.log(`Total topicCandidate docs (all statuses): ${rows.length}`);

  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const d = dayOf(r.discoveredAt);
    const list = byDay.get(d);
    if (list) list.push(r);
    else byDay.set(d, [r]);
  }

  const days = [...byDay.keys()].sort();
  console.log(`\nDays present: ${days.join(', ')}`);
  for (const d of days) {
    const rowsForDay = byDay.get(d)!;
    const bySection = new Map<string, number>();
    for (const r of rowsForDay) bySection.set(r.section || 'none', (bySection.get(r.section || 'none') || 0) + 1);
    console.log(`  ${d}: ${rowsForDay.length} candidates — ${[...bySection.entries()].map(([s, c]) => `${s}=${c}`).join(', ')}`);
  }

  if (days.length < 2) {
    console.log('\nFewer than 2 distinct days of data — cannot compute day-over-day repeat rate.');
    return;
  }

  // Literal URL repeats across days
  const urlToDays = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = urlToDays.get(r.sourceUrl) || new Set<string>();
    set.add(dayOf(r.discoveredAt));
    urlToDays.set(r.sourceUrl, set);
  }
  const urlRepeats = [...urlToDays.entries()].filter(([, ds]) => ds.size > 1);
  console.log(`\n=== Literal sourceUrl repeated across multiple days: ${urlRepeats.length} ===`);
  for (const [url, ds] of urlRepeats.slice(0, 20)) {
    const title = rows.find((r) => r.sourceUrl === url)?.title;
    console.log(`  [${[...ds].join(', ')}] "${title}" — ${url}`);
  }

  // Exact-title repeats across days (different URL, same title text)
  const titleToDays = new Map<string, Set<string>>();
  const titleToUrls = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.title.trim().toLowerCase();
    const dset = titleToDays.get(key) || new Set<string>();
    dset.add(dayOf(r.discoveredAt));
    titleToDays.set(key, dset);
    const uset = titleToUrls.get(key) || new Set<string>();
    uset.add(r.sourceUrl);
    titleToUrls.set(key, uset);
  }
  const exactTitleRepeats = [...titleToDays.entries()].filter(([, ds]) => ds.size > 1);
  console.log(`\n=== Exact-title repeats across multiple days: ${exactTitleRepeats.length} ===`);
  for (const [title, ds] of exactTitleRepeats.slice(0, 20)) {
    const urls = titleToUrls.get(title)!;
    console.log(`  [${[...ds].join(', ')}] (${urls.size} distinct URL(s)) "${title}"`);
  }

  // Near-duplicate titles across DIFFERENT days (day N vs day N-1/N-2), same
  // Jaccard threshold Stage 0 itself uses (0.6) — this is the
  // same-story-different-outlet / same-event-different-day signal.
  console.log(`\n=== Near-duplicate candidates across different days (Jaccard >= 0.6 on titles) ===`);
  let nearDupCrossDayCount = 0;
  const examples: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      const dayA = dayOf(a.discoveredAt);
      const dayB = dayOf(b.discoveredAt);
      if (dayA === dayB) continue; // only cross-day pairs
      if (a.sourceUrl === b.sourceUrl) continue; // already counted as literal URL repeat
      const sim = jaccard(normTokens(a.title), normTokens(b.title));
      if (sim >= 0.6) {
        nearDupCrossDayCount++;
        if (examples.length < 25) {
          examples.push(
            `  sim=${sim.toFixed(2)} [${dayA} vs ${dayB}] "${a.title}" (${a.section}) <-> "${b.title}" (${b.section})`
          );
        }
      }
    }
  }
  console.log(`Cross-day near-duplicate pairs found: ${nearDupCrossDayCount}`);
  examples.forEach((e) => console.log(e));

  // Per-section breakdown of which section has the most cross-day near-dup pairs.
  const sectionDupCounts = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (dayOf(a.discoveredAt) === dayOf(b.discoveredAt)) continue;
      if (a.sourceUrl === b.sourceUrl) continue;
      const sim = jaccard(normTokens(a.title), normTokens(b.title));
      if (sim >= 0.6 && a.section === b.section && a.section) {
        sectionDupCounts.set(a.section, (sectionDupCounts.get(a.section) || 0) + 1);
      }
    }
  }
  console.log(`\n=== Cross-day near-dup pairs by section ===`);
  for (const [s, c] of [...sectionDupCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${c}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

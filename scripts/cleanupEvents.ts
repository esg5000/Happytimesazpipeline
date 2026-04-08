import { validateConfig } from '../config';
import { getSanityClient } from '../agents/sanityPublisher';

/** Title or description substring match (case-insensitive). */
const KEYWORD_DEACTIVATE = [
  'toddler',
  'kids',
  'children',
  'baby',
  'infant',
  'youth',
  'junior',
  'school',
  'preschool',
  'family-only',
  'daycare',
  'pediatric',
  'birthday party',
  'princess',
  'superhero',
  'storytime',
  'story time',
] as const;

type EventRow = {
  _id: string;
  title: string | null;
  description: string | null;
  isActive: boolean | null;
  _createdAt: string;
};

function textMatchesDeactivateKeywords(title: string | null, description: string | null): boolean {
  const haystack = `${title || ''}\n${description || ''}`.toLowerCase();
  for (const kw of KEYWORD_DEACTIVATE) {
    if (haystack.includes(kw.toLowerCase())) return true;
  }
  return false;
}

function normalizeTitle(title: string | null): string {
  return (title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function main(): Promise<void> {
  validateConfig();
  const client = getSanityClient();

  const events = await client.fetch<EventRow[]>(
    `*[_type == "event"] | order(_createdAt asc){ _id, title, description, isActive, _createdAt }`
  );

  console.log(`[cleanup-events] Loaded ${events.length} event document(s).`);

  let deactivated = 0;
  for (const ev of events) {
    if (!textMatchesDeactivateKeywords(ev.title, ev.description)) continue;
    if (ev.isActive === false) continue;

    try {
      await client.patch(ev._id).set({ isActive: false }).commit();
      deactivated++;
      console.log(`[cleanup-events] Deactivated (keyword): ${ev._id} — "${(ev.title || '').slice(0, 80)}"`);
    } catch (e) {
      console.error(
        `[cleanup-events] Failed to deactivate ${ev._id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  const afterDeactivate = await client.fetch<EventRow[]>(
    `*[_type == "event"] | order(_createdAt asc){ _id, title, _createdAt }`
  );

  const byTitle = new Map<string, EventRow[]>();
  for (const ev of afterDeactivate) {
    const key = normalizeTitle(ev.title);
    const list = byTitle.get(key);
    if (list) list.push(ev);
    else byTitle.set(key, [ev]);
  }

  let duplicatesRemoved = 0;
  for (const [, rows] of byTitle) {
    if (rows.length <= 1) continue;
    const [, ...toDelete] = rows;
    for (const doc of toDelete) {
      try {
        await client.delete(doc._id);
        duplicatesRemoved++;
        console.log(
          `[cleanup-events] Removed duplicate title "${(doc.title || '').slice(0, 80)}": deleted ${doc._id}`
        );
      } catch (e) {
        console.error(
          `[cleanup-events] Failed to delete ${doc._id}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  console.log('');
  console.log('[cleanup-events] Summary');
  console.log(`  Events deactivated (keyword match, was active): ${deactivated}`);
  console.log(`  Duplicate documents removed (same title, kept oldest by _createdAt): ${duplicatesRemoved}`);
}

main().catch((e) => {
  console.error('[cleanup-events] Fatal:', e);
  process.exit(1);
});

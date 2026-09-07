/**
 * Follow-up correction to the --write run of scripts/fixDuplicateHeroImages.ts
 * (2026-09-07) that fixed the 4 remaining live duplicate-hero-image pairs.
 *
 * That script only ever touched `heroImage` (and, since this session's
 * update, `heroImageUnsplashId`) — same documented scope as its own header
 * comment — but each fixed post's `disclaimer` field still carried the
 * ORIGINAL photo-credit line, now false: 3 posts got a gpt-image-1
 * generated hero (no photographer to credit) but still said "Hero photo by
 * <original photographer> on Unsplash"; the 4th got a genuinely different
 * Unsplash photo but still credited the OLD photographer. Same issue caught
 * and fixed manually during the Labor Day post fix earlier this session —
 * fixing it here for the other 4 in one pass instead of one-off scripts.
 *
 * One-off, scoped to exactly these 4 documents' disclaimer field only.
 */
import { createClient } from '@sanity/client';
import { config } from '../config';

type Fix = {
  id: string;
  /** Exact current stale photo-credit substring to replace (validated before writing). */
  stalePhotoCredit: string;
  /** Replacement photo-credit substring. */
  newPhotoCredit: string;
};

const FIXES: Fix[] = [
  {
    id: 'post-dbacks-astros-series-preview-september-2026-1788555152585',
    stalePhotoCredit: ' Hero photo by Anthony Melone on Unsplash (https://unsplash.com/@anthony_melone).',
    newPhotoCredit: ' Hero image is AI-generated (gpt-image-1).',
  },
  {
    id: 'post-asu-football-season-opener-uniforms-1788555128303',
    stalePhotoCredit: ' Hero photo by sporlab on Unsplash (https://unsplash.com/@sporlab).',
    newPhotoCredit: ' Hero image is AI-generated (gpt-image-1).',
  },
  {
    id: 'post-dash-fifita-arizona-wildcats-legacy-1788555146850',
    stalePhotoCredit: ' Hero photo by Donald Teel on Unsplash (https://unsplash.com/@epartner).',
    newPhotoCredit: ' Hero image is AI-generated (gpt-image-1).',
  },
  {
    id: 'post-vecina-mccormick-ranch-opening-1-1788506852381',
    stalePhotoCredit: ' Hero photo by Ruth Bourke on Unsplash (https://unsplash.com/@nocturnecapture).',
    newPhotoCredit: ' Hero photo by Olayinka Babalola on Unsplash (https://unsplash.com/@islandsandsunsets).',
  },
];

async function main() {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const ids = FIXES.map((f) => f.id);
  const before = await client.fetch<{ _id: string; disclaimer?: string }[]>(
    `*[_id in $ids]{ _id, disclaimer }`,
    { ids }
  );
  console.log('[fix-stale-disclaimers] Before:', JSON.stringify(before, null, 2));

  const tx = client.transaction();
  for (const fix of FIXES) {
    const doc = before.find((d) => d._id === fix.id);
    if (!doc?.disclaimer || !doc.disclaimer.includes(fix.stalePhotoCredit)) {
      throw new Error(
        `Refusing to proceed — ${fix.id}'s disclaimer does not contain the exact expected stale photo-credit text. It may have already changed. Got: ${JSON.stringify(doc?.disclaimer)}`
      );
    }
    const newDisclaimer = doc.disclaimer.replace(fix.stalePhotoCredit, fix.newPhotoCredit);
    tx.patch(fix.id, (patch) => patch.set({ disclaimer: newDisclaimer }));
  }

  const result = await tx.commit();
  console.log('[fix-stale-disclaimers] Transaction committed:', JSON.stringify(result));

  const after = await client.fetch<{ _id: string; disclaimer?: string }[]>(
    `*[_id in $ids]{ _id, disclaimer }`,
    { ids }
  );
  console.log('[fix-stale-disclaimers] After:', JSON.stringify(after, null, 2));

  const stillStale = after.filter((d, i) => d.disclaimer?.includes(FIXES[i]!.stalePhotoCredit.trim()));
  if (stillStale.length > 0) {
    throw new Error(`VERIFICATION FAILED — ${stillStale.length} document(s) still contain stale photo-credit text.`);
  }
  console.log('[fix-stale-disclaimers] CONFIRMED — all 4 disclaimers now correctly credit their actual hero image.');
}

main().catch((err) => {
  console.error('[fix-stale-disclaimers] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

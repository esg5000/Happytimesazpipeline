/**
 * Follow-up correction to scripts/fixLaborDayDuplicateHeroImage.ts (2026-09-06).
 *
 * heroImage was correctly replaced with a fresh gpt-image-1-generated image
 * (Unsplash's ladder was exhausted by duplicate-exclusion), but the post's
 * `disclaimer` field still read the ORIGINAL "Hero photo by Roberto Rendon on
 * Unsplash" attribution — now false: the hero is no longer an Unsplash photo,
 * and falsely crediting a specific photographer for an image that isn't
 * theirs is a real correctness issue, not just cosmetic. This updates only
 * the photo-credit half of the disclaimer sentence, leaving the source-outlet
 * credit (Phoenix New Times) untouched, matching publishAssembly.ts's own
 * buildDisclaimer() wording for the gpt-image-1 case.
 *
 * One-off, scoped to exactly this one document and field.
 */
import { createClient } from '@sanity/client';
import { config } from '../config';

const POST_ID = 'post-labor-day-weekend-2026-phoenix-parties-1788555120460';
const STALE_PHOTO_CREDIT = ' Hero photo by Roberto Rendon on Unsplash (https://unsplash.com/@bertorendon13).';
const NEW_PHOTO_CREDIT = ' Hero image is AI-generated (gpt-image-1).';

async function main() {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const before = await client.fetch<{ disclaimer?: string } | null>(`*[_id == $id][0]{ disclaimer }`, { id: POST_ID });
  console.log(`[fix-stale-disclaimer] Before: ${JSON.stringify(before)}`);
  if (!before?.disclaimer || !before.disclaimer.includes(STALE_PHOTO_CREDIT)) {
    throw new Error('Refusing to proceed — disclaimer does not contain the exact expected stale photo-credit text. It may have already changed.');
  }

  const newDisclaimer = before.disclaimer.replace(STALE_PHOTO_CREDIT, NEW_PHOTO_CREDIT);

  const tx = client.transaction();
  tx.patch(POST_ID, (patch) => patch.set({ disclaimer: newDisclaimer }));
  const result = await tx.commit();
  console.log(`[fix-stale-disclaimer] Transaction committed: ${JSON.stringify(result)}`);

  const after = await client.fetch<{ disclaimer?: string } | null>(`*[_id == $id][0]{ disclaimer }`, { id: POST_ID });
  console.log(`[fix-stale-disclaimer] After: ${JSON.stringify(after)}`);
  if (after?.disclaimer?.includes('Roberto Rendon')) {
    throw new Error('VERIFICATION FAILED — stale photo credit still present.');
  }
  console.log('[fix-stale-disclaimer] CONFIRMED — disclaimer now correctly credits the AI-generated image.');
}

main().catch((err) => {
  console.error('[fix-stale-disclaimer] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

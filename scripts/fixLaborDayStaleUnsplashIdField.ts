/**
 * Follow-up correction to scripts/fixLaborDayDuplicateHeroImage.ts (2026-09-06).
 *
 * That script's final successful run fell through to the gpt-image-1/Gemini
 * generation fallback (Unsplash's ladder was exhausted by duplicate-exclusion),
 * so the post's heroImage is correctly a freshly generated image — but an
 * earlier retry attempt within the same script run had already written
 * heroImageUnsplashId="z0JA_ArZFKE" (from a discarded attempt whose resulting
 * Sanity asset turned out to be the duplicate), and the final transaction only
 * `.set()` the field conditionally on source==='unsplash', so it never got
 * cleared. Left as-is, heroImageUnsplashId would falsely claim this post's
 * hero came from an Unsplash photo it doesn't actually use — exactly the kind
 * of bad data the cross-run dedup check (Part 2) depends on being accurate.
 *
 * One-off, scoped to exactly this one document and field.
 */
import { createClient } from '@sanity/client';
import { config } from '../config';

const POST_ID = 'post-labor-day-weekend-2026-phoenix-parties-1788555120460';

async function main() {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const before = await client.fetch<{ heroImageAssetId?: string; heroImageUnsplashId?: string } | null>(
    `*[_id == $id][0]{ "heroImageAssetId": heroImage.asset._ref, heroImageUnsplashId }`,
    { id: POST_ID }
  );
  console.log(`[fix-stale-field] Before: ${JSON.stringify(before)}`);

  const tx = client.transaction();
  tx.patch(POST_ID, (patch) => patch.unset(['heroImageUnsplashId']));
  const result = await tx.commit();
  console.log(`[fix-stale-field] Transaction committed: ${JSON.stringify(result)}`);

  const after = await client.fetch<{ heroImageAssetId?: string; heroImageUnsplashId?: string } | null>(
    `*[_id == $id][0]{ "heroImageAssetId": heroImage.asset._ref, heroImageUnsplashId }`,
    { id: POST_ID }
  );
  console.log(`[fix-stale-field] After: ${JSON.stringify(after)}`);
  if (after?.heroImageUnsplashId) {
    throw new Error('VERIFICATION FAILED — heroImageUnsplashId is still set.');
  }
  console.log('[fix-stale-field] CONFIRMED — stale heroImageUnsplashId cleared; heroImage untouched.');
}

main().catch((err) => {
  console.error('[fix-stale-field] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

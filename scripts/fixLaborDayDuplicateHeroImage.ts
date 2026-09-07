/**
 * One-off manual fix (2026-09-06) for a single confirmed live duplicate
 * hero-image pair, reported directly by Shawn:
 *
 *   - "Scottsdale Rooftop Bars Worth Visiting Before Fall" (published Aug 5)
 *     — KEPT AS-IS, not touched by this script.
 *   - "Labor Day Weekend 2026: The Valley's Best Parties" (published Sept 4)
 *     — shared the exact same Unsplash asset
 *     (image-5955015b862c4b3cf01f97841e9612884118806e-9504x6336-jpg).
 *     This script re-sources a fresh, topically-appropriate image for THIS
 *     post only, via the real sourceImage() (same Unsplash ladder + dedup
 *     filter + gpt-image-1/Gemini fallback the live pipeline uses), and
 *     applies it via a proper Sanity transaction — heroImage AND the new
 *     heroImageUnsplashId field (schemas/post.ts) together.
 *
 * NOTE: a broader dry-run scan (scripts/fixDuplicateHeroImages.ts) found 4
 * OTHER unrelated live duplicate-hero-image pairs on the site at the same
 * time — deliberately NOT touched by this script, which is scoped to only
 * the one pair Shawn asked about. Flagged in the session report; that
 * existing script can handle the rest in one run if/when asked.
 *
 * Scoped to exactly one document. No CLI flags, no dry-run mode — this is
 * a single, reviewed, one-time fix, not a repeatable tool.
 */
import { createClient } from '@sanity/client';
import { config } from '../config';
import { sourceImage, seedRecentlyUsedUnsplashPhotoIds, type ImageSourcingInput, type ImageSourcingResult } from '../src/agents/imageSourcing';
import { uploadImageBufferToSanity } from '../agents/sanityPublisher';
import { downloadImage } from '../agents/imageAgent';

const POST_ID = 'post-labor-day-weekend-2026-phoenix-parties-1788555120460';
const DUPLICATE_ASSET_REF = 'image-5955015b862c4b3cf01f97841e9612884118806e-9504x6336-jpg';

type PostRow = {
  _id: string;
  title: string;
  tags?: string[];
  section?: string;
  currentAssetRef?: string;
};

async function main() {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const post = await client.fetch<PostRow | null>(
    `*[_id == $id][0]{ _id, title, tags, section, "currentAssetRef": heroImage.asset._ref }`,
    { id: POST_ID }
  );
  if (!post) {
    throw new Error(`Post ${POST_ID} not found.`);
  }
  console.log(`[fix-labor-day-hero] Found post "${post.title}" — currentAssetRef=${post.currentAssetRef}`);
  if (post.currentAssetRef !== DUPLICATE_ASSET_REF) {
    throw new Error(
      `Refusing to proceed — expected currentAssetRef="${DUPLICATE_ASSET_REF}" but found "${post.currentAssetRef}". The document may have already been fixed or changed.`
    );
  }

  const input: ImageSourcingInput = {
    tags: post.tags || [],
    section: post.section || 'nightlife',
    entity: undefined, // multi-venue roundup, no single entity — same as the original run
    title: post.title,
  };

  // Sanity's asset store dedupes uploads by content hash — a re-download of the SAME
  // underlying Unsplash photo produces the identical asset id (image-<hash>-...) even
  // though it's a fresh upload call, no matter what Unsplash photo ID sourceImage()
  // reports. The old duplicate's own originating Unsplash photo ID was never recorded
  // (that's the exact gap Part 2 of this fix closes going forward), so it can't be
  // pre-excluded by ID — instead, retry against the real resulting Sanity asset id,
  // excluding whichever Unsplash photo ID produced it, until a genuinely different
  // asset comes back (or the ladder/fallback is genuinely exhausted).
  const MAX_ATTEMPTS = 4;
  let assetId = '';
  let result: ImageSourcingResult | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[fix-labor-day-hero] Re-sourcing image via sourceImage() (attempt ${attempt}/${MAX_ATTEMPTS})... input=${JSON.stringify(input)}`);
    const outcome = await sourceImage(input);
    if (outcome.status !== 'ok') {
      throw new Error(`sourceImage() did not return an image: ${JSON.stringify(outcome)}`);
    }
    result = outcome.result;
    console.log(
      `[fix-labor-day-hero] Sourced: source=${result.source}, photoId=${result.photoId}, photographer="${result.photographerName}", matchedRelevanceFilter=${result.matchedRelevanceFilter}`
    );

    const buf = result.imageUrl ? await downloadImage(result.imageUrl) : Buffer.from(result.imageBase64!, 'base64');
    const ext = result.imageUrl ? 'jpg' : 'png';
    const candidateAssetId = await uploadImageBufferToSanity(buf, `${POST_ID}-dedupe-fix.${ext}`);
    console.log(`[fix-labor-day-hero] Uploaded — resulting Sanity asset id: ${candidateAssetId}`);

    if (candidateAssetId !== DUPLICATE_ASSET_REF) {
      assetId = candidateAssetId;
      break;
    }

    console.warn(
      `[fix-labor-day-hero] Content-hash match with the duplicate asset — this Unsplash photo (photoId=${result.photoId}) IS the duplicate. Excluding it and retrying...`
    );
    if (result.source === 'unsplash') {
      seedRecentlyUsedUnsplashPhotoIds([result.photoId]);
    }
  }
  if (!assetId || !result) {
    throw new Error(`Could not obtain a distinct image after ${MAX_ATTEMPTS} attempts — every attempt resolved to the duplicate asset or a new one wasn't found.`);
  }
  console.log(`[fix-labor-day-hero] Final new Sanity image asset: ${assetId}`);

  const heroImage = {
    _type: 'image',
    asset: { _type: 'reference', _ref: assetId },
    ...(result.altText ? { alt: result.altText } : {}),
  };

  const tx = client.transaction();
  tx.patch(POST_ID, (patch) => {
    patch.set({ heroImage });
    // Explicit unset (not just "omit from .set") for the non-unsplash case — a stale
    // heroImageUnsplashId left over from an earlier retry attempt in the same run would
    // otherwise survive and falsely claim this hero came from an Unsplash photo it
    // doesn't actually use, corrupting Part 2's cross-run dedup data.
    if (result!.source === 'unsplash') {
      patch.set({ heroImageUnsplashId: result!.photoId });
    } else {
      patch.unset(['heroImageUnsplashId']);
    }
    return patch;
  });
  const txResult = await tx.commit();
  console.log(`[fix-labor-day-hero] Transaction committed:`, JSON.stringify(txResult));

  const verify = await client.fetch<{ heroImageAssetId?: string; heroImageUnsplashId?: string } | null>(
    `*[_id == $id][0]{ "heroImageAssetId": heroImage.asset._ref, heroImageUnsplashId }`,
    { id: POST_ID }
  );
  console.log(`[fix-labor-day-hero] Post-write verification: ${JSON.stringify(verify)}`);
  if (verify?.heroImageAssetId === DUPLICATE_ASSET_REF) {
    throw new Error('VERIFICATION FAILED — the document still points at the duplicate asset.');
  }
  console.log('[fix-labor-day-hero] CONFIRMED — post now has a distinct hero image.');
}

main().catch((err) => {
  console.error('[fix-labor-day-hero] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

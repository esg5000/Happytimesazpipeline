import { createClient } from '@sanity/client';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import { sourceImage, seedRecentlyUsedUnsplashPhotoIds, type ImageSourcingInput } from '../src/agents/imageSourcing';
import { uploadImageBufferToSanity } from '../agents/sanityPublisher';
import { downloadImage } from '../agents/imageAgent';

/**
 * Persists Unsplash photo IDs assigned across separate invocations of this
 * script. Necessary because Unsplash's hourly rate limit forces this
 * cleanup to run in several separate process restarts — imageSourcing.ts's
 * own in-memory dedup window is process-lifetime only, so without this a
 * restart forgets every photo the previous invocation already assigned and
 * can re-pick the exact same one for the same query (confirmed live: two
 * separate retry cycles both landed "Arizona retirement community..." on
 * photoId sg06QjlbmBc). Stored outside the repo (process temp dir) — this
 * file is cleanup-run state, not a pipeline artifact.
 */
const USED_PHOTO_IDS_CACHE = join(
  process.env.TEMP || process.env.TMPDIR || '/tmp',
  'fix-duplicate-hero-images-used-photo-ids.json'
);

function loadUsedPhotoIdsCache(): string[] {
  if (!existsSync(USED_PHOTO_IDS_CACHE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(USED_PHOTO_IDS_CACHE, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveUsedPhotoIdsCache(ids: string[]): void {
  writeFileSync(USED_PHOTO_IDS_CACHE, JSON.stringify(ids), 'utf-8');
}

/**
 * One-time cleanup: finds every set of 2+ *published* posts (drafts
 * excluded — a drafts.<id>/<id> pair sharing an image is the same
 * document in two states, not two different articles) sharing the exact
 * same heroImage.asset._ref, keeps the oldest post's image as-is, and
 * re-sources a fresh, topically-appropriate image for every other post in
 * the group via the real sourceImage() (same Unsplash ladder + dedup
 * filter + gpt-image-1/Gemini fallback the live pipeline uses). Since this
 * script runs sourceImage() repeatedly in one process, imageSourcing.ts's
 * own in-memory recently-used-photo tracking automatically prevents this
 * cleanup from creating new duplicates among its own re-sourced images —
 * no separate tracking needed here.
 *
 * Touches ONLY heroImage on affected documents — no title/body/category/
 * status/disclaimer changes. (Disclaimer's existing "Hero photo by X on
 * Unsplash" attribution line will go stale for re-imaged posts since this
 * script doesn't touch it, per the explicit heroImage-only scope — flagged
 * in the final report.)
 *
 * Defaults to DRY RUN (report only, no writes, no sourceImage() calls).
 * Pass --write to actually re-source images and patch documents.
 */

const WRITE = process.argv.includes('--write');
const PATCH_BATCH_SIZE = 50;

type PostRow = {
  _id: string;
  title: string;
  _createdAt: string;
  section?: string;
  tags?: string[];
  imageRef: string;
};

function isPublished(id: string): boolean {
  return !id.startsWith('drafts.');
}

async function main() {
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const allRows = await client.fetch<PostRow[]>(
    `*[_type == "post" && defined(heroImage.asset._ref)]{ _id, title, _createdAt, section, tags, "imageRef": heroImage.asset._ref }`
  );
  const rows = allRows.filter((r) => isPublished(r._id));
  console.log(`[fix-duplicate-hero-images] ${allRows.length} post(s) with a heroImage asset total, ${rows.length} published (non-draft).`);

  const byRef = new Map<string, PostRow[]>();
  for (const r of rows) {
    const list = byRef.get(r.imageRef) || [];
    list.push(r);
    byRef.set(r.imageRef, list);
  }

  const groups = [...byRef.entries()]
    .filter(([, posts]) => posts.length >= 2)
    .map(([imageRef, posts]) => ({
      imageRef,
      posts: posts.slice().sort((a, b) => a._createdAt.localeCompare(b._createdAt)),
    }));

  console.log(`\n========== DUPLICATE GROUPS: ${groups.length} ==========`);
  let totalDupPosts = 0;
  for (const g of groups) {
    console.log(`\nimageRef=${g.imageRef} — ${g.posts.length} post(s):`);
    for (const [i, p] of g.posts.entries()) {
      const role = i === 0 ? 'KEEP (oldest)' : 'RE-IMAGE';
      console.log(`  [${role}] ${p._createdAt} — ${p._id} — "${p.title}" (section=${p.section || '(none)'})`);
    }
    totalDupPosts += g.posts.length - 1;
  }
  console.log(`\nTotal posts needing a new image: ${totalDupPosts}`);

  if (!WRITE) {
    console.log('\n[fix-duplicate-hero-images] DRY RUN — no sourceImage() calls made, no writes. Pass --write to execute.');
    return;
  }

  const usedPhotoIdsAcrossRuns = loadUsedPhotoIdsCache();
  seedRecentlyUsedUnsplashPhotoIds(usedPhotoIdsAcrossRuns);
  console.log(`[fix-duplicate-hero-images] Seeded ${usedPhotoIdsAcrossRuns.length} Unsplash photo ID(s) already assigned in earlier retry cycles (cache: ${USED_PHOTO_IDS_CACHE}).`);

  type PatchRow = { id: string; heroImage: Record<string, unknown> };
  const patches: PatchRow[] = [];
  const fixedRows: { id: string; title: string; source: string; matchedRelevanceFilter: boolean }[] = [];
  const failedRows: { id: string; title: string; reason: string }[] = [];
  let unsplashCount = 0;
  let gptImage1Count = 0;
  let stoppedEarlyOnRateLimit = false;

  outer: for (const g of groups) {
    for (const p of g.posts.slice(1)) {
      if (stoppedEarlyOnRateLimit) {
        failedRows.push({ id: p._id, title: p.title, reason: 'not attempted — stopped after an earlier Unsplash rate-limit' });
        continue;
      }
      const input: ImageSourcingInput = {
        tags: p.tags || [],
        section: p.section || 'news',
        entity: p.tags?.[0],
        title: p.title,
      };
      console.log(`\n[fix-duplicate-hero-images] Re-sourcing image for "${p.title}" (${p._id})...`);
      const outcome = await sourceImage(input);

      if (outcome.status === 'rate-limited') {
        console.error(`[fix-duplicate-hero-images] Unsplash rate-limited — stopping further re-sourcing this run. Remaining posts left untouched.`);
        failedRows.push({ id: p._id, title: p.title, reason: `rate-limited (query="${outcome.query}", httpStatus=${outcome.httpStatus})` });
        stoppedEarlyOnRateLimit = true;
        continue;
      }
      if (outcome.status !== 'ok') {
        const reason =
          outcome.status === 'no-key'
            ? 'UNSPLASH_ACCESS_KEY not set'
            : outcome.status === 'no-image'
              ? `exhausted ladder + generation fallback, query="${outcome.query}"`
              : `error: ${outcome.message} (query="${outcome.query}")`;
        console.error(`[fix-duplicate-hero-images] Could not source an image: ${reason}`);
        failedRows.push({ id: p._id, title: p.title, reason });
        continue;
      }

      const result = outcome.result;
      try {
        const buf = result.imageUrl ? await downloadImage(result.imageUrl) : Buffer.from(result.imageBase64!, 'base64');
        const ext = result.imageUrl ? 'jpg' : 'png';
        const filename = `${p._id.replace(/[^a-z0-9-]/gi, '-')}-dedupe-fix.${ext}`;
        const assetId = await uploadImageBufferToSanity(buf, filename);
        patches.push({
          id: p._id,
          heroImage: { _type: 'image', asset: { _type: 'reference', _ref: assetId }, alt: result.altText },
        });
        fixedRows.push({ id: p._id, title: p.title, source: result.source, matchedRelevanceFilter: result.matchedRelevanceFilter });
        if (result.source === 'unsplash') {
          unsplashCount++;
          usedPhotoIdsAcrossRuns.push(result.photoId);
          saveUsedPhotoIdsCache(usedPhotoIdsAcrossRuns);
        } else {
          gptImage1Count++;
        }
        console.log(`[fix-duplicate-hero-images] New image ready: source=${result.source}, assetId=${assetId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[fix-duplicate-hero-images] Upload failed for "${p.title}": ${msg}`);
        failedRows.push({ id: p._id, title: p.title, reason: `upload threw: ${msg}` });
      }
    }
  }

  console.log(`\n========== WRITING ${patches.length} patch(es) in batches of ${PATCH_BATCH_SIZE} ==========`);
  let committed = 0;
  for (let i = 0; i < patches.length; i += PATCH_BATCH_SIZE) {
    const batch = patches.slice(i, i + PATCH_BATCH_SIZE);
    const tx = client.transaction();
    for (const p of batch) {
      tx.patch(p.id, (patch) => patch.set({ heroImage: p.heroImage }));
    }
    try {
      await tx.commit();
      committed += batch.length;
      console.log(`[fix-duplicate-hero-images] Batch ${Math.floor(i / PATCH_BATCH_SIZE) + 1} committed (${batch.length} post(s)).`);
    } catch (err: unknown) {
      console.error(`[fix-duplicate-hero-images] Batch ${Math.floor(i / PATCH_BATCH_SIZE) + 1} FAILED, no changes applied for this batch:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log('\n========== SUMMARY ==========');
  console.log(`Duplicate groups found: ${groups.length}`);
  console.log(`Posts needing a new image: ${totalDupPosts}`);
  console.log(`Successfully re-sourced + committed: ${committed}`);
  console.log(`  via Unsplash: ${unsplashCount}`);
  console.log(`  via gpt-image-1/Gemini generation fallback: ${gptImage1Count}`);
  console.log(`Failed / not fixed: ${failedRows.length}`);
  for (const f of failedRows) {
    console.log(`  ${f.id} — "${f.title}" — ${f.reason}`);
  }

  // Post-write verification
  const verifyRows = (
    await client.fetch<PostRow[]>(
      `*[_type == "post" && defined(heroImage.asset._ref)]{ _id, title, _createdAt, section, tags, "imageRef": heroImage.asset._ref }`
    )
  ).filter((r) => isPublished(r._id));
  const verifyByRef = new Map<string, PostRow[]>();
  for (const r of verifyRows) {
    const list = verifyByRef.get(r.imageRef) || [];
    list.push(r);
    verifyByRef.set(r.imageRef, list);
  }
  const remainingDupes = [...verifyByRef.entries()].filter(([, posts]) => posts.length >= 2);
  console.log(`\nPost-fix verification: ${verifyRows.length} published posts checked, ${remainingDupes.length} duplicate group(s) remain.`);
  for (const [ref, posts] of remainingDupes) {
    console.log(`  REMAINING DUPLICATE — imageRef=${ref}: ${posts.map((p) => p._id).join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

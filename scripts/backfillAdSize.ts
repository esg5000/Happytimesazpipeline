import { createClient } from '@sanity/client';
import { config } from '../config';

/**
 * Backfills the new `adSize` field on `ad` and `affiliateAd` documents from
 * their existing `placement` value. top-banner/in-feed/bottom-banner map
 * deterministically; sidebar is ambiguous (mpu-300x250 vs halfpage-300x600)
 * and is only reported here, never auto-assigned.
 *
 * Defaults to DRY RUN (no writes). Pass --write to actually patch documents,
 * and only after the sidebar report has been reviewed and turned into
 * explicit --sidebar=<id>=<adSize> overrides (see parseSidebarOverrides).
 */

type PlacementValue = 'top-banner' | 'in-feed' | 'sidebar' | 'bottom-banner';
type AdSizeValue = 'billboard-970x250' | 'leaderboard-728x90' | 'mpu-300x250' | 'halfpage-300x600';

interface AdLikeDocument {
  _id: string;
  _type: 'ad' | 'affiliateAd';
  title?: string;
  advertiser?: string;
  placement?: PlacementValue;
  adSize?: AdSizeValue;
}

const DETERMINISTIC_MAP: Partial<Record<PlacementValue, AdSizeValue>> = {
  'top-banner': 'billboard-970x250',
  'in-feed': 'billboard-970x250',
  'bottom-banner': 'leaderboard-728x90',
};

const VALID_SIDEBAR_SIZES: AdSizeValue[] = ['mpu-300x250', 'halfpage-300x600'];

/** --sidebar=<_id>=<adSize>, repeatable. Only consulted for placement === 'sidebar'. */
function parseSidebarOverrides(argv: string[]): Map<string, AdSizeValue> {
  const overrides = new Map<string, AdSizeValue>();
  for (const arg of argv) {
    const match = arg.match(/^--sidebar=([^=]+)=([^=]+)$/);
    if (!match) continue;
    const [, id, size] = match;
    if (!VALID_SIDEBAR_SIZES.includes(size as AdSizeValue)) {
      throw new Error(`Invalid sidebar adSize "${size}" for ${id}. Must be one of: ${VALID_SIDEBAR_SIZES.join(', ')}`);
    }
    overrides.set(id, size as AdSizeValue);
  }
  return overrides;
}

async function backfillAdSize(): Promise<void> {
  const argv = process.argv.slice(2);
  const isWrite = argv.includes('--write');
  const sidebarOverrides = parseSidebarOverrides(argv);

  console.log(`🚀 Starting adSize backfill script (${isWrite ? 'WRITE' : 'DRY RUN'})...`);

  const sanityClient = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const docs: AdLikeDocument[] = await sanityClient.fetch(
    `*[_type in ["ad", "affiliateAd"]]{ _id, _type, title, advertiser, placement, adSize }`
  );

  console.log(`Found ${docs.length} ad/affiliateAd documents.\n`);

  const deterministic: Array<{ doc: AdLikeDocument; newSize: AdSizeValue }> = [];
  const sidebarDocs: AdLikeDocument[] = [];
  const skippedAlreadySet: AdLikeDocument[] = [];
  const skippedNoPlacement: AdLikeDocument[] = [];

  for (const doc of docs) {
    if (doc.adSize) {
      skippedAlreadySet.push(doc);
      continue;
    }
    if (!doc.placement) {
      skippedNoPlacement.push(doc);
      continue;
    }
    if (doc.placement === 'sidebar') {
      sidebarDocs.push(doc);
      continue;
    }
    const newSize = DETERMINISTIC_MAP[doc.placement];
    if (!newSize) {
      skippedNoPlacement.push(doc); // unrecognized placement value
      continue;
    }
    deterministic.push({ doc, newSize });
  }

  console.log('=== Deterministic mappings (top-banner / in-feed / bottom-banner) ===');
  if (deterministic.length === 0) {
    console.log('(none)');
  } else {
    for (const { doc, newSize } of deterministic) {
      console.log(
        `  [${doc._type}] "${doc.title || 'Untitled'}" (${doc.advertiser || 'no advertiser'}) — id: ${doc._id}\n` +
          `    placement: ${doc.placement}  →  adSize: ${newSize}`
      );
    }
  }

  console.log(`\n=== Sidebar report (AMBIGUOUS — needs manual mpu-300x250 vs halfpage-300x600 decision) ===`);
  if (sidebarDocs.length === 0) {
    console.log('(none)');
  } else {
    for (const doc of sidebarDocs) {
      const override = sidebarOverrides.get(doc._id);
      console.log(
        `  [${doc._type}] "${doc.title || 'Untitled'}" (${doc.advertiser || 'no advertiser'}) — id: ${doc._id}` +
          (override ? `\n    → override supplied: ${override}` : '\n    → NO decision supplied yet')
      );
    }
  }

  if (skippedAlreadySet.length > 0) {
    console.log(`\n=== Skipped — adSize already set (${skippedAlreadySet.length}) ===`);
    for (const doc of skippedAlreadySet) {
      console.log(`  [${doc._type}] "${doc.title || 'Untitled'}" — id: ${doc._id} — adSize: ${doc.adSize}`);
    }
  }

  if (skippedNoPlacement.length > 0) {
    console.log(`\n=== Skipped — missing/unrecognized placement (${skippedNoPlacement.length}) ===`);
    for (const doc of skippedNoPlacement) {
      console.log(`  [${doc._type}] "${doc.title || 'Untitled'}" — id: ${doc._id} — placement: ${doc.placement ?? '(none)'}`);
    }
  }

  const sidebarReady = sidebarDocs.filter((d) => sidebarOverrides.has(d._id));
  const sidebarPending = sidebarDocs.filter((d) => !sidebarOverrides.has(d._id));

  console.log(
    `\n📊 Summary: ${deterministic.length} deterministic, ${sidebarReady.length}/${sidebarDocs.length} sidebar decided, ` +
      `${skippedAlreadySet.length} already set, ${skippedNoPlacement.length} skipped (no/unknown placement).`
  );

  if (!isWrite) {
    console.log('\n✅ Dry run complete. No documents were written. Re-run with --write to apply.');
    if (sidebarPending.length > 0) {
      console.log(
        `⚠️  ${sidebarPending.length} sidebar document(s) still need a decision — pass ` +
          `--sidebar=<_id>=mpu-300x250 or --sidebar=<_id>=halfpage-300x600 for each before writing.`
      );
    }
    return;
  }

  if (sidebarPending.length > 0) {
    console.error(
      `\n❌ Refusing to write: ${sidebarPending.length} sidebar document(s) have no adSize decision. ` +
        `Supply --sidebar=<_id>=<adSize> for each listed above and re-run with --write.`
    );
    process.exit(1);
  }

  console.log('\n✍️  Writing...');
  let written = 0;
  for (const { doc, newSize } of deterministic) {
    await sanityClient.patch(doc._id).set({ adSize: newSize }).commit();
    console.log(`  ✅ ${doc._id} → ${newSize}`);
    written++;
  }
  for (const doc of sidebarReady) {
    const newSize = sidebarOverrides.get(doc._id)!;
    await sanityClient.patch(doc._id).set({ adSize: newSize }).commit();
    console.log(`  ✅ ${doc._id} → ${newSize}`);
    written++;
  }

  console.log(`\n✨ Backfill complete. ${written} document(s) updated.`);
}

if (require.main === module) {
  backfillAdSize().catch((error) => {
    console.error('Unhandled error in backfillAdSize script:', error);
    process.exit(1);
  });
}

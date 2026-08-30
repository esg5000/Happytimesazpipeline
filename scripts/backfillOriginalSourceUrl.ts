import { createClient } from '@sanity/client';
import { config } from '../config';

/**
 * Backfills originalSourceUrl on pipeline_v2 posts published before the
 * realDoc fix (src/agents/publishAssembly.ts's publishAssembledDocument()
 * never carried the field from the assembled preview object into the real
 * Sanity write — see the originalSourceUrl investigation). Source URL is
 * parsed out of the existing disclaimer field, which every pipeline_v2 post
 * already carries in the form "Sourced from: Outlet (URL)[; Outlet2 (URL2)]...".
 * The FIRST URL is used — it's the primary/first-cited source, the closest
 * available proxy for the original topic.link that should have been stored.
 *
 * Defaults to DRY RUN (no writes). Pass --write to actually patch documents.
 */

const SOURCED_FROM_RE = /Sourced from:\s*(.+?)(?:\s*Hero (?:photo|image)|$)/i;
const OUTLET_URL_RE = /\(([^()]*https?:\/\/[^()]*)\)/;

interface PostDoc {
  _id: string;
  title: string;
  disclaimer?: string;
}

function parseFirstSourceUrl(disclaimer: string | undefined): string | null {
  if (!disclaimer) return null;
  const sourcedFromMatch = disclaimer.match(SOURCED_FROM_RE);
  if (!sourcedFromMatch) return null;
  const sourceLine = sourcedFromMatch[1];
  const firstEntry = sourceLine.split(';')[0];
  const urlMatch = firstEntry.match(OUTLET_URL_RE);
  if (!urlMatch) return null;
  const url = urlMatch[1].trim();
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');
  const client = createClient({
    projectId: config.sanity.projectId,
    dataset: config.sanity.dataset,
    apiVersion: config.sanity.apiVersion,
    token: config.sanity.apiToken,
    useCdn: false,
  });

  const posts = await client.fetch<PostDoc[]>(
    `*[_type == "post" && contentSource == "pipeline_v2" && !defined(originalSourceUrl)]{ _id, title, disclaimer }`
  );

  console.log(`[backfill] Found ${posts.length} pipeline_v2 post(s) missing originalSourceUrl.`);

  let parsed = 0;
  let unparsable = 0;
  const rows: { id: string; title: string; url: string | null }[] = [];

  for (const post of posts) {
    const url = parseFirstSourceUrl(post.disclaimer);
    rows.push({ id: post._id, title: post.title, url });
    if (url) parsed++;
    else unparsable++;
  }

  console.log(`[backfill] Parsed: ${parsed}, unparsable: ${unparsable}`);
  console.log('[backfill] Unparsable rows:');
  for (const r of rows.filter((r) => !r.url)) {
    console.log(`  ${r.id} — "${r.title.slice(0, 70)}"`);
  }

  if (!write) {
    console.log('\n[backfill] DRY RUN — sample of parsed rows:');
    for (const r of rows.filter((r) => r.url).slice(0, 10)) {
      console.log(`  ${r.id} → ${r.url}`);
    }
    console.log('\n[backfill] Pass --write to apply patches.');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  const tx = client.transaction();
  for (const r of rows) {
    if (!r.url) continue;
    tx.patch(r.id, (p) => p.set({ originalSourceUrl: r.url }));
    succeeded++;
  }
  try {
    await tx.commit();
    console.log(`[backfill] WRITE committed: ${succeeded} post(s) patched, ${unparsable} skipped (unparsable).`);
  } catch (err: unknown) {
    failed = succeeded;
    succeeded = 0;
    console.error(`[backfill] WRITE FAILED (${failed} intended patches, none applied — transaction is atomic):`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

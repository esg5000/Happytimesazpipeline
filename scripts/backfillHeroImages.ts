import { config, validateConfig } from '../config';
import { getSanityClient, uploadImageBufferToSanity } from '../agents/sanityPublisher';
import { fetchUnsplashHeroImageBuffer, buildUnsplashSearchQuery } from '../agents/unsplashHero';

type PostRow = {
  _id: string;
  title: string;
  section?: string;
  categories?: string[];
};

async function fetchPostsWithoutHeroImage(): Promise<PostRow[]> {
  const sanityClient = getSanityClient();
  const query = `*[_type == "post" && !defined(heroImage)]{
    _id,
    title,
    section,
    categories
  } | order(_createdAt desc)`;
  const rows = await sanityClient.fetch<PostRow[]>(query);
  return rows || [];
}

async function patchHeroImage(postId: string, heroImageAssetId: string): Promise<void> {
  const sanityClient = getSanityClient();
  await sanityClient
    .patch(postId)
    .set({
      heroImage: {
        _type: 'image',
        asset: {
          _type: 'reference',
          _ref: heroImageAssetId,
        },
      },
    })
    .commit();
}

function buildSearchQuery(post: PostRow): string {
  const categoryHint = post.section || (post.categories?.[0] ?? '');
  return buildUnsplashSearchQuery(post.title, categoryHint);
}

async function run(): Promise<void> {
  validateConfig();

  if (!config.unsplash.accessKey) {
    console.error('UNSPLASH_ACCESS_KEY is not set — cannot run backfill.');
    process.exit(1);
  }

  console.log('Fetching posts without heroImage from Sanity…');
  const posts = await fetchPostsWithoutHeroImage();
  console.log(`Found ${posts.length} post(s) missing a hero image.\n`);

  if (posts.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    const query = buildSearchQuery(post);
    console.log(`[${post._id}] "${post.title}"`);
    console.log(`  Unsplash query: ${query}`);

    let buf: Buffer | null = null;
    try {
      buf = await fetchUnsplashHeroImageBuffer(post.title, post.section || post.categories?.[0] || '');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Unsplash fetch threw: ${msg}`);
      failed++;
      continue;
    }

    if (!buf) {
      console.log('  FAIL — Unsplash returned no image (no results or download error).');
      failed++;
      continue;
    }

    let assetId: string;
    try {
      const filename = `${post._id.replace(/[^a-z0-9-]/gi, '-')}-unsplash-hero.jpg`;
      assetId = await uploadImageBufferToSanity(buf, filename);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Sanity upload threw: ${msg}`);
      failed++;
      continue;
    }

    try {
      await patchHeroImage(post._id, assetId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Sanity patch threw: ${msg}`);
      failed++;
      continue;
    }

    console.log(`  OK — heroImage patched. assetId=${assetId}`);
    succeeded++;

    // Be polite to Unsplash rate limits (50 req/hr on free tier)
    await new Promise((r) => setTimeout(r, 1_500));
  }

  console.log('\n--- Backfill complete ---');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${posts.length}`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

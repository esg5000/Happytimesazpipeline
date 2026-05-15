import { validateConfig } from '../config';
import { getSanityClient, uploadImageBufferToSanity } from '../agents/sanityPublisher';
import { generateImage, generateImagePrompt } from '../agents/imageAgent';
import { VisualStyle } from '../utils/validator';

const TARGET_SLUGS = [
  '2027-pbr-world-finals-desert-diamond-arena-glendale',
  'kristin-key-queer-musical-comedy-phoenix',
  'new-measles-case-public-exposures-maricopa-county',
  'pbr-world-finals-championship-glendale-arizona-2027',
  'phoenix-childrens-donation',
  'poolboy-taco-sets-opening-date',
  'tko-arizona-sports-events-alliance-deal',
  'ufc-wwe-parent-company-signs-7-event-deal-for-phoenix',
] as const;

type PostRow = {
  _id: string;
  title: string;
  section?: string;
  visualStyle?: VisualStyle;
  heroImagePrompt?: string;
  slug: string;
};

async function fetchPostsBySlug(slugs: readonly string[]): Promise<PostRow[]> {
  const sanityClient = getSanityClient();
  const query = `*[_type == "post" && slug.current in $slugs]{
    _id,
    title,
    section,
    visualStyle,
    heroImagePrompt,
    "slug": slug.current
  }`;
  const rows = await sanityClient.fetch<PostRow[]>(query, { slugs: [...slugs] });
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

async function run(): Promise<void> {
  validateConfig();

  console.log(`Fetching ${TARGET_SLUGS.length} posts from Sanity…`);
  const posts = await fetchPostsBySlug(TARGET_SLUGS);

  // Report any slugs not found in Sanity
  const foundSlugs = new Set(posts.map((p) => p.slug));
  for (const slug of TARGET_SLUGS) {
    if (!foundSlugs.has(slug)) {
      console.warn(`  WARNING: slug not found in Sanity — "${slug}"`);
    }
  }
  console.log(`Found ${posts.length} post(s).\n`);

  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    console.log(`[${post._id}] "${post.title}"`);

    const section = post.section || 'news';
    const visualStyle: VisualStyle = (post.visualStyle as VisualStyle) || 'photo_real';
    const basePrompt =
      typeof post.heroImagePrompt === 'string' && post.heroImagePrompt.trim().length >= 20
        ? post.heroImagePrompt.trim()
        : `Photorealistic editorial photograph for a ${section} article about: ${post.title}. Greater Phoenix, Arizona context where appropriate.`;

    console.log(`  section=${section} visualStyle=${visualStyle}`);
    console.log(`  base prompt: ${basePrompt.slice(0, 120)}…`);

    // Enhance the prompt
    let enhancedPrompt: string;
    try {
      enhancedPrompt = await generateImagePrompt(basePrompt, visualStyle);
      console.log(`  enhanced prompt (${enhancedPrompt.length} chars)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — generateImagePrompt threw: ${msg}`);
      failed++;
      continue;
    }

    // Generate image via gpt-image-1
    let imageBuf: Buffer | null = null;
    try {
      imageBuf = await generateImage(enhancedPrompt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — generateImage threw: ${msg}`);
      failed++;
      continue;
    }

    if (!imageBuf) {
      console.log('  FAIL — gpt-image-1 returned null.');
      failed++;
      continue;
    }

    // Upload to Sanity
    let assetId: string;
    try {
      const filename = `${post.slug.slice(0, 40)}-gpt-hero.jpg`;
      assetId = await uploadImageBufferToSanity(imageBuf, filename);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Sanity upload threw: ${msg}`);
      failed++;
      continue;
    }

    // Patch heroImage
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
  }

  console.log('\n--- Done ---');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${posts.length}`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

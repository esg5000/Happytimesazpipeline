import { createClient } from '@sanity/client';
import { config } from '../config';
import { markdownToPortableText } from '../agents/sanityPublisher'; // Assuming markdownToPortableText is in sanityPublisher

interface PostDocument {
  _id: string;
  _rev: string;
  title: string;
  slug: { current: string };
  body: string | any[]; // body can be string (legacy) or Portable Text array
}

async function repairPortableText(): Promise<void> {
  console.log('🚀 Starting Portable Text repair script...');

  try {
    // Initialize Sanity client
    const sanityClient = createClient({
      projectId: config.sanity.projectId,
      dataset: config.sanity.dataset,
      apiVersion: config.sanity.apiVersion,
      token: config.sanity.apiToken,
      useCdn: false,
    });

    // Query for documents where body is a string (legacy format)
    console.log('🔍 Querying for posts with string body...');
    const brokenPosts: PostDocument[] = await sanityClient.fetch(
      `*[_type == "post" && defined(body)]{ _id, _rev, title, slug, body }`
    );

    if (brokenPosts.length === 0) {
      console.log('✅ No posts found with string body to repair. Exiting.');
      return;
    }

    console.log(`Found ${brokenPosts.length} posts to repair.`);

    let repairedCount = 0;

    for (const post of brokenPosts) {
      console.log(`Debug: Post '${post.title}' (ID: ${post._id}), typeof body: ${typeof post.body}, body:`, post.body);
      try {
        // Also check if it's an empty array, which might also indicate "no content"
        if (typeof post.body === 'string' || (Array.isArray(post.body) && post.body.length === 0)) {
          console.log(
            `🔧 Repairing post: '${post.title}' (Slug: ${post.slug.current}, ID: ${post._id})`
          );
          const portableTextBody = markdownToPortableText(post.body as string);

          await sanityClient
            .patch(post._id)
            .set({ body: portableTextBody })
            .commit();

          console.log(
            `✅ Repaired post: '${post.title}' (ID: ${post._id})`
          );
          repairedCount++;
        } else {
          console.log(
            `⚠️ Skipping post '${post.title}' (ID: ${post._id}) - body is already Portable Text or unexpected type.`
          );
        }
      } catch (patchError) {
        console.error(
          `❌ Error repairing post '${post.title}' (ID: ${post._id}):`, patchError
        );
      }
    }

    console.log('\n✨ Portable Text repair script finished.');
    console.log(`📊 Total articles repaired: ${repairedCount} of ${brokenPosts.length}`);
  } catch (error) {
    console.error('Fatal error during Portable Text repair:', error);
    process.exit(1);
  }
}

// Run the repair script
if (require.main === module) {
  repairPortableText().catch((error) => {
    console.error('Unhandled error in repair script:', error);
    process.exit(1);
  });
}


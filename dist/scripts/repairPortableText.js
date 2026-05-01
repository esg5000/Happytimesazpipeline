"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@sanity/client");
const config_1 = require("../config");
const sanityPublisher_1 = require("../agents/sanityPublisher");
async function repairPortableText() {
    console.log('🚀 Starting Portable Text repair script...');
    try {
        // Initialize Sanity client
        const sanityClient = (0, client_1.createClient)({
            projectId: config_1.config.sanity.projectId,
            dataset: config_1.config.sanity.dataset,
            apiVersion: config_1.config.sanity.apiVersion,
            token: config_1.config.sanity.apiToken,
            useCdn: false,
        });
        // Query for documents where body is a string (legacy format)
        console.log('🔍 Querying for posts with string body...');
        const brokenPosts = await sanityClient.fetch(`*[_type == "post" && defined(body)]{ _id, _rev, title, slug, body }`);
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
                    console.log(`🔧 Repairing post: '${post.title}' (Slug: ${post.slug.current}, ID: ${post._id})`);
                    const portableTextBody = (0, sanityPublisher_1.markdownToPortableText)(post.body);
                    await sanityClient
                        .patch(post._id)
                        .set({ body: portableTextBody })
                        .commit();
                    console.log(`✅ Repaired post: '${post.title}' (ID: ${post._id})`);
                    repairedCount++;
                }
                else {
                    console.log(`⚠️ Skipping post '${post.title}' (ID: ${post._id}) - body is already Portable Text or unexpected type.`);
                }
            }
            catch (patchError) {
                console.error(`❌ Error repairing post '${post.title}' (ID: ${post._id}):`, patchError);
            }
        }
        console.log('\n✨ Portable Text repair script finished.');
        console.log(`📊 Total articles repaired: ${repairedCount} of ${brokenPosts.length}`);
    }
    catch (error) {
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
//# sourceMappingURL=repairPortableText.js.map
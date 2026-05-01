"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPipeline = runPipeline;
const config_1 = require("./config");
const topicAgent_1 = require("./agents/topicAgent");
const writerAgent_1 = require("./agents/writerAgent");
const imageAgent_1 = require("./agents/imageAgent");
const sanityPublisher_1 = require("./agents/sanityPublisher");
const slug_1 = require("./utils/slug");
const articleStyle_1 = require("./utils/articleStyle");
/**
 * Main orchestrator for the AI publishing pipeline
 */
async function runPipeline(options) {
    console.log('🚀 Starting HappyTimesAZ AI Publishing Pipeline\n');
    try {
        // Validate configuration
        (0, config_1.validateConfig)();
        console.log('✅ Configuration validated\n');
        // Get existing slugs for uniqueness check
        console.log('📋 Fetching existing slugs...');
        const existingSlugs = await (0, sanityPublisher_1.getExistingSlugs)();
        console.log(`   Found ${existingSlugs.length} existing posts\n`);
        // Step 1: Generate topics
        console.log(`📝 Generating ${config_1.config.pipeline.articlesPerDay} topics...`);
        if (options?.notes?.trim()) {
            console.log(`   Editorial notes → topic agent (${options.notes.trim().length} chars)`);
        }
        const applyStyle = options?.applyDashboardArticleStyle === true;
        const articleLength = options?.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
        const articleTone = options?.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
        const topics = await (0, topicAgent_1.generateTopics)(config_1.config.pipeline.articlesPerDay, {
            notes: options?.notes,
            applyDashboardArticleStyle: applyStyle,
            ...(applyStyle ? { articleLength, articleTone } : {}),
        });
        console.log(`✅ Generated ${topics.length} topics\n`);
        const results = [];
        // Process each topic
        for (let i = 0; i < topics.length; i++) {
            const topic = topics[i];
            console.log(`\n📰 Processing article ${i + 1}/${topics.length}: ${topic.title}`);
            try {
                // Step 2: Write article
                console.log('   ✍️  Writing article...');
                let article = await (0, writerAgent_1.writeArticle)(topic, {
                    applyDashboardArticleStyle: applyStyle,
                    ...(applyStyle ? { articleLength, articleTone } : {}),
                });
                // Ensure slug uniqueness
                article = {
                    ...article,
                    slug: (0, slug_1.ensureUniqueSlug)(article.slug, existingSlugs),
                };
                existingSlugs.push(article.slug);
                console.log(`   ✅ Article written: ${article.title}`);
                // Step 3: Generate image prompt
                console.log('   🎨 Generating image prompt...');
                const enhancedImagePrompt = await (0, imageAgent_1.generateImagePrompt)(article.heroImagePrompt, article.visualStyle);
                console.log('   ✅ Image prompt generated');
                // Step 4: Generate image
                console.log('   🖼️  Generating image...');
                const imageUrl = await (0, imageAgent_1.generateImage)(enhancedImagePrompt);
                if (imageUrl) {
                    console.log('   ✅ Image generated');
                }
                else {
                    console.warn('   ⚠️  Image generation failed; continuing without hero image');
                }
                let sanityId;
                try {
                    // Step 5: Upload image to Sanity
                    let imageAssetId;
                    if (imageUrl) {
                        console.log('   📤 Uploading image to Sanity...');
                        imageAssetId = await (0, sanityPublisher_1.uploadImageToSanity)(imageUrl, `${article.slug}-hero.jpg`);
                        console.log('   ✅ Image uploaded');
                    }
                    // Step 6: Publish article to Sanity (as draft)
                    console.log('   📝 Publishing article to Sanity...');
                    sanityId = await (0, sanityPublisher_1.publishArticleToSanity)(article, imageAssetId, topic.section);
                    console.log(`   ✅ Article published as draft: ${sanityId}`);
                }
                catch (sanityError) {
                    const sanityMessage = sanityError instanceof Error ? sanityError.message : String(sanityError);
                    console.error(`   ❌ Sanity upload/publish failed for "${article.title}": ${sanityMessage}`);
                    const errAny = sanityError;
                    if (errAny?.response?.body !== undefined) {
                        console.error('   Sanity response:', typeof errAny.response.body === 'string'
                            ? errAny.response.body
                            : JSON.stringify(errAny.response.body));
                    }
                    results.push({
                        success: false,
                        error: `Sanity: ${sanityMessage}`,
                    });
                    continue;
                }
                results.push({
                    success: true,
                    article: {
                        title: article.title,
                        slug: article.slug,
                        sanityId,
                    },
                });
                console.log(`\n✅ Successfully processed: ${article.title}`);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                console.error(`   ❌ Error processing article: ${errorMessage}`);
                results.push({
                    success: false,
                    error: errorMessage,
                });
            }
        }
        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 PIPELINE SUMMARY');
        console.log('='.repeat(60));
        const successful = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        console.log(`✅ Successful: ${successful}`);
        console.log(`❌ Failed: ${failed}`);
        if (successful > 0) {
            console.log('\n📝 Published Articles:');
            results
                .filter((r) => r.success)
                .forEach((r) => {
                console.log(`   - ${r.article?.title} (${r.article?.slug})`);
            });
        }
        if (failed > 0) {
            console.log('\n❌ Failed Articles:');
            results
                .filter((r) => !r.success)
                .forEach((r) => {
                console.log(`   - ${r.error}`);
            });
        }
        console.log('\n✨ Pipeline complete!\n');
    }
    catch (error) {
        console.error('\n❌ Pipeline failed:', error);
        throw error;
    }
}
// Run the pipeline (CLI only — exits process; daemon imports runPipeline without exiting)
if (require.main === module) {
    runPipeline()
        .then(() => process.exit(0))
        .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=orchestrator.js.map
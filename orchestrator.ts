import { config, validateConfig } from './config';
import { generateTopics } from './agents/topicAgent';
import { writeArticle } from './agents/writerAgent';
import { generateImagePrompt, generateImage } from './agents/imageAgent';
import {
  uploadImageToSanity,
  publishArticleToSanity,
  getExistingSlugs,
} from './agents/sanityPublisher';
import { ensureUniqueSlug } from './utils/slug';
import { Article } from './utils/validator';

interface PipelineResult {
  success: boolean;
  article?: {
    title: string;
    slug: string;
    sanityId?: string;
  };
  error?: string;
}

/**
 * Main orchestrator for the AI publishing pipeline
 */
async function runPipeline(): Promise<void> {
  console.log('🚀 Starting HappyTimesAZ AI Publishing Pipeline\n');

  try {
    // Validate configuration
    validateConfig();
    console.log('✅ Configuration validated\n');

    // Get existing slugs for uniqueness check
    console.log('📋 Fetching existing slugs...');
    const existingSlugs = await getExistingSlugs();
    console.log(`   Found ${existingSlugs.length} existing posts\n`);

    // Step 1: Generate topics
    console.log(`📝 Generating ${config.pipeline.articlesPerDay} topics...`);
    const topics = await generateTopics(config.pipeline.articlesPerDay);
    console.log(`✅ Generated ${topics.length} topics\n`);

    const results: PipelineResult[] = [];

    // Process each topic
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      console.log(`\n📰 Processing article ${i + 1}/${topics.length}: ${topic.title}`);

      try {
        // Step 2: Write article
        console.log('   ✍️  Writing article...');
        let article = await writeArticle(topic);

        // Ensure slug uniqueness
        article = {
          ...article,
          slug: ensureUniqueSlug(article.slug, existingSlugs),
        };
        existingSlugs.push(article.slug);
        console.log(`   ✅ Article written: ${article.title}`);

        // Step 3: Generate image prompt
        console.log('   🎨 Generating image prompt...');
        const enhancedImagePrompt = await generateImagePrompt(
          article.heroImagePrompt,
          article.visualStyle
        );
        console.log('   ✅ Image prompt generated');

        // Step 4: Generate image
        console.log('   🖼️  Generating image...');
        const imageUrl = await generateImage(enhancedImagePrompt);
        console.log('   ✅ Image generated');

        let sanityId: string;
        try {
          // Step 5: Upload image to Sanity
          console.log('   📤 Uploading image to Sanity...');
          const imageAssetId = await uploadImageToSanity(
            imageUrl,
            `${article.slug}-hero.jpg`
          );
          console.log('   ✅ Image uploaded');

          // Step 6: Publish article to Sanity (as draft)
          console.log('   📝 Publishing article to Sanity...');
          sanityId = await publishArticleToSanity(
            article,
            imageAssetId,
            topic.section
          );
          console.log(`   ✅ Article published as draft: ${sanityId}`);
        } catch (sanityError: unknown) {
          const sanityMessage =
            sanityError instanceof Error ? sanityError.message : String(sanityError);
          console.error(
            `   ❌ Sanity upload/publish failed for "${article.title}": ${sanityMessage}`
          );
          const errAny = sanityError as { response?: { body?: unknown } };
          if (errAny?.response?.body !== undefined) {
            console.error(
              '   Sanity response:',
              typeof errAny.response.body === 'string'
                ? errAny.response.body
                : JSON.stringify(errAny.response.body)
            );
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
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
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
  } catch (error) {
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

export { runPipeline };


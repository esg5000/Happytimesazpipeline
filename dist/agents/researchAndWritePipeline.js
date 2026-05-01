"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runResearchAndWrite = runResearchAndWrite;
const topicAgent_1 = require("./topicAgent");
const writerAgent_1 = require("./writerAgent");
const imageAgent_1 = require("./imageAgent");
const sanityPublisher_1 = require("./sanityPublisher");
const unsplashHero_1 = require("./unsplashHero");
const articleStyle_1 = require("../utils/articleStyle");
const researchAgent_1 = require("../src/agents/researchAgent");
/**
 * Runs web research (with optional progress) in parallel with topic generation, then writes one article
 * using enriched research notes, optional fact-check (`runFactCheck`, default false), Sources section,
 * hero upload, and Sanity draft publish.
 */
async function runResearchAndWrite(options) {
    const notes = options.notes.trim();
    if (!notes) {
        throw new Error('runResearchAndWrite: notes must be non-empty');
    }
    const applyStyle = options.applyDashboardArticleStyle === true;
    const articleLength = options.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
    const articleTone = options.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
    const [topics, research] = await Promise.all([
        (0, topicAgent_1.generateTopics)(1, {
            notes,
            applyDashboardArticleStyle: applyStyle,
            ...(applyStyle ? { articleLength, articleTone } : {}),
        }),
        (0, researchAgent_1.researchTopicWithProgress)(notes, options.onSourceProgress),
    ]);
    const topic = topics[0];
    if (!topic) {
        throw new Error('runResearchAndWrite: topic generation returned no topics');
    }
    let article = await (0, writerAgent_1.writeArticle)(topic, {
        sourceNotes: research.enrichedNotes,
        applyDashboardArticleStyle: applyStyle,
        ...(applyStyle ? { articleLength, articleTone } : {}),
    });
    const author = typeof options.authorName === 'string' && options.authorName.trim().length > 0
        ? options.authorName.trim()
        : writerAgent_1.HAPPYTIMESAZ_EDITORIAL_AUTHOR;
    article = { ...article, author };
    let body = article.bodyMarkdown;
    if (options.runFactCheck === true) {
        body = await (0, researchAgent_1.factCheckArticleMarkdownAnthropic)(body, research.sources);
    }
    body = (0, researchAgent_1.appendSourcesSectionMarkdown)(body, research.sources);
    article = { ...article, bodyMarkdown: body };
    let heroImageAssetId;
    let heroImageSource;
    if (options.digAndWrite === true) {
        const unsplashBuf = await (0, unsplashHero_1.fetchUnsplashHeroImageBuffer)(article.title, options.notes);
        if (unsplashBuf) {
            heroImageAssetId = await (0, sanityPublisher_1.uploadImageBufferToSanity)(unsplashBuf, `${article.slug}-unsplash-hero.jpg`);
            heroImageSource = 'unsplash';
            console.log('[researchAndWrite] hero from Unsplash → Sanity', heroImageAssetId);
        }
    }
    if (!heroImageAssetId) {
        const enhanced = await (0, imageAgent_1.generateImagePrompt)(article.heroImagePrompt, article.visualStyle);
        const imageUrl = await (0, imageAgent_1.generateImage)(enhanced);
        if (imageUrl) {
            heroImageAssetId = await (0, sanityPublisher_1.uploadImageToSanity)(imageUrl, `${article.slug}-hero.jpg`);
            heroImageSource = 'dall-e';
            console.log('[researchAndWrite] hero from DALL·E → Sanity', heroImageAssetId);
        }
        else {
            console.warn('[researchAndWrite] DALL·E image generation failed; continuing without hero image');
        }
    }
    const finalHeroId = heroImageAssetId;
    const finalHeroSource = heroImageSource ?? 'dall-e';
    console.log('[researchAndWrite] Hero image on Sanity; preparing article publish…', {
        heroImageAssetId: finalHeroId,
        heroImageSource: finalHeroSource,
    });
    console.log('[researchAndWrite] Starting article publish to Sanity...');
    let sanityDocumentId;
    try {
        let articleJsonForLog;
        try {
            articleJsonForLog = JSON.stringify(article, null, 2);
        }
        catch (stringifyErr) {
            const se = stringifyErr instanceof Error ? stringifyErr : new Error(String(stringifyErr));
            console.error('[researchAndWrite] Failed to JSON.stringify article for logging:', se.message, se.stack ?? '(no stack)');
            articleJsonForLog = `[unserializable article: ${se.message}]`;
        }
        console.log('[researchAndWrite] Full article object for Sanity publish:\n', articleJsonForLog);
        const publishAuthorOpts = typeof options.authorName === 'string' && options.authorName.trim().length > 0
            ? { authorName: options.authorName.trim() }
            : undefined;
        sanityDocumentId = await (0, sanityPublisher_1.publishArticleToSanity)(article, finalHeroId, topic.section, undefined, publishAuthorOpts);
        console.log('[researchAndWrite] Article publish to Sanity finished successfully. sanityDocumentId=', sanityDocumentId);
    }
    catch (err) {
        if (err instanceof Error) {
            console.error('[researchAndWrite] Sanity publish failed — message:', err.message);
            console.error('[researchAndWrite] Sanity publish failed — stack:\n', err.stack ?? '(no stack)');
        }
        else {
            console.error('[researchAndWrite] Sanity publish failed — non-Error value:', err);
        }
        throw err;
    }
    return {
        article,
        sources: research.sources,
        heroImageAssetId: finalHeroId,
        heroImageSource: finalHeroSource,
        sanityDocumentId,
    };
}
//# sourceMappingURL=researchAndWritePipeline.js.map
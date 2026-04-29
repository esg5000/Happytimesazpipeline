import { generateTopics } from './topicAgent';
import { writeArticle, HAPPYTIMESAZ_EDITORIAL_AUTHOR } from './writerAgent';
import { generateImage, generateImagePrompt } from './imageAgent';
import {
  publishArticleToSanity,
  uploadImageBufferToSanity,
  uploadImageToSanity,
} from './sanityPublisher';
import { fetchUnsplashHeroImageBuffer } from './unsplashHero';
import { Article } from '../utils/validator';
import {
  type ArticleLength,
  type ArticleTone,
  DEFAULT_ARTICLE_LENGTH,
  DEFAULT_ARTICLE_TONE,
} from '../utils/articleStyle';
import {
  appendSourcesSectionMarkdown,
  factCheckArticleMarkdownAnthropic,
  researchTopicWithProgress,
  type Source,
} from '../src/agents/researchAgent';

export type ResearchAndWriteOptions = {
  notes: string;
  applyDashboardArticleStyle: boolean;
  articleLength?: ArticleLength;
  articleTone?: ArticleTone;
  /** Dashboard byline; falls back to HappyTimesAZ Editorial. */
  authorName?: string;
  /**
   * Dig & Write: try Unsplash hero from topic + notes keywords first; otherwise same DALL·E path as below.
   * Just Write / autonomous orchestrator are unchanged.
   */
  digAndWrite?: boolean;
  /** Fired whenever merged sources update (parallel search angles complete). */
  onSourceProgress?: (payload: { sources: Source[] }) => void;
  /**
   * When true, runs the OpenAI fact-check pass (⚠️ markers) on the draft body before Sources.
   * Default false to save cost on typical Dig & Write runs.
   */
  runFactCheck?: boolean;
};

export type ResearchAndWriteResult = {
  article: Article;
  sources: Source[];
  /** Sanity image asset `_id` for hero (Unsplash or DALL·E). */
  heroImageAssetId: string;
  heroImageSource: 'unsplash' | 'dall-e';
  /** Sanity draft post `_id` after `publishArticleToSanity`. */
  sanityDocumentId: string;
};

/**
 * Runs web research (with optional progress) in parallel with topic generation, then writes one article
 * using enriched research notes, optional fact-check (`runFactCheck`, default false), Sources section,
 * hero upload, and Sanity draft publish.
 */
export async function runResearchAndWrite(
  options: ResearchAndWriteOptions
): Promise<ResearchAndWriteResult> {
  const notes = options.notes.trim();
  if (!notes) {
    throw new Error('runResearchAndWrite: notes must be non-empty');
  }

  const applyStyle = options.applyDashboardArticleStyle === true;
  const articleLength = options.articleLength ?? DEFAULT_ARTICLE_LENGTH;
  const articleTone = options.articleTone ?? DEFAULT_ARTICLE_TONE;

  const [topics, research] = await Promise.all([
    generateTopics(1, {
      notes,
      applyDashboardArticleStyle: applyStyle,
      ...(applyStyle ? { articleLength, articleTone } : {}),
    }),
    researchTopicWithProgress(notes, options.onSourceProgress),
  ]);

  const topic = topics[0];
  if (!topic) {
    throw new Error('runResearchAndWrite: topic generation returned no topics');
  }

  let article = await writeArticle(topic, {
    sourceNotes: research.enrichedNotes,
    applyDashboardArticleStyle: applyStyle,
    ...(applyStyle ? { articleLength, articleTone } : {}),
  });

  const author =
    typeof options.authorName === 'string' && options.authorName.trim().length > 0
      ? options.authorName.trim()
      : HAPPYTIMESAZ_EDITORIAL_AUTHOR;
  article = { ...article, author };

  let body = article.bodyMarkdown;
  if (options.runFactCheck === true) {
    body = await factCheckArticleMarkdownAnthropic(body, research.sources);
  }
  body = appendSourcesSectionMarkdown(body, research.sources);
  article = { ...article, bodyMarkdown: body };

  let heroImageAssetId: string | undefined;
  let heroImageSource: 'unsplash' | 'dall-e' | undefined;

  if (options.digAndWrite === true) {
    const unsplashBuf = await fetchUnsplashHeroImageBuffer(article.title, options.notes);
    if (unsplashBuf) {
      heroImageAssetId = await uploadImageBufferToSanity(
        unsplashBuf,
        `${article.slug}-unsplash-hero.jpg`
      );
      heroImageSource = 'unsplash';
      console.log('[researchAndWrite] hero from Unsplash → Sanity', heroImageAssetId);
    }
  }

  if (!heroImageAssetId) {
    const enhanced = await generateImagePrompt(article.heroImagePrompt, article.visualStyle);
    const imageUrl = await generateImage(enhanced);
    heroImageAssetId = await uploadImageToSanity(imageUrl, `${article.slug}-hero.jpg`);
    heroImageSource = 'dall-e';
    console.log('[researchAndWrite] hero from DALL·E → Sanity', heroImageAssetId);
  }

  const finalHeroId = heroImageAssetId;
  const finalHeroSource = heroImageSource ?? 'dall-e';
  if (!finalHeroId) {
    throw new Error('researchAndWrite: hero image upload failed');
  }

  console.log('[researchAndWrite] Hero image on Sanity; preparing article publish…', {
    heroImageAssetId: finalHeroId,
    heroImageSource: finalHeroSource,
  });

  console.log('[researchAndWrite] Starting article publish to Sanity...');
  let sanityDocumentId: string;
  try {
    let articleJsonForLog: string;
    try {
      articleJsonForLog = JSON.stringify(article, null, 2);
    } catch (stringifyErr: unknown) {
      const se =
        stringifyErr instanceof Error ? stringifyErr : new Error(String(stringifyErr));
      console.error(
        '[researchAndWrite] Failed to JSON.stringify article for logging:',
        se.message,
        se.stack ?? '(no stack)'
      );
      articleJsonForLog = `[unserializable article: ${se.message}]`;
    }
    console.log('[researchAndWrite] Full article object for Sanity publish:\n', articleJsonForLog);

    const publishAuthorOpts =
      typeof options.authorName === 'string' && options.authorName.trim().length > 0
        ? { authorName: options.authorName.trim() }
        : undefined;

    sanityDocumentId = await publishArticleToSanity(
      article,
      finalHeroId,
      topic.section,
      undefined,
      publishAuthorOpts
    );

    console.log(
      '[researchAndWrite] Article publish to Sanity finished successfully. sanityDocumentId=',
      sanityDocumentId
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error('[researchAndWrite] Sanity publish failed — message:', err.message);
      console.error('[researchAndWrite] Sanity publish failed — stack:\n', err.stack ?? '(no stack)');
    } else {
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

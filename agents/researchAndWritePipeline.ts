import { generateTopics } from './topicAgent';
import { writeArticle, HAPPYTIMESAZ_EDITORIAL_AUTHOR } from './writerAgent';
import { generateImage, generateImagePrompt } from './imageAgent';
import {
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
};

export type ResearchAndWriteResult = {
  article: Article;
  sources: Source[];
  /** Sanity image asset `_id` for hero (Unsplash or DALL·E). */
  heroImageAssetId: string;
  heroImageSource: 'unsplash' | 'dall-e';
};

/**
 * Runs web research (with optional progress) in parallel with topic generation, then writes one article
 * using enriched research notes, fact-checks with Claude, and appends a Sources section (no Sanity publish).
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

  let body = await factCheckArticleMarkdownAnthropic(article.bodyMarkdown, research.sources);
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

  return {
    article,
    sources: research.sources,
    heroImageAssetId: finalHeroId,
    heroImageSource: finalHeroSource,
  };
}

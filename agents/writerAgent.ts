import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateArticle, Article } from '../utils/validator';
import { Topic } from '../utils/validator';
import { generateSlug } from '../utils/slug';
import {
  type ArticleLength,
  type ArticleTone,
  DEFAULT_ARTICLE_LENGTH,
  DEFAULT_ARTICLE_TONE,
  buildWriterArticleStyleAppend,
} from '../utils/articleStyle';

// Resolve prompt path - works in both dev and compiled dist
const WRITER_PROMPT_PATH = join(process.cwd(), 'prompts', 'writer.prompt.txt');

/** Stored on article when the editor uploaded real photos; hero is never AI-generated. */
export const EDITOR_SUPPLIED_HERO_IMAGE_PROMPT =
  'Editor-supplied photography only; no AI-generated hero image for this article.';

export type WriteArticleOptions = {
  /**
   * Raw notes from the editor (e.g. Telegram or dashboard). When set, the article body must
   * follow this material — do not substitute an unrelated topic or autonomous angle.
   */
  sourceNotes?: string;
  /**
   * When true, the pipeline will not call DALL·E; heroImagePrompt is set to a fixed placeholder.
   */
  userSuppliedImages?: boolean;
  /** Approximate body word target (dashboard / pipeline). Defaults: medium (~600), straight-news. */
  articleLength?: ArticleLength;
  articleTone?: ArticleTone;
};

/**
 * Writes an article based on a topic.
 */
export async function writeArticle(
  topic: Topic,
  options?: WriteArticleOptions
): Promise<Article> {
  const basePrompt = readFileSync(WRITER_PROMPT_PATH, 'utf-8');
  const length = options?.articleLength ?? DEFAULT_ARTICLE_LENGTH;
  const tone = options?.articleTone ?? DEFAULT_ARTICLE_TONE;
  const systemPrompt = `${basePrompt.trim()}${buildWriterArticleStyleAppend(length, tone)}`;

  const notesBlock =
    options?.sourceNotes && options.sourceNotes.trim().length > 0
      ? `PRIMARY SOURCE MATERIAL (editor — the article must follow this substance, facts, and angle; do not pivot to an unrelated topic):\n---\n${options.sourceNotes.trim()}\n---\n\n`
      : '';

  const imageNote = options?.userSuppliedImages
    ? 'Real photography from the editor is already attached (hero + any additional images). No AI-generated hero image will be produced — focus the article on the source material below.\n\n'
    : '';

  const userPrompt = `${notesBlock}${imageNote}Write an article about: ${topic.title}

Section: ${topic.section}
Description: ${topic.description}
Keywords: ${topic.keywords.join(', ')}

Generate a complete article following all guidelines (including RUN-SPECIFIC length and tone above).
Remember: seoDescription must be at most 155 characters (count spaces).`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0].message.content;
  let parsedContent: unknown;

  try {
    // Remove markdown code blocks if present
    const cleanedContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsedContent = JSON.parse(cleanedContent);
  } catch (parseError) {
    throw new Error(`Failed to parse article JSON: ${parseError}`);
  }

  // Ensure slug is generated if missing or invalid
  if (parsedContent && typeof parsedContent === 'object' && 'title' in parsedContent) {
    const articleObj = parsedContent as { title: string; slug?: string };
    if (!articleObj.slug || articleObj.slug.trim() === '') {
      articleObj.slug = generateSlug(articleObj.title);
    }
  }

  const validation = validateArticle(parsedContent);
  if (!validation.success) {
    throw new Error(
      `Article validation failed: ${validation.errors?.join(', ')}`
    );
  }

  let article = validation.data!;
  if (options?.userSuppliedImages) {
    article = {
      ...article,
      heroImagePrompt: EDITOR_SUPPLIED_HERO_IMAGE_PROMPT,
    };
  }

  return article;
}


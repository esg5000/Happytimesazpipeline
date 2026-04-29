import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateTopic, Topic } from '../utils/validator';
import {
  type ArticleLength,
  type ArticleTone,
  DEFAULT_ARTICLE_LENGTH,
  DEFAULT_ARTICLE_TONE,
  buildIngestArticleStyleAppend,
} from '../utils/articleStyle';

// Resolve prompt path - works in both dev and compiled dist
const TOPIC_PROMPT_PATH = join(process.cwd(), 'prompts', 'topic.prompt.txt');

/** OpenAI model for Chat Completions topic JSON (`generateTopics` / `generateSingleTopic`). */
const TOPIC_OPENAI_MODEL = 'gpt-5.4-mini';

export type GenerateTopicsOptions = {
  /** Passed into each topic request to steer angles (e.g. API /publish). */
  notes?: string;
  /** Dashboard-only: length/tone + spin rules on topic prompt. */
  applyDashboardArticleStyle?: boolean;
  articleLength?: ArticleLength;
  articleTone?: ArticleTone;
};

/**
 * Generates article topics using OpenAI
 */
export async function generateTopics(
  count: number = 3,
  options?: GenerateTopicsOptions
): Promise<Topic[]> {
  const prompt = readFileSync(TOPIC_PROMPT_PATH, 'utf-8');
  const topics: Topic[] = [];
  const editorialNotes = options?.notes?.trim();
  const applyStyle = options?.applyDashboardArticleStyle === true;
  const articleLength = options?.articleLength ?? DEFAULT_ARTICLE_LENGTH;
  const articleTone = options?.articleTone ?? DEFAULT_ARTICLE_TONE;
  if (editorialNotes) {
    console.log(
      `[topicAgent] Applying editorial notes to each topic request (${editorialNotes.length} chars)`
    );
  }

  for (let i = 0; i < count; i++) {
    try {
      const lastSection =
        topics.length > 0 ? topics[topics.length - 1]!.section : undefined;
      // Pass context about previously generated topics to avoid repetition
      const topic = await generateSingleTopic(
        prompt,
        topics,
        editorialNotes,
        applyStyle,
        articleLength,
        articleTone,
        lastSection
      );
      topics.push(topic);
    } catch (error) {
      console.error(`Error generating topic ${i + 1}:`, error);
      throw error;
    }
  }

  return topics;
}

/**
 * Generates a single topic
 */
async function generateSingleTopic(
  systemPrompt: string,
  existingTopics: Topic[] = [],
  editorialNotes?: string,
  applyDashboardArticleStyle = false,
  articleLength: ArticleLength = DEFAULT_ARTICLE_LENGTH,
  articleTone: ArticleTone = DEFAULT_ARTICLE_TONE,
  lastGeneratedSection?: string
): Promise<Topic> {
  const styleAppend = applyDashboardArticleStyle
    ? buildIngestArticleStyleAppend(articleLength, articleTone)
    : '';
  let systemContent = `${systemPrompt.trim()}${styleAppend}`;
  if (editorialNotes) {
    systemContent += `\n\n---\nWhen the user message includes EDITOR DIRECTION, you MUST prioritize it: title, section, description, and keywords must clearly reflect that direction while staying Phoenix-local and on-brand for HappyTimesAZ.`;
  }

  let userPrompt: string;
  if (editorialNotes) {
    userPrompt = [
      'EDITOR DIRECTION (primary constraint — the topic must satisfy this):',
      editorialNotes,
      '',
      'Generate exactly one new article topic JSON for HappyTimesAZ.com that fulfills the editor direction above.',
    ].join('\n');
  } else {
    userPrompt = 'Generate a new article topic for HappyTimesAZ.com';
  }

  if (lastGeneratedSection && lastGeneratedSection.trim()) {
    const s = lastGeneratedSection.trim();
    userPrompt += `\n\nThe last article was in the ${s} section — do NOT generate another ${s} topic. Pick a different section.`;
  }

  if (existingTopics.length > 0) {
    const existingTitles = existingTopics.map(t => `- ${t.title} (${t.section})`).join('\n');
    userPrompt += `\n\nIMPORTANT: Avoid generating topics similar to these already generated topics:\n${existingTitles}\n\nEnsure your new topic is unique, different in angle, and ideally in a different section when possible.`;
  }

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: TOPIC_OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: systemContent,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.9, // Increased from 0.8 to 0.9 for more variety
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
    throw new Error(`Failed to parse topic JSON: ${parseError}`);
  }

  const validation = validateTopic(parsedContent);
  if (!validation.success) {
    throw new Error(
      `Topic validation failed: ${validation.errors?.join(', ')}`
    );
  }

  return validation.data!;
}


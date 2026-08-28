import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateTopic, Topic } from '../utils/validator';
import { geminiChatJson, withGeminiFallback } from './geminiAgent';
import {
  type ArticleLength,
  type ArticleTone,
  DEFAULT_ARTICLE_LENGTH,
  DEFAULT_ARTICLE_TONE,
  buildIngestArticleStyleAppend,
} from '../utils/articleStyle';
import { getSanityClient } from './sanityPublisher';

// Resolve prompt path - works in both dev and compiled dist
const TOPIC_PROMPT_PATH = join(process.cwd(), 'prompts', 'topic.prompt.txt');

/** OpenAI model for Chat Completions topic JSON (`generateTopics` / `generateSingleTopic`). */
const TOPIC_OPENAI_MODEL = 'gpt-5.4-mini';

/** Autonomous-pipeline topic dedup: how far back to look for recently published posts. */
const RECENT_TITLES_LOOKBACK_DAYS = 7;
/** Autonomous-pipeline topic dedup: retries per topic slot before accepting a possible duplicate. */
const DEDUP_MAX_ATTEMPTS = 3;

export type GenerateTopicsOptions = {
  /** Passed into each topic request to steer angles (e.g. API /publish). */
  notes?: string;
  /** Dashboard-only: length/tone + spin rules on topic prompt. */
  applyDashboardArticleStyle?: boolean;
  articleLength?: ArticleLength;
  articleTone?: ArticleTone;
  /**
   * Autonomous pipeline only (orchestrator.ts). When true, generated topic titles are checked
   * against post titles published in the last 7 days and regenerated on a close match.
   */
  autonomousMode?: boolean;
};

/** Normalize a title for duplicate comparison: lowercase, collapsed whitespace. */
function normalizeTitleForDedup(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleWordSet(normalized: string): Set<string> {
  return new Set(normalized.split(' ').filter((w) => w.length > 2));
}

/** Close-variation check: exact match, substring containment, or high word overlap (Jaccard >= 0.7). */
function isCloseTitleMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length > 8 && b.length > 8 && (a.includes(b) || b.includes(a))) return true;
  const wa = titleWordSet(a);
  const wb = titleWordSet(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / (wa.size + wb.size - overlap) >= 0.7;
}

/** Post titles created in the last 7 days, for autonomous-pipeline topic dedup. */
async function fetchRecentPostTitles(): Promise<string[]> {
  const client = getSanityClient();
  const cutoffIso = new Date(
    Date.now() - RECENT_TITLES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const titles = await client.fetch<string[]>(
    `*[_type == "post" && _createdAt >= $cutoff].title`,
    { cutoff: cutoffIso }
  );
  return (titles || []).filter((t): t is string => typeof t === 'string');
}

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
  const autonomousMode = options?.autonomousMode === true;
  if (editorialNotes) {
    console.log(
      `[topicAgent] Applying editorial notes to each topic request (${editorialNotes.length} chars)`
    );
  }

  let normalizedRecentTitles: string[] = [];
  if (autonomousMode) {
    try {
      const recentTitles = await fetchRecentPostTitles();
      normalizedRecentTitles = recentTitles.map(normalizeTitleForDedup);
      console.log(
        `[topicAgent] Autonomous mode: loaded ${normalizedRecentTitles.length} post title(s) from the last ${RECENT_TITLES_LOOKBACK_DAYS} days for dedup`
      );
    } catch (error) {
      console.error(
        '[topicAgent] Failed to fetch recent post titles for dedup; continuing without dedup check:',
        error
      );
    }
  }

  for (let i = 0; i < count; i++) {
    try {
      const lastSection =
        topics.length > 0 ? topics[topics.length - 1]!.section : undefined;

      let topic: Topic;
      if (autonomousMode && normalizedRecentTitles.length > 0) {
        const rejectedThisSlot: Topic[] = [];
        let accepted: Topic | undefined;
        for (let attempt = 1; attempt <= DEDUP_MAX_ATTEMPTS; attempt++) {
          // Pass context about previously generated topics (this run + rejected retries) to avoid repetition
          const candidate = await generateSingleTopic(
            prompt,
            [...topics, ...rejectedThisSlot],
            editorialNotes,
            applyStyle,
            articleLength,
            articleTone,
            lastSection
          );
          const normalizedCandidate = normalizeTitleForDedup(candidate.title);
          const isDuplicate = normalizedRecentTitles.some((t) =>
            isCloseTitleMatch(normalizedCandidate, t)
          );
          if (!isDuplicate) {
            accepted = candidate;
            break;
          }
          console.warn(
            `[topicAgent] Topic ${i + 1}/${count} attempt ${attempt}/${DEDUP_MAX_ATTEMPTS}: "${candidate.title}" matches a post published in the last ${RECENT_TITLES_LOOKBACK_DAYS} days; regenerating…`
          );
          rejectedThisSlot.push(candidate);
          if (attempt === DEDUP_MAX_ATTEMPTS) {
            console.warn(
              `[topicAgent] Topic ${i + 1}/${count}: could not find a unique title after ${DEDUP_MAX_ATTEMPTS} attempts; keeping last candidate "${candidate.title}".`
            );
            accepted = candidate;
          }
        }
        topic = accepted!;
      } else {
        // Pass context about previously generated topics to avoid repetition
        topic = await generateSingleTopic(
          prompt,
          topics,
          editorialNotes,
          applyStyle,
          articleLength,
          articleTone,
          lastSection
        );
      }

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

  const content = await withGeminiFallback(
    'topicAgent.generateSingleTopic',
    async () => {
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
      return response.data.choices[0].message.content as string;
    },
    () => geminiChatJson(systemContent, userPrompt, { temperature: 0.9 })
  );
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


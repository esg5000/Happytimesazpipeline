import axios from 'axios';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import { validateTopic, Topic } from '../utils/validator';

// Resolve prompt path - works in both dev and compiled dist
const INGEST_PROMPT_PATH = join(process.cwd(), 'prompts', 'ingest.prompt.txt');

export type IngestInput = {
  section?: Topic['section'];
  title?: string;
  keywords?: string[];
  notes: string;
};

/**
 * Converts Telegram notes into a validated Topic JSON object.
 */
export async function ingestToTopic(input: IngestInput): Promise<Topic> {
  const systemPrompt = readFileSync(INGEST_PROMPT_PATH, 'utf-8');

  const userParts: string[] = [];
  if (input.section) userParts.push(`PREFERRED_SECTION: ${input.section}`);
  if (input.title) userParts.push(`PREFERRED_TITLE: ${input.title}`);
  if (input.keywords && input.keywords.length > 0) {
    userParts.push(`PREFERRED_KEYWORDS: ${input.keywords.join(', ')}`);
  }
  userParts.push(`NOTES:\n${input.notes}`);

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: config.openai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userParts.join('\n\n') },
      ],
      temperature: 0.6,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0].message.content;
  let parsedContent: unknown;

  try {
    const cleanedContent = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    parsedContent = JSON.parse(cleanedContent);
  } catch (parseError) {
    throw new Error(`Failed to parse ingest topic JSON: ${parseError}`);
  }

  const validation = validateTopic(parsedContent);
  if (!validation.success) {
    throw new Error(
      `Ingest topic validation failed: ${validation.errors?.join(', ')}`
    );
  }

  return validation.data!;
}


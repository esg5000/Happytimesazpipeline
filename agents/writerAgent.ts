import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateArticle, Article } from '../utils/validator';
import { Topic } from '../utils/validator';
import { generateSlug } from '../utils/slug';

// Resolve prompt path - works in both dev and compiled dist
const WRITER_PROMPT_PATH = join(process.cwd(), 'prompts', 'writer.prompt.txt');

/**
 * Writes an article based on a topic
 */
export async function writeArticle(topic: Topic): Promise<Article> {
  const systemPrompt = readFileSync(WRITER_PROMPT_PATH, 'utf-8');

  const userPrompt = `Write an article about: ${topic.title}

Section: ${topic.section}
Description: ${topic.description}
Keywords: ${topic.keywords.join(', ')}

Generate a complete article following all guidelines.
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

  return validation.data!;
}


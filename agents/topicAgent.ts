import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateTopic, Topic } from '../utils/validator';

// Resolve prompt path - works in both dev and compiled dist
const TOPIC_PROMPT_PATH = join(process.cwd(), 'prompts', 'topic.prompt.txt');

/**
 * Generates article topics using OpenAI
 */
export async function generateTopics(count: number = 3): Promise<Topic[]> {
  const prompt = readFileSync(TOPIC_PROMPT_PATH, 'utf-8');
  const topics: Topic[] = [];

  for (let i = 0; i < count; i++) {
    try {
      // Pass context about previously generated topics to avoid repetition
      const topic = await generateSingleTopic(prompt, topics);
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
  existingTopics: Topic[] = []
): Promise<Topic> {
  // Build context about existing topics to avoid repetition
  let userPrompt = 'Generate a new article topic for HappyTimesAZ.com';
  
  if (existingTopics.length > 0) {
    const existingTitles = existingTopics.map(t => `- ${t.title} (${t.section})`).join('\n');
    userPrompt += `\n\nIMPORTANT: Avoid generating topics similar to these already generated topics:\n${existingTitles}\n\nEnsure your new topic is unique, different in angle, and ideally in a different section when possible.`;
  }

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


import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';

// Resolve prompt path - works in both dev and compiled dist
const IMAGE_PROMPT_PATH = join(process.cwd(), 'prompts', 'image.prompt.txt');

/**
 * Generates an enhanced image prompt for DALL-E or similar
 */
export async function generateImagePrompt(
  basePrompt: string
): Promise<string> {
  const systemPrompt = readFileSync(IMAGE_PROMPT_PATH, 'utf-8');

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
          content: `Enhance this image prompt: ${basePrompt}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 200,
    },
    {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const enhancedPrompt = response.data.choices[0].message.content.trim();
  return enhancedPrompt;
}

/**
 * Generates an image using DALL-E
 */
export async function generateImage(prompt: string): Promise<string> {
  const response = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-3',
      prompt: prompt,
      size: '1792x1024', // 16:9 ratio
      quality: 'standard',
      n: 1,
    },
    {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const imageUrl = response.data.data[0].url;
  return imageUrl;
}

/**
 * Downloads an image from a URL
 */
export async function downloadImage(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}


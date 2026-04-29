import axios from 'axios';
import { config } from '../config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { VisualStyle } from '../utils/validator';

// Resolve prompt path - works in both dev and compiled dist
const IMAGE_PROMPT_PATH = join(process.cwd(), 'prompts', 'image.prompt.txt');

/**
 * Generates an enhanced image prompt for DALL-E or similar
 */
export async function generateImagePrompt(
  basePrompt: string,
  visualStyle: VisualStyle
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
          content: `VISUAL_STYLE: ${visualStyle}\n\nEnhance this base hero image scene description into a final image prompt. Preserve the subject, setting, and composition from the base prompt. Apply the VISUAL_STYLE.\n\nBASE_PROMPT: ${basePrompt}`,
        },
      ],
      temperature: 0.8,
      top_p: 0.9,
      presence_penalty: 0.8,
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
 * Generates an image using DALL·E 2 (1024×1024; all pipeline heroes use this path).
 */
export async function generateImage(prompt: string): Promise<string> {
  const response = await axios.post(
    'https://api.openai.com/v1/images/generations',
    {
      model: 'dall-e-2',
      prompt: prompt,
      size: '1024x1024',
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


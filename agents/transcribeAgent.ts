import axios from 'axios';
import FormData from 'form-data';

import { config } from '../config';

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Transcribes audio using OpenAI Whisper (same API key as chat).
 * Telegram voice notes are typically OGG Opus; Whisper accepts common formats.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg'
): Promise<string> {
  const form = new FormData();
  form.append('file', audioBuffer, { filename });
  form.append('model', 'whisper-1');

  const response = await axios.post<{ text: string }>(TRANSCRIPTION_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const text = response.data?.text?.trim() ?? '';
  return text;
}

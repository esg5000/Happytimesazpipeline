import axios from 'axios';
import FormData from 'form-data';

import { config } from '../config';
import { transcribeAudioGemini, withGeminiFallback } from './geminiAgent';

const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Best-effort audio mime type from filename extension, for the Gemini fallback's inlineData part. */
function mimeTypeForAudioFilename(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'webm':
      return 'audio/webm';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'mp4':
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    default:
      // Telegram voice notes (the most common untagged case) are OGG Opus.
      return 'audio/ogg';
  }
}

/**
 * Transcribes audio using OpenAI Whisper (same API key as chat), falling back to Gemini's
 * multimodal audio transcription on a fallback-worthy OpenAI failure (quota, 5xx, timeout/network).
 * Telegram voice notes are typically OGG Opus; Whisper accepts common formats.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'voice.ogg'
): Promise<string> {
  const mimeType = mimeTypeForAudioFilename(filename);

  return withGeminiFallback(
    'transcribeAgent.transcribeAudio',
    async () => {
      const form = new FormData();
      form.append('file', audioBuffer, { filename });
      form.append('model', 'whisper-1');

      try {
        const response = await axios.post<{ text?: string }>(TRANSCRIPTION_URL, form, {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${config.openai.apiKey}`,
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        return response.data?.text?.trim() ?? '';
      } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response?.data) {
          const d = err.response.data as { error?: { message?: string } };
          const openaiMsg = d?.error?.message;
          if (openaiMsg) {
            // Keep "HTTP <status>" in the message so isFallbackWorthyError's status-code
            // regex still recognizes 429/5xx after this rethrow (it can no longer read
            // err.response directly once re-wrapped as a plain Error).
            throw new Error(`Whisper API HTTP ${err.response.status}: ${openaiMsg}`);
          }
        }
        throw err;
      }
    },
    () => transcribeAudioGemini(audioBuffer, mimeType)
  );
}

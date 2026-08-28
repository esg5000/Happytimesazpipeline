import axios from 'axios';
import { config } from '../config';

const GEMINI_GENERATE_CONTENT_URL = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * Text-generation fallback primitive for OpenAI Chat Completions / Responses API call sites.
 * Mirrors each site's existing system+user prompt shape and hands back raw text — callers reuse
 * their own existing fence-strip/JSON.parse/schema-validate logic unchanged, same as the OpenAI path.
 */
export async function geminiChatJson(
  systemPrompt: string,
  userPrompt: string,
  opts?: { temperature?: number; maxOutputTokens?: number }
): Promise<string> {
  const key = config.gemini.apiKey;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // gemini-3.x models spend `maxOutputTokens` on internal "thinking" tokens before the
      // answer — confirmed live: a low cap (e.g. 50) burns the whole budget on thinking and
      // returns empty text (finishReason MAX_TOKENS, HTTP 200, no candidates[0].content.parts).
      // thinkingBudget: 0 is rejected (HTTP 400) on this model; a small fixed budget avoids both
      // the empty-text bug and the larger, unpredictable token cost of the default dynamic (-1)
      // thinking budget.
      thinkingConfig: { thinkingBudget: 128 },
      ...(typeof opts?.temperature === 'number' ? { temperature: opts.temperature } : {}),
      ...(typeof opts?.maxOutputTokens === 'number' ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };
  if (systemPrompt.trim()) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const res = await axios.post(GEMINI_GENERATE_CONTENT_URL(config.gemini.model), body, {
    headers: {
      'x-goog-api-key': key,
      'Content-Type': 'application/json',
    },
    timeout: 180_000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    const data = res.data;
    const msg =
      typeof data === 'object' && data && 'error' in (data as object)
        ? JSON.stringify((data as { error?: unknown }).error)
        : res.statusText || String(res.status);
    throw new Error(`Gemini generateContent HTTP ${res.status}: ${msg}`);
  }

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Gemini generateContent returned no text');
  }
  return text;
}

/**
 * Image-generation fallback for agents/imageAgent.ts's generateImage / src/agents/imageSourcing.ts's
 * generateImageWithGptImage1. Uses 'gemini-3.1-flash-lite-image' — the flagship
 * 'gemini-3.1-flash-image' timed out 5/5 in live testing (same capacity crunch as the flagship
 * text models), while the lite variant got 12/15 (80%, all remaining failures were timeouts, not
 * 503s — image generation is just slower/heavier than text, not capacity-shed). A longer timeout
 * here reduces those spurious timeout failures. Returns null on any failure (never throws),
 * matching generateImage's existing contract — callers already handle a null hero image.
 */
export async function generateImageGemini(prompt: string): Promise<Buffer | null> {
  try {
    const key = config.gemini.apiKey;
    if (!key) return null;

    const res = await axios.post(
      GEMINI_GENERATE_CONTENT_URL('gemini-3.1-flash-lite-image'),
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      },
      {
        headers: {
          'x-goog-api-key': key,
          'Content-Type': 'application/json',
        },
        timeout: 90_000,
        validateStatus: () => true,
      }
    );

    if (res.status >= 400) {
      const data = res.data;
      const msg =
        typeof data === 'object' && data && 'error' in (data as object)
          ? JSON.stringify((data as { error?: unknown }).error)
          : res.statusText || String(res.status);
      console.warn(`[geminiAgent] generateImageGemini failed: HTTP ${res.status} — ${msg}`);
      return null;
    }

    const parts = res.data?.candidates?.[0]?.content?.parts;
    const imgPart = Array.isArray(parts) ? parts.find((p: any) => p?.inlineData?.data) : undefined;
    const b64 = imgPart?.inlineData?.data;
    if (typeof b64 !== 'string' || !b64) {
      console.warn('[geminiAgent] generateImageGemini: no image data in response');
      return null;
    }
    return Buffer.from(b64, 'base64');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[geminiAgent] generateImageGemini threw:', msg);
    return null;
  }
}

/**
 * True for errors worth retrying on Gemini: network/timeout errors and HTTP 429/5xx. False for
 * other 4xx — those are real request bugs (bad prompt/schema), not transient outages, and
 * falling back would just mask them.
 *
 * Handles both error shapes in this codebase: real AxiosErrors (sites that let axios throw on
 * non-2xx) and the plain `Error('... HTTP {status}: ...')` some sites throw manually after using
 * `validateStatus: () => true`.
 */
export function isFallbackWorthyError(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    if (!err.response) return true; // network/timeout — no response received
    const status = err.response.status;
    return status === 429 || (status >= 500 && status <= 599);
  }
  if (err instanceof Error) {
    const m = err.message.match(/HTTP (\d{3})/);
    if (m) {
      const status = parseInt(m[1]!, 10);
      return status === 429 || (status >= 500 && status <= 599);
    }
  }
  return false;
}

/**
 * Tries `openAiCall()`; on a fallback-worthy error, retries once via `geminiCall()`. If Gemini
 * also fails (or `GEMINI_API_KEY` isn't set), rethrows the ORIGINAL OpenAI error, not Gemini's —
 * so existing error messages/behavior downstream of each call site are unchanged on total failure.
 */
export async function withGeminiFallback<T>(
  label: string,
  openAiCall: () => Promise<T>,
  geminiCall: () => Promise<T>
): Promise<T> {
  try {
    return await openAiCall();
  } catch (err: unknown) {
    if (!isFallbackWorthyError(err)) throw err;
    if (!config.gemini.apiKey) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[gemini-fallback] ${label}: OpenAI call failed (${msg}); retrying via Gemini…`);
    try {
      return await geminiCall();
    } catch (geminiErr: unknown) {
      const geminiMsg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
      console.warn(`[gemini-fallback] ${label}: Gemini fallback also failed (${geminiMsg}); surfacing original OpenAI error.`);
      throw err;
    }
  }
}

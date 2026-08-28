/**
 * ONE-OFF PROBE — NOT wired into any pipeline stage. Tests several Gemini model names directly
 * against generateContent (plain JSON-mode call, no tools) to see which ones are currently
 * healthy vs. 503'ing, informing which model GEMINI_MODEL should point at for the fallback work
 * in agents/geminiAgent.ts.
 *
 * Run: npx ts-node scripts/probe-gemini-model-versions.ts
 */
import axios from 'axios';
import { config } from '../config';

const MODELS_TO_TEST = [
  'gemini-2.5-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-flash-latest',
];

const ATTEMPTS_PER_MODEL = 3;

async function testModel(model: string): Promise<{ model: string; ok: number; fail: number; errors: string[] }> {
  const key = config.gemini.apiKey;
  let ok = 0;
  let fail = 0;
  const errors: string[] = [];

  for (let i = 0; i < ATTEMPTS_PER_MODEL; i++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: 'Return this exact JSON: {"ping":"pong"}' }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 50 },
        },
        {
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          timeout: 30_000,
          validateStatus: () => true,
        }
      );
      if (res.status >= 400) {
        fail++;
        const msg =
          typeof res.data === 'object' && res.data && 'error' in res.data
            ? JSON.stringify((res.data as { error?: unknown }).error).slice(0, 150)
            : res.statusText;
        errors.push(`HTTP ${res.status}: ${msg}`);
      } else {
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === 'string' && text.trim()) {
          ok++;
        } else {
          fail++;
          errors.push(`HTTP ${res.status} but no text in response`);
        }
      }
    } catch (err: unknown) {
      fail++;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { model, ok, fail, errors };
}

async function main() {
  console.log(`[probe] Testing ${MODELS_TO_TEST.length} Gemini models, ${ATTEMPTS_PER_MODEL} attempts each (plain JSON-mode generateContent, no tools)\n`);

  for (const model of MODELS_TO_TEST) {
    const r = await testModel(model);
    console.log(`[probe] ${model}: ${r.ok}/${ATTEMPTS_PER_MODEL} OK, ${r.fail}/${ATTEMPTS_PER_MODEL} FAIL`);
    if (r.errors.length > 0) {
      for (const e of [...new Set(r.errors)]) {
        console.log(`[probe]     - ${e}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('[probe] FATAL', err);
  process.exit(1);
});

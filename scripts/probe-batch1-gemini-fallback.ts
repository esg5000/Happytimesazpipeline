/**
 * ONE-OFF VERIFICATION SCRIPT for Batch 1 of the Gemini-fallback work — NOT wired into any
 * pipeline stage. Installs an axios request interceptor that turns every request to
 * api.openai.com into a simulated network failure (no `err.response`, matching a real OpenAI
 * outage/timeout) — the same shape `isFallbackWorthyError()` treats as fallback-worthy. This is
 * a more faithful test than an invalid API key: an invalid key gets a real HTTP 401 from OpenAI,
 * which is correctly NOT fallback-worthy by design (a bad key is a bug, not an outage), so it
 * would never actually reach Gemini. Simulating a network-level failure exercises the real
 * "OpenAI is down" path end-to-end, then confirms each function still returns a schema-valid
 * result sourced from Gemini.
 *
 * Only exported, directly-callable Batch 1 functions are probed here (ingestToTopic,
 * generateTopics, writeArticle). agents/newsApiSync.ts's openAiJson and
 * src/agents/researchAgent.ts's extractSearchQueries/factCheckArticleMarkdownAnthropic share the
 * exact same withGeminiFallback/geminiChatJson primitives already exercised below, but are
 * module-private (not exported) and not independently network-callable without a full Google
 * News/Dig & Write run — confirmed via `tsc --noEmit` instead (clean, no errors).
 *
 * Run: npx ts-node scripts/probe-batch1-gemini-fallback.ts
 */
import axios from 'axios';
import { config } from '../config';
import { validateTopic, validateArticle } from '../utils/validator';

function installOpenAiOutageSimulator() {
  axios.interceptors.request.use((reqConfig) => {
    const url = reqConfig.url || '';
    if (url.includes('api.openai.com')) {
      // Mimic a real axios network-error shape (isAxiosError: true, no `.response`) so
      // isFallbackWorthyError() classifies this exactly like a real OpenAI outage/timeout.
      const err = new Error('simulated network failure: OpenAI unreachable (probe)') as Error & {
        isAxiosError: boolean;
        response: undefined;
      };
      err.isAxiosError = true;
      err.response = undefined;
      return Promise.reject(err);
    }
    return reqConfig;
  });
}

async function main() {
  const hasOpenAiKey = Boolean(config.openai.apiKey);
  const hasGeminiKey = Boolean(config.gemini.apiKey);
  console.log(`[probe] OPENAI_API_KEY present: ${hasOpenAiKey}`);
  console.log(`[probe] GEMINI_API_KEY present: ${hasGeminiKey}`);
  if (!hasGeminiKey) {
    console.error('[probe] GEMINI_API_KEY not set — cannot verify fallback. Aborting.');
    process.exit(1);
  }

  installOpenAiOutageSimulator();
  console.log('[probe] Installed axios interceptor: all api.openai.com requests now fail with a simulated network error.\n');

  const results: { label: string; ok: boolean; detail: string }[] = [];

  console.log('[probe] === agents/ingestAgent.ts::ingestToTopic ===');
  try {
    const { ingestToTopic } = await import('../agents/ingestAgent');
    const topic = await ingestToTopic({
      notes:
        'A new taco truck called Cactus Bites just opened in downtown Tempe near ASU, serving Sonoran-style street tacos with a rotating salsa bar. Owner is a local chef named Maria Reyes.',
    });
    const v = validateTopic(topic);
    console.log(`[probe]   title="${topic.title}" section=${topic.section}`);
    console.log(`[probe]   validateTopic: ${v.success ? 'PASS' : 'FAIL — ' + v.errors?.join(', ')}`);
    results.push({ label: 'ingestToTopic', ok: v.success === true, detail: topic.title });
  } catch (err) {
    console.error('[probe]   FAILED (both OpenAI-sim and Gemini failed, or a bug):', err);
    results.push({ label: 'ingestToTopic', ok: false, detail: String(err) });
  }

  console.log('\n[probe] === agents/topicAgent.ts::generateSingleTopic (via generateTopics) ===');
  try {
    const { generateTopics } = await import('../agents/topicAgent');
    const topics = await generateTopics(1);
    const t = topics[0]!;
    const v = validateTopic(t);
    console.log(`[probe]   title="${t.title}" section=${t.section}`);
    console.log(`[probe]   validateTopic: ${v.success ? 'PASS' : 'FAIL — ' + v.errors?.join(', ')}`);
    results.push({ label: 'generateTopics', ok: v.success === true, detail: t.title });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'generateTopics', ok: false, detail: String(err) });
  }

  console.log('\n[probe] === agents/writerAgent.ts::writeArticle ===');
  try {
    const { writeArticle } = await import('../agents/writerAgent');
    const article = await writeArticle({
      title: 'Cactus Bites Taco Truck Opens Near ASU',
      section: 'food',
      description: 'A new Sonoran-style taco truck opens near ASU in Tempe.',
      keywords: ['tacos', 'tempe', 'asu', 'food truck'],
    } as any);
    const v = validateArticle(article);
    console.log(`[probe]   title="${article.title}" slug=${article.slug}`);
    console.log(`[probe]   validateArticle: ${v.success ? 'PASS' : 'FAIL — ' + v.errors?.join(', ')}`);
    results.push({ label: 'writeArticle', ok: v.success === true, detail: article.title });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'writeArticle', ok: false, detail: String(err) });
  }

  console.log('\n########## PROBE SUMMARY ##########');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}: ${r.detail}`);
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '\nAll probed Batch 1 sites fell through to Gemini and produced schema-valid output.' : '\nAt least one site failed — see above.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('[probe] FATAL', err);
  process.exit(1);
});

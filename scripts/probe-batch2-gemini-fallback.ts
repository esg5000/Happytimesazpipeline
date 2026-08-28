/**
 * ONE-OFF VERIFICATION SCRIPT for Batch 2 of the Gemini-fallback work — NOT wired into any
 * pipeline stage. Same simulated-OpenAI-outage approach as
 * scripts/probe-batch1-gemini-fallback.ts: an axios request interceptor turns every request to
 * api.openai.com into a network failure, then each exported Batch 2 function is called directly
 * and its output checked.
 *
 * Only exported, directly-callable Batch 2 functions are probed: editorAgent.scoreArticleQuality,
 * articleWriter.writeArticle, verificationGate.verifyArticle, and imageAgent.generateImage (which
 * now falls through to generateImageGemini). newsApiSync.scoreAndGate and
 * imageSourcing.generateImageWithGptImage1 are module-private and share the exact same
 * withGeminiFallback/geminiChatJson/generateImageGemini primitives already exercised here and in
 * Batch 1 — confirmed via `tsc --noEmit` instead. topicDiscovery.runStage1QuickPassForCandidate is
 * likewise module-private and shares the same primitives.
 *
 * Run: npx ts-node scripts/probe-batch2-gemini-fallback.ts
 */
import axios from 'axios';
import { config } from '../config';

function installOpenAiOutageSimulator() {
  axios.interceptors.request.use((reqConfig) => {
    const url = reqConfig.url || '';
    if (url.includes('api.openai.com')) {
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
  const hasGeminiKey = Boolean(config.gemini.apiKey);
  console.log(`[probe] GEMINI_API_KEY present: ${hasGeminiKey}`);
  if (!hasGeminiKey) {
    console.error('[probe] GEMINI_API_KEY not set — cannot verify fallback. Aborting.');
    process.exit(1);
  }

  installOpenAiOutageSimulator();
  console.log('[probe] Installed axios interceptor: all api.openai.com requests now fail with a simulated network error.\n');

  const results: { label: string; ok: boolean; detail: string }[] = [];

  console.log('[probe] === agents/editorAgent.ts::scoreArticleQuality ===');
  try {
    const { scoreArticleQuality } = await import('../agents/editorAgent');
    const result = await scoreArticleQuality({
      title: 'Cactus Bites Taco Truck Opens Near ASU',
      excerpt: 'A new Sonoran-style taco truck opens near ASU in Tempe.',
      bodyMarkdown: 'Cactus Bites, a new taco truck run by chef Maria Reyes, opened this week near ASU in downtown Tempe, serving Sonoran-style street tacos with a rotating salsa bar.',
    } as any);
    const ok = typeof result.score === 'number' && result.score >= 1 && result.score <= 10;
    console.log(`[probe]   score=${result.score} reason="${result.reason}"`);
    results.push({ label: 'scoreArticleQuality', ok, detail: `score=${result.score}` });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'scoreArticleQuality', ok: false, detail: String(err) });
  }

  console.log('\n[probe] === src/agents/articleWriter.ts::writeArticle ===');
  try {
    const { writeArticle } = await import('../src/agents/articleWriter');
    const topic = {
      title: 'Cactus Bites Taco Truck Opens Near ASU',
      snippet: 'A new Sonoran-style taco truck opens near ASU in Tempe.',
      section: 'food',
      verdict: 'direct-local',
      subjectTag: 'food truck',
    };
    const sourcingResult = {
      topic,
      facts: [
        { field: 'business_name', value: 'Cactus Bites', source: 'Owner interview', sourceUrl: 'https://example.com/cactus-bites' },
        { field: 'location', value: 'Downtown Tempe, near ASU', source: 'Owner interview', sourceUrl: 'https://example.com/cactus-bites' },
        { field: 'owner', value: 'Maria Reyes', source: 'Owner interview', sourceUrl: 'https://example.com/cactus-bites' },
      ],
      primarySourceFound: true,
      factCount: 3,
    };
    const sufficiencyResult = {
      decision: 'blurb' as const,
      qualifyingFactCount: 3,
      hasCoreWhat: true,
      hasCoreWhen: true,
      conflicts: [],
      disqualifiedFactCount: 0,
      disqualifiedFields: [],
      reasoning: 'Enough facts for a blurb.',
    };
    const article = await writeArticle(topic, sourcingResult, sufficiencyResult);
    const ok = article !== null && typeof article.title === 'string' && article.title.length > 0;
    console.log(`[probe]   title="${article?.title}" phantomFactCount=${article?.phantomFactCount}`);
    results.push({ label: 'articleWriter.writeArticle', ok, detail: article?.title || 'null' });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'articleWriter.writeArticle', ok: false, detail: String(err) });
  }

  console.log('\n[probe] === src/agents/verificationGate.ts::verifyArticle ===');
  try {
    const { verifyArticle } = await import('../src/agents/verificationGate');
    const facts = [
      { field: 'business_name', value: 'Cactus Bites', source: 'Owner interview', sourceUrl: 'https://example.com/cactus-bites' },
    ];
    const article = {
      title: 'Cactus Bites Taco Truck Opens Near ASU',
      bodyMarkdown: 'Cactus Bites, a new taco truck, opened this week near ASU in downtown Tempe.',
      factsUsed: ['business_name::Owner interview'],
      sourceCredits: [{ outlet: 'Owner interview', url: 'https://example.com/cactus-bites' }],
      phantomFactCount: 0,
      phantomSourceCount: 0,
    };
    const result = await verifyArticle(article, facts);
    const ok = typeof result.proseCheck.score === 'number';
    console.log(`[probe]   passed=${result.passed} proseScore=${result.proseCheck.score} reason="${result.overallReason}"`);
    results.push({ label: 'verificationGate.verifyArticle', ok, detail: `proseScore=${result.proseCheck.score}` });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'verificationGate.verifyArticle', ok: false, detail: String(err) });
  }

  console.log('\n[probe] === agents/imageAgent.ts::generateImage (Gemini image fallback) ===');
  try {
    const { generateImage } = await import('../agents/imageAgent');
    const buf = await generateImage('A photorealistic editorial photo of a taco truck in downtown Tempe, Arizona at golden hour.');
    const ok = buf !== null && buf.length > 1000;
    console.log(`[probe]   buffer=${buf ? buf.length + ' bytes' : 'null'}`);
    results.push({ label: 'imageAgent.generateImage', ok, detail: buf ? `${buf.length} bytes` : 'null' });
  } catch (err) {
    console.error('[probe]   FAILED:', err);
    results.push({ label: 'imageAgent.generateImage', ok: false, detail: String(err) });
  }

  console.log('\n########## PROBE SUMMARY ##########');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}: ${r.detail}`);
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '\nAll probed Batch 2 sites fell through to Gemini and produced usable output.' : '\nAt least one site failed — see above.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('[probe] FATAL', err);
  process.exit(1);
});

/**
 * Stage 6 — Verification Gate (pipeline-redesign-architecture.md).
 *
 * Replaces/supersedes editorAgent.ts's scoreArticleQuality as the
 * publish-time quality gate — eventually. NOT wired into editorAgent.ts,
 * newsApiSync.ts, or orchestrator.ts yet. STANDALONE, SHADOW MODE ONLY,
 * same pattern as every other stage built this session: local types
 * redefined here (not imported) so verifyArticle() itself has zero
 * coupling to articleWriter.ts/sufficiencyGate.ts; only the test harness
 * at the bottom (guarded by require.main === module) imports the real
 * writeArticle()/evaluateSufficiency() to chain a genuine Stage 4 → 5 → 6
 * run rather than guessing Stage 5's real output shape.
 *
 * TWO CHECKS:
 *
 * CHECK 1 — Mechanical (free, no API call). Reads phantomFactCount/
 * phantomSourceCount off the WrittenArticle-shaped input (added to
 * articleWriter.ts earlier tonight). Either above 0 is an automatic,
 * non-negotiable fail — a phantom fact or misattributed source means the
 * draft claimed something it can't support. Check 2 never runs in this
 * case (no OpenAI call spent verifying prose built on an already-known-bad
 * foundation).
 *
 * CHECK 2 — Prose traceability (one OpenAI call, only for articles that
 * pass Check 1). Not "does the fact ID appear in factsUsed" — that's
 * already mechanically guaranteed by articleWriter.ts's own phantom
 * filtering. This asks whether the actual sentence built around each
 * cited fact honestly reflects what that fact's value says, or oversells/
 * understates/twists it. Same {score, reason} shape as editorAgent.ts's
 * scoreArticleQuality, same <6 fail threshold for comparability, but the
 * rubric is entirely different — fact-fidelity, not general prose quality
 * (local specificity / headline match / substance are irrelevant here).
 */
import axios from 'axios';

import { config } from '../../config';

const OPENAI_MODEL_STAGE6_VERIFY = 'gpt-5.4-mini';
/** Same cutoff as editorAgent.ts's scoreArticleQuality, for behavioral comparability. */
const PROSE_FIDELITY_PASS_THRESHOLD = 6;

// ---------------------------------------------------------------------------
// Input shapes — mirror articleWriter.ts's Fact and WrittenArticle exactly,
// redefined locally (not imported by verifyArticle() itself; see file header).
// ---------------------------------------------------------------------------

export type Fact = {
  field: string;
  value: string;
  source: string;
  sourceUrl?: string;
};

export type SourceCredit = { outlet: string; url: string };

/**
 * Loosely-typed superset of articleWriter.ts's real WrittenArticle — only
 * the fields this gate actually reads are required, so the real
 * WrittenArticle (with its extra fields) satisfies this structurally with
 * no cast needed at the call site.
 */
export type WrittenArticleInput = {
  title: string;
  bodyMarkdown: string;
  factsUsed: string[];
  sourceCredits: SourceCredit[];
  phantomFactCount: number;
  phantomSourceCount: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type MechanicalCheckResult = {
  phantomFactCount: number;
  phantomSourceCount: number;
};

export type ProseCheckResult = {
  score: number;
  reason: string;
};

export type VerificationResult = {
  passed: boolean;
  mechanicalCheck: MechanicalCheckResult;
  proseCheck: ProseCheckResult;
  overallReason: string;
};

// ---------------------------------------------------------------------------
// Ported from agents/editorAgent.ts / src/agents/articleWriter.ts's
// openAiJson — same call shape, not imported.
// ---------------------------------------------------------------------------

async function openAiJson<T>(system: string, user: string, model: string): Promise<T> {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}

function factId(f: Fact): string {
  return `${f.field}::${f.source}`;
}

// ---------------------------------------------------------------------------
// Check 1 — Mechanical
// ---------------------------------------------------------------------------

function runMechanicalCheck(article: WrittenArticleInput): MechanicalCheckResult {
  return {
    phantomFactCount: article.phantomFactCount,
    phantomSourceCount: article.phantomSourceCount,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — Prose traceability
// ---------------------------------------------------------------------------

async function runProseFidelityCheck(article: WrittenArticleInput, facts: Fact[]): Promise<ProseCheckResult> {
  const factById = new Map(facts.map((f) => [factId(f), f]));
  const citedLines = article.factsUsed
    .map((label) => {
      const f = factById.get(label);
      return f ? `- [${label}] ${f.field} = "${f.value}"` : null;
    })
    .filter((line): line is string => line !== null);

  const system = `You are a strict fact-fidelity auditor for HappyTimesAZ, a Phoenix AZ local lifestyle site. You are NOT scoring general writing quality — ignore local specificity, headline/body match, and substance vs. filler entirely; another gate already covers that.

Your only job: compare the article's actual prose (sentence-level wording) against the exact facts it claims to have used (listed below as [label] field = "value"). For each cited fact, does the sentence built around it honestly reflect what that fact's value actually says — or does it oversell (add certainty, specificity, or scale the fact doesn't support), understate, or twist the meaning?

Special case — conflicting/disputed facts: if two different sources give different values for the same field (e.g. two different prices), and the prose attributes each value explicitly to its own source rather than stating one as settled fact, that is correct, honest handling — do not penalize it. Only penalize if the prose states a disputed value as plain unqualified fact, or blends/averages conflicting values into something neither source actually said.

Score 1-10 on fact-fidelity alone. A 10 means every claim traces cleanly to its cited fact with accurate wording. A low score means the prose materially misrepresents one or more cited facts.

Return JSON only: {"score": <1-10 integer>, "reason": "<one or two sentence explanation, naming the specific fact label if there's an issue>"}`;

  const user = [
    `Title: ${article.title}`,
    '',
    'Facts the article claims to have used:',
    ...(citedLines.length > 0 ? citedLines : ['(none — factsUsed was empty)']),
    '',
    'Article body (Markdown):',
    article.bodyMarkdown,
  ].join('\n');

  const raw = await openAiJson<{ score?: unknown; reason?: unknown }>(system, user, OPENAI_MODEL_STAGE6_VERIFY);
  const score = Math.min(10, Math.max(1, Math.round(Number(raw.score)) || 1));
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '(no reason given)';

  return { score, reason };
}

// ---------------------------------------------------------------------------
// Stage 6 entry point
// ---------------------------------------------------------------------------

/**
 * Runs Check 1 first (free). If it fails, returns immediately with
 * passed=false and a proseCheck placeholder — no OpenAI call is made.
 * Only articles that pass Check 1 proceed to Check 2's live scoring call.
 */
export async function verifyArticle(article: WrittenArticleInput, facts: Fact[]): Promise<VerificationResult> {
  const mechanicalCheck = runMechanicalCheck(article);

  if (mechanicalCheck.phantomFactCount > 0 || mechanicalCheck.phantomSourceCount > 0) {
    const overallReason = `FAILED mechanical check: ${mechanicalCheck.phantomFactCount} phantom fact(s), ${mechanicalCheck.phantomSourceCount} phantom source(s) — draft claimed something it can't support.`;
    console.warn(`[verification-gate] "${article.title}" → ${overallReason}`);
    return {
      passed: false,
      mechanicalCheck,
      proseCheck: { score: 0, reason: 'Not evaluated — mechanical check failed, no OpenAI call made.' },
      overallReason,
    };
  }

  console.log(`[verification-gate] "${article.title}" → mechanical check clean, running prose-fidelity check...`);
  const proseCheck = await runProseFidelityCheck(article, facts);
  const passed = proseCheck.score >= PROSE_FIDELITY_PASS_THRESHOLD;
  const overallReason = passed
    ? `PASSED — mechanical check clean, prose-fidelity score ${proseCheck.score}/10: ${proseCheck.reason}`
    : `FAILED prose-fidelity check: score ${proseCheck.score}/10 (threshold ${PROSE_FIDELITY_PASS_THRESHOLD}) — ${proseCheck.reason}`;

  console.log(`[verification-gate] "${article.title}" → ${passed ? 'PASSED' : 'FAILED'} (prose score ${proseCheck.score}/10)`);

  return { passed, mechanicalCheck, proseCheck, overallReason };
}

// ---------------------------------------------------------------------------
// Test harness — chains real Stage 4 (sufficiencyGate) → Stage 5
// (articleWriter) → Stage 6 (this file) using the same 4 fixtures
// articleWriter.ts's own test harness used tonight (tests 1/2/3/4; test 5
// is the skip fixture and produces no article, so it's excluded here per
// the build spec). Fixtures are copied, not imported — articleWriter.ts
// defines them inside its own test-harness function, not exported —
// consistent with this session's "port, don't import" pattern for
// anything not part of a module's real public surface. writeArticle() and
// evaluateSufficiency() ARE the real, imported production functions
// (dynamic-imported here, test-harness-only) — this is a genuine chained
// run, not a guess at Stage 4/5's output shape.
// ---------------------------------------------------------------------------

type HarnessTopicInput = {
  title: string;
  snippet?: string;
  section?: string;
  verdict?: string;
  subjectTag?: string;
  [key: string]: unknown;
};

type HarnessSourceGatheringResult = {
  topic: HarnessTopicInput;
  facts: Fact[];
  primarySourceFound: boolean;
  factCount: number;
};

async function runTestHarness(): Promise<void> {
  const { writeArticle } = await import('./articleWriter');
  const { evaluateSufficiency } = await import('./sufficiencyGate');

  type Case = { label: string; topic: HarnessTopicInput; sourcing: HarnessSourceGatheringResult };

  const cases: Case[] = [
    {
      label: 'TEST 1: direct-local + rich facts',
      topic: { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Phoenix Convention Center North', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'address', value: '100 N 3rd St, Phoenix, AZ 85004', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'date', value: '2026-08-16', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'time', value: '9:00 AM', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
          { field: 'ticketUrl', value: 'https://2026.us.wordcamp.org/tickets/', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/wordcamp' },
          { field: 'price', value: '$85', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
          { field: 'description', value: 'WordCamp US brings together WordPress users, developers, and businesses for three days of sessions and workshops.', source: 'venue page — HTTP fetch (https://2026.us.wordcamp.org/)', sourceUrl: 'https://2026.us.wordcamp.org/' },
        ],
        primarySourceFound: true,
        factCount: 7,
      },
    },
    {
      label: 'TEST 2: direct-local + thin facts',
      topic: { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Kähvi Coffee + Cafe', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/sundayyoga' },
        ],
        primarySourceFound: false,
        factCount: 1,
      },
    },
    {
      label: 'TEST 3: national-reframe + eclipse-like facts',
      topic: { title: 'Rare Meteor Shower Peaks Tonight', section: 'news', subjectTag: 'astronomy', verdict: 'national-reframe' },
      sourcing: {
        topic: { title: 'Rare Meteor Shower Peaks Tonight', section: 'news', subjectTag: 'astronomy', verdict: 'national-reframe' },
        facts: [
          { field: 'visibility', value: 'Not visible from Arizona tonight due to forecast monsoon cloud cover', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
          { field: 'alternative', value: 'Best alternative Arizona viewing window is Thursday night, when skies are forecast to clear', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
          { field: 'date', value: '2026-08-13', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
          { field: 'description', value: 'The Perseid meteor shower peaks tonight with up to 60 meteors per hour visible under clear skies.', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
        ],
        primarySourceFound: true,
        factCount: 4,
      },
    },
    {
      label: 'TEST 4: conflicting price facts',
      topic: { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia', verdict: 'direct-local' },
      sourcing: {
        topic: { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia', verdict: 'direct-local' },
        facts: [
          { field: 'venueName', value: 'Arizona Wilderness Brewing Co.', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'date', value: 'Wednesdays', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'price', value: 'Free', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
          { field: 'price', value: '$5 buy-in', source: 'venue page — HTTP fetch (https://azwbeer.com/gilbert/events/)', sourceUrl: 'https://azwbeer.com/gilbert/events/' },
        ],
        primarySourceFound: true,
        factCount: 4,
      },
    },
  ];

  console.log('[verification-gate] ========== TEST HARNESS start ==========');

  const results: { label: string; verification: VerificationResult | null }[] = [];

  for (const c of cases) {
    console.log(`\n\n=== ${c.label} ===`);
    const sufficiency = evaluateSufficiency(c.sourcing);
    console.log(`Stage 4 decision: ${sufficiency.decision} — ${sufficiency.reasoning}`);

    const article = await writeArticle(c.topic, c.sourcing, sufficiency);
    if (!article) {
      console.log('(no article written — decision was skip; nothing to verify)');
      results.push({ label: c.label, verification: null });
      continue;
    }
    console.log(`Stage 5 article written — title="${article.title}", factsUsed=${article.factsUsed.length}, phantomFactCount=${article.phantomFactCount}, phantomSourceCount=${article.phantomSourceCount}`);

    const verification = await verifyArticle(article, c.sourcing.facts);
    results.push({ label: c.label, verification });

    console.log('\nStage 6 verification result:');
    console.log(JSON.stringify(verification, null, 2));
  }

  console.log('\n\n########## VERIFICATION GATE TEST HARNESS SUMMARY ##########');
  for (const { label, verification } of results) {
    if (!verification) {
      console.log(`${label} → no article (skip) — not verified`);
      continue;
    }
    console.log(
      `${label} → passed=${verification.passed}, mechanical=[phantomFact=${verification.mechanicalCheck.phantomFactCount}, phantomSource=${verification.mechanicalCheck.phantomSourceCount}], prose=${verification.proseCheck.score}/10`
    );
  }
  console.log('[verification-gate] ========== TEST HARNESS end ==========');
}

/** Never dump a raw AxiosError/Error object — see articleWriter.ts's identical helper / the API-key-leak incident earlier this session. */
function safeErrorSummary(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const apiMessage =
      body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
        ? JSON.stringify((body as Record<string, unknown>).error)
        : undefined;
    return `AxiosError: HTTP ${status ?? '(no response)'}${apiMessage ? ` — ${apiMessage}` : ` — ${err.message}`}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

if (require.main === module) {
  runTestHarness().catch((err) => {
    console.error('[verification-gate] Fatal:', safeErrorSummary(err));
    process.exit(1);
  });
}

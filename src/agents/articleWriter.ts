/**
 * Stage 5 — Format Decision & Draft (pipeline-redesign-architecture.md).
 *
 * STANDALONE. writeArticle() itself imports nothing from
 * topicDiscovery.ts, sourceGathering.ts, or sufficiencyGate.ts — its
 * input types are redefined locally to match those modules' real output
 * shapes, same decoupling pattern as every other module built this
 * session. The only cross-module import in this file is in the test
 * harness at the bottom (guarded by `require.main === module`), which
 * genuinely chains through sufficiencyGate.ts's real evaluateSufficiency()
 * — the build brief explicitly asks for the harness to chain
 * "sourceGathering-shaped facts → sufficiencyGate → articleWriter", so
 * that step calls the real function rather than guessing its output shape.
 *
 * SHADOW MODE ONLY. Not wired into Sanity, Stage 6 (doesn't exist yet),
 * or any publish flow. Live OpenAI calls are expected and fine (this
 * stage's whole job is generating text) — SerpAPI is never called
 * anywhere in this file.
 *
 * `openAiJson()` mirrors agents/newsApiSync.ts's helper of the same name
 * (same chat/completions call shape, same JSON-fence stripping) — ported,
 * not imported, per the build instructions.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';

import { config } from '../../config';
import { geminiChatJson, withGeminiFallback } from '../../agents/geminiAgent';

const STAGE5_PROMPT_PATH = join(process.cwd(), 'prompts', 'stage5Write.prompt.txt');
const OPENAI_MODEL_STAGE5_WRITE = 'gpt-5.4-mini';

const TITLE_MAX = 99;
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 155;

// ---------------------------------------------------------------------------
// Input shapes — mirror sourceGathering.ts's SourceGatheringResult and
// sufficiencyGate.ts's SufficiencyResult exactly, redefined locally (not
// imported by writeArticle() itself; see file header).
// ---------------------------------------------------------------------------

export type Fact = {
  field: string;
  value: string;
  source: string;
  sourceUrl?: string;
};

/**
 * The topic as produced by topicDiscovery.ts's Stage 1/2 (carries `verdict`,
 * which sourceGathering.ts/sufficiencyGate.ts don't need but Stage 5 does,
 * for reframe-block selection) — passed as its own argument rather than
 * read off sourcingResult.topic, since Stage 3/4 don't preserve it.
 */
export type TopicInput = {
  title: string;
  snippet?: string;
  section?: string;
  verdict?: string;
  subjectTag?: string;
  [key: string]: unknown;
};

export type SourceGatheringResult = {
  topic: TopicInput;
  facts: Fact[];
  primarySourceFound: boolean;
  factCount: number;
};

export type FormatDecision = 'full-article' | 'blurb' | 'skip';

export type FactConflict = {
  field: string;
  values: { value: string; source: string; sourceUrl?: string }[];
};

export type SufficiencyResult = {
  decision: FormatDecision;
  qualifyingFactCount: number;
  hasCoreWhat: boolean;
  hasCoreWhen: boolean;
  conflicts: FactConflict[];
  disqualifiedFactCount: number;
  disqualifiedFields: string[];
  reasoning: string;
};

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type SourceCredit = { outlet: string; url: string };

export type WrittenArticle = {
  title: string;
  slug: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  categories: string[];
  tags: string[];
  visualStyle: string;
  heroImagePrompt: string;
  bodyMarkdown: string;
  /** field::source labels, validated against the real input facts — see buildFactId. */
  factsUsed: string[];
  sourceCredits: SourceCredit[];
  /** Count of factsUsed entries the model returned that didn't match any real input fact — already stripped from factsUsed above; this is visibility only. */
  phantomFactCount: number;
  /** The actual dropped factsUsed labels (field::source format), for debugging/visibility. */
  phantomFacts: string[];
  /** Count of sourceCredits entries the model returned with an unrecognized/hallucinated url — already stripped from sourceCredits above; this is visibility only. */
  phantomSourceCount: number;
  /** The actual dropped sourceCredits entries, for debugging/visibility. */
  phantomSources: SourceCredit[];
};

// ---------------------------------------------------------------------------
// Composable prompt blocks — base lives in prompts/stage5Write.prompt.txt
// (read from disk), length/reframe blocks are TS constants appended at
// runtime, mirroring agents/newsApiSync.ts's base-prompt-file +
// slot-rules-string-append pattern (e.g. SLOT4_CANNABIS_AZ_REWRITE_RULES).
// ---------------------------------------------------------------------------

const FULL_LENGTH_BLOCK = `LENGTH & STRUCTURE — FULL ARTICLE:
Write 300-550 words. Structure this as a real narrative piece, not a bulleted fact-dump — weave the facts into flowing paragraphs the way a local writer would, using subheadings if that helps pacing. Don't pad with invented specifics to hit the word count — but DO use narrative framing, context, comparisons, and "why this matters" observations (the permitted color described in the base prompt's FACTS ONLY rule) to build the piece out to length.

The permission to write short applies ONLY when the input genuinely has few distinct facts — roughly under 4-5. If you have 5+ real facts, that's enough material to reach 300-550 words using the narrative techniques above; do not stop early just because you've restated each fact once and feel you've said everything "safe" to say. Running out of things to restate is not the same as running out of material — build around the facts you have. If you genuinely have fewer than 4-5 facts, write only what they support rather than stretching.`;

const BLURB_LENGTH_BLOCK = `LENGTH & STRUCTURE — BLURB:
Write 150-250 words. Tight and to the point: what's happening, and why a Valley reader should care. End with a clearly-labeled, prominent link-out to the original source — an actual pointer, not a passing mention (e.g. "Full details at [outlet name]"). Do not attempt to stretch thin material into a longer piece.`;

const REFRAME_BLOCK = `REFRAME — NATIONAL STORY WITH AN ARIZONA ANGLE:
This story is fundamentally national/global, not a Valley-native event. Structure the piece in two clear parts:
(1) Briefly state what the national/global story actually is — a sentence or two, don't over-invest word count here.
(2) The Arizona-specific angle — grounded strictly in the facts you were given, not assumed. If the fact set actually confirms something about Arizona (visibility, local relevance, a local business/venue tie-in), say so specifically. If the fact set does NOT answer whether or how this applies to Arizona, say that plainly instead of guessing either way — "We don't have confirmation of this for the Valley specifically" is a completely acceptable, honest sentence. Do not assume Arizona relevance just because the topic was flagged as locally interesting upstream.`;

// ---------------------------------------------------------------------------
// Ported from agents/newsApiSync.ts's openAiJson — same call shape, not imported.
// ---------------------------------------------------------------------------

async function openAiJson<T>(system: string, user: string, model: string): Promise<T> {
  const content = await withGeminiFallback(
    'articleWriter.openAiJson',
    async () => {
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
      const c = response.data.choices[0]?.message?.content;
      if (!c) throw new Error('OpenAI returned empty content');
      return c as string;
    },
    () => geminiChatJson(system, user, { temperature: 0.3 })
  );

  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateHardCap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd();
}

/** Deterministic, collision-resistant label for a fact — (field, source) is unique across every fixture/real checker output seen this session (a SerpAPI fact and a venue-page fact for the same field always have different `source` strings). */
function factId(f: Fact): string {
  return `${f.field}::${f.source}`;
}

function fallbackSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveOutletLabel(source: string, url: string): string {
  if (source.toLowerCase().includes('serpapi')) return 'Google Events listing';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
}

// ---------------------------------------------------------------------------
// Stage 5 entry point
// ---------------------------------------------------------------------------

/**
 * Selects the length block (from sufficiencyResult.decision) and whether to
 * layer on the reframe block (from topic.verdict), composes the system
 * prompt, calls OpenAI once, and validates the model's factsUsed/
 * sourceCredits against the real input facts before returning — phantom
 * fact labels are dropped and logged, never silently trusted.
 *
 * Returns null without calling OpenAI at all when sufficiencyResult.decision
 * is 'skip' — nothing to write.
 */
export async function writeArticle(
  topic: TopicInput,
  sourcingResult: SourceGatheringResult,
  sufficiencyResult: SufficiencyResult
): Promise<WrittenArticle | null> {
  if (sufficiencyResult.decision === 'skip') {
    console.log(`[article-writer] decision=skip for "${topic.title}" — returning without calling OpenAI.`);
    return null;
  }

  const lengthBlock = sufficiencyResult.decision === 'full-article' ? FULL_LENGTH_BLOCK : BLURB_LENGTH_BLOCK;
  const needsReframe = topic.verdict === 'national-reframe' || topic.verdict === 'national-verify-local';

  const systemBase = readFileSync(STAGE5_PROMPT_PATH, 'utf-8');
  const system =
    systemBase +
    `\n\n--- LENGTH & STRUCTURE ---\n${lengthBlock}` +
    (needsReframe ? `\n\n--- REFRAME ---\n${REFRAME_BLOCK}` : '');

  const factLines = sourcingResult.facts.map(
    (f) => `- [${factId(f)}] ${f.field} = "${f.value}"${f.sourceUrl ? ` (${f.sourceUrl})` : ''}`
  );
  const conflictLines = sufficiencyResult.conflicts.map(
    (c) => `- "${c.field}" is DISPUTED: ${c.values.map((v) => `"${v.value}" per ${v.source}`).join(' vs. ')}`
  );

  const user = [
    'TOPIC',
    `Title: ${topic.title}`,
    topic.snippet ? `Snippet: ${topic.snippet}` : '',
    '',
    'AVAILABLE FACTS (cite only these exact labels in factsUsed — do not invent new ones):',
    ...factLines,
    conflictLines.length > 0 ? `\nCONFLICTS (apply the CONFLICT HANDLING rule):\n${conflictLines.join('\n')}` : '',
    '',
    'Write the article now as the specified JSON.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  console.log(
    `[article-writer] Writing (${sufficiencyResult.decision}${needsReframe ? ' + reframe' : ''}) for "${topic.title}"...`
  );
  const raw = await openAiJson<Record<string, unknown>>(system, user, OPENAI_MODEL_STAGE5_WRITE);

  const title = truncateHardCap(String(raw.title ?? '').trim(), TITLE_MAX);
  const slug = String(raw.slug ?? '').trim() || fallbackSlug(title);
  const seoTitle = truncateHardCap(String(raw.seoTitle ?? '').trim(), SEO_TITLE_MAX);
  const seoDescription = truncateHardCap(String(raw.seoDescription ?? '').trim(), SEO_DESCRIPTION_MAX);

  // --- Validate factsUsed against the real input facts; drop + warn on phantoms ---
  const validFactIds = new Set(sourcingResult.facts.map(factId));
  const rawFactsUsed = Array.isArray(raw.factsUsed) ? raw.factsUsed : [];
  const factsUsed: string[] = [];
  const phantomFactsUsed: string[] = [];
  for (const entry of rawFactsUsed) {
    if (typeof entry !== 'string') continue;
    if (validFactIds.has(entry)) factsUsed.push(entry);
    else phantomFactsUsed.push(entry);
  }
  if (phantomFactsUsed.length > 0) {
    console.warn(
      `[article-writer] Dropped ${phantomFactsUsed.length} phantom factsUsed label(s) not present in input: ${phantomFactsUsed.join(', ')}`
    );
  }

  // --- Validate sourceCredits URLs against the real input facts; drop + warn on phantoms, fall back to a deterministic derivation if the model produced nothing usable ---
  const validSourceUrls = new Set(
    sourcingResult.facts.map((f) => f.sourceUrl).filter((u): u is string => Boolean(u))
  );
  const rawCredits = Array.isArray(raw.sourceCredits) ? raw.sourceCredits : [];
  let sourceCredits: SourceCredit[] = [];
  const phantomSources: SourceCredit[] = [];
  for (const entry of rawCredits) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).url === 'string' &&
      typeof (entry as Record<string, unknown>).outlet === 'string' &&
      validSourceUrls.has((entry as Record<string, unknown>).url as string)
    ) {
      sourceCredits.push({
        outlet: (entry as Record<string, unknown>).outlet as string,
        url: (entry as Record<string, unknown>).url as string,
      });
    } else {
      const outlet =
        entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).outlet === 'string'
          ? ((entry as Record<string, unknown>).outlet as string)
          : '(missing/invalid outlet)';
      const url =
        entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).url === 'string'
          ? ((entry as Record<string, unknown>).url as string)
          : '(missing/invalid url)';
      phantomSources.push({ outlet, url });
    }
  }
  const droppedCreditCount = phantomSources.length;
  if (droppedCreditCount > 0) {
    console.warn(`[article-writer] Dropped ${droppedCreditCount} sourceCredits entr(y/ies) with unrecognized/hallucinated URLs.`);
  }
  if (sourceCredits.length === 0 && validSourceUrls.size > 0) {
    const seen = new Set<string>();
    for (const f of sourcingResult.facts) {
      if (!f.sourceUrl || seen.has(f.sourceUrl)) continue;
      seen.add(f.sourceUrl);
      sourceCredits.push({ outlet: deriveOutletLabel(f.source, f.sourceUrl), url: f.sourceUrl });
    }
    console.log(`[article-writer] Model produced no valid sourceCredits; derived ${sourceCredits.length} deterministically from input facts as a fallback.`);
  }

  const article: WrittenArticle = {
    title,
    slug,
    excerpt: String(raw.excerpt ?? '').trim(),
    seoTitle,
    seoDescription,
    categories: Array.isArray(raw.categories) ? raw.categories.filter((c): c is string => typeof c === 'string') : [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    visualStyle: typeof raw.visualStyle === 'string' ? raw.visualStyle : 'editorial_realistic',
    heroImagePrompt: String(raw.heroImagePrompt ?? '').trim(),
    bodyMarkdown: String(raw.bodyMarkdown ?? '').trim(),
    factsUsed,
    sourceCredits,
    phantomFactCount: phantomFactsUsed.length,
    phantomFacts: phantomFactsUsed,
    phantomSourceCount: phantomSources.length,
    phantomSources,
  };

  console.log(`[article-writer] Done — title="${article.title}" (${article.title.length} chars), body=${article.bodyMarkdown.split(/\s+/).filter(Boolean).length} words`);
  return article;
}

// ---------------------------------------------------------------------------
// Test harness — chains real topicDiscovery-shaped topic → sourceGathering-
// shaped facts → sufficiencyGate.ts's real evaluateSufficiency() →
// writeArticle(). Only this section imports sufficiencyGate.ts (test-only,
// guarded by require.main); writeArticle() itself never does.
// ---------------------------------------------------------------------------

async function runTestHarness(): Promise<void> {
  // Imported here, not at module scope — keeps the import test-harness-only.
  const { evaluateSufficiency } = await import('./sufficiencyGate');

  function wordCount(md: string): number {
    return md.split(/\s+/).filter(Boolean).length;
  }

  function printArticle(article: WrittenArticle | null): void {
    if (!article) {
      console.log('(no article — skip)');
      return;
    }
    console.log(JSON.stringify(article, null, 2));
    console.log(`\nCHECKS: title length=${article.title.length} (<100: ${article.title.length < 100}), word count=${wordCount(article.bodyMarkdown)}`);
  }

  console.log('[article-writer] ========== TEST HARNESS start ==========');

  // --- 1. direct-local + rich facts (mirrors sufficiencyGate.ts's "Rich" fixture) ---
  console.log('\n\n=== TEST 1: direct-local + rich facts → expect FULL, no reframe ===');
  const topic1 = { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference', verdict: 'direct-local' };
  const sourcing1: SourceGatheringResult = {
    topic: topic1,
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
  };
  const sufficiency1 = evaluateSufficiency(sourcing1);
  console.log(`Stage 4 decision: ${sufficiency1.decision} — ${sufficiency1.reasoning}`);
  const article1 = await writeArticle(topic1, sourcing1, sufficiency1);
  printArticle(article1);

  // --- 2. direct-local + thin facts (mirrors "Thin" fixture) ---
  console.log('\n\n=== TEST 2: direct-local + thin facts (missing WHEN) → expect BLURB, no reframe ===');
  const topic2 = { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class', verdict: 'direct-local' };
  const sourcing2: SourceGatheringResult = {
    topic: topic2,
    facts: [
      { field: 'venueName', value: 'Kähvi Coffee + Cafe', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/sundayyoga' },
    ],
    primarySourceFound: false,
    factCount: 1,
  };
  const sufficiency2 = evaluateSufficiency(sourcing2);
  console.log(`Stage 4 decision: ${sufficiency2.decision} — ${sufficiency2.reasoning}`);
  const article2 = await writeArticle(topic2, sourcing2, sufficiency2);
  printArticle(article2);

  // --- 3. national-reframe + eclipse-like fact set (new fixture) ---
  console.log('\n\n=== TEST 3: national-reframe + eclipse-like facts → expect FULL or BLURB (fact-count dependent) + reframe ===');
  const topic3 = { title: 'Rare Meteor Shower Peaks Tonight', section: 'news', subjectTag: 'astronomy', verdict: 'national-reframe' };
  const sourcing3: SourceGatheringResult = {
    topic: topic3,
    facts: [
      { field: 'visibility', value: 'Not visible from Arizona tonight due to forecast monsoon cloud cover', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
      { field: 'alternative', value: 'Best alternative Arizona viewing window is Thursday night, when skies are forecast to clear', source: 'National Weather Service Phoenix', sourceUrl: 'https://weather.gov/psr/forecast' },
      { field: 'date', value: '2026-08-13', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
      { field: 'description', value: 'The Perseid meteor shower peaks tonight with up to 60 meteors per hour visible under clear skies.', source: 'American Meteor Society', sourceUrl: 'https://amsmeteors.org' },
    ],
    primarySourceFound: true,
    factCount: 4,
  };
  const sufficiency3 = evaluateSufficiency(sourcing3);
  console.log(`Stage 4 decision: ${sufficiency3.decision} — ${sufficiency3.reasoning}`);
  console.log(
    `NOTE: this fact set has no "venueName" field (there's no venue for a national astronomy story) — sufficiencyGate.ts's WHAT_FIELDS is currently just ['venueName'], so hasCoreWhat will be false here regardless of fact count, meaning this shape can structurally never reach 'full-article' under the gate as it exists today. Flagging, not fixing — sufficiencyGate.ts is off-limits this build.`
  );
  const article3 = await writeArticle(topic3, sourcing3, sufficiency3);
  printArticle(article3);

  // --- 4. Conflicting fixture ---
  console.log('\n\n=== TEST 4: conflicting price facts → confirm CONFLICT HANDLING in the body ===');
  const topic4 = { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia', verdict: 'direct-local' };
  const sourcing4: SourceGatheringResult = {
    topic: topic4,
    facts: [
      { field: 'venueName', value: 'Arizona Wilderness Brewing Co.', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
      { field: 'date', value: 'Wednesdays', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
      { field: 'price', value: 'Free', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/trivia' },
      { field: 'price', value: '$5 buy-in', source: 'venue page — HTTP fetch (https://azwbeer.com/gilbert/events/)', sourceUrl: 'https://azwbeer.com/gilbert/events/' },
    ],
    primarySourceFound: true,
    factCount: 4,
  };
  const sufficiency4 = evaluateSufficiency(sourcing4);
  console.log(`Stage 4 decision: ${sufficiency4.decision} — ${sufficiency4.reasoning}`);
  console.log(`Conflicts passed to the writer: ${JSON.stringify(sufficiency4.conflicts, null, 2)}`);
  const article4 = await writeArticle(topic4, sourcing4, sufficiency4);
  printArticle(article4);
  if (article4) {
    const mentionsFree = /free/i.test(article4.bodyMarkdown);
    const mentionsFive = /\$5/.test(article4.bodyMarkdown);
    const mentionsBoth = mentionsFree && mentionsFive;
    console.log(
      `\nCONFLICT HANDLING CHECK: body mentions "Free"=${mentionsFree}, mentions "$5"=${mentionsFive} → ${
        mentionsBoth
          ? 'model attributed BOTH disputed values (option a: attribute by source)'
          : mentionsFree || mentionsFive
            ? 'model appears to have stated only ONE disputed value as fact — inspect body text above, this would violate the CONFLICT HANDLING rule if so'
            : 'model OMITTED the disputed price entirely (option b: omit disputed specific)'
      }`
    );
  }

  // --- 5. Empty fixture — confirm skip AND that no OpenAI call happens ---
  console.log('\n\n=== TEST 5: empty facts → expect skip, and confirm NO OpenAI call is made ===');
  const topic5 = { title: 'Untitled Local Meetup', section: 'news', subjectTag: 'meetup', verdict: 'direct-local' };
  const sourcing5: SourceGatheringResult = { topic: topic5, facts: [], primarySourceFound: false, factCount: 0 };
  const sufficiency5 = evaluateSufficiency(sourcing5);
  console.log(`Stage 4 decision: ${sufficiency5.decision} — ${sufficiency5.reasoning}`);

  const axiosPostSpy = axios.post;
  let axiosPostCallCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (axios as any).post = (...args: unknown[]) => {
    axiosPostCallCount++;
    throw new Error('axios.post was called during a skip-decision writeArticle() call — this should never happen');
  };
  let article5: WrittenArticle | null;
  try {
    article5 = await writeArticle(topic5, sourcing5, sufficiency5);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (axios as any).post = axiosPostSpy;
  }
  console.log(`Result: ${article5 === null ? 'null (correct)' : 'NON-NULL (bug — should have been null)'}`);
  console.log(`axios.post call count during this call: ${axiosPostCallCount} (must be 0 to confirm no OpenAI call was made)`);

  console.log('\n\n########## TEST HARNESS SUMMARY ##########');
  console.log(`1. Rich/direct-local      → Stage4=${sufficiency1.decision}, article=${article1 ? 'written' : 'null'}${article1 ? `, title="${article1.title}" (${article1.title.length} chars), words=${wordCount(article1.bodyMarkdown)}` : ''}`);
  console.log(`2. Thin/direct-local      → Stage4=${sufficiency2.decision}, article=${article2 ? 'written' : 'null'}${article2 ? `, title="${article2.title}" (${article2.title.length} chars), words=${wordCount(article2.bodyMarkdown)}` : ''}`);
  console.log(`3. Eclipse/national-reframe → Stage4=${sufficiency3.decision}, article=${article3 ? 'written' : 'null'}${article3 ? `, title="${article3.title}" (${article3.title.length} chars), words=${wordCount(article3.bodyMarkdown)}` : ''}`);
  console.log(`4. Conflicting/direct-local → Stage4=${sufficiency4.decision}, article=${article4 ? 'written' : 'null'}${article4 ? `, title="${article4.title}" (${article4.title.length} chars), words=${wordCount(article4.bodyMarkdown)}` : ''}`);
  console.log(`5. Empty/direct-local     → Stage4=${sufficiency5.decision}, article=${article5 === null ? 'null (no OpenAI call)' : 'NON-NULL (bug)'}, axios.post calls=${axiosPostCallCount}`);
  console.log('[article-writer] ========== TEST HARNESS end ==========');
}

/** Never dump a raw AxiosError/Error object — its `config.headers.Authorization` (the OpenAI API key) prints in cleartext under Node's default object inspection. Extract only the safe parts. */
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
    console.error('[article-writer] Fatal:', safeErrorSummary(err));
    process.exit(1);
  });
}

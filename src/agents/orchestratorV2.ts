/**
 * Orchestrator V2 — chains every stage built and tested this session
 * (pipeline-redesign-architecture.md, Stages 0-9), end to end, against
 * live data.
 *
 * NEW, STANDALONE. Does not modify orchestrator.ts, newsApiSync.ts, or
 * any existing production pipeline — runs alongside them, replaces
 * nothing yet. This file is the one place tonight allowed to genuinely
 * IMPORT every stage module directly (each stage module itself stayed
 * decoupled from its siblings all session — local type redefinitions,
 * "port don't import" — but an orchestrator's whole job is wiring real
 * stages together, so it imports the real functions/types here).
 *
 * FLOW (per topic that survives Stage 0-2):
 *   Stage 0-2 (topicDiscovery.ts, live SerpAPI + OpenAI)
 *     -> Stage 9 dedupe check (dedupeFeature.ts) — run FIRST, right
 *        after Stage 2's section routing, specifically so a likely
 *        duplicate never wastes Stage 3/4/5/6/7 work.
 *     -> Stage 3 (sourceGathering.ts — events checker, general-purpose
 *        default checker, searchSummaries fallback)
 *     -> Stage 4 (sufficiencyGate.ts)
 *     -> Stage 5 (articleWriter.ts) — only if Stage 4 decision != 'skip'
 *     -> Stage 6 (verificationGate.ts) — only if Stage 5 wrote something
 *     -> Stage 7 (imageSourcing.ts) — only if Stage 6 passed
 *     -> Stage 8 (publishAssembly.ts) — assembly only, never a Sanity
 *        write. Only topics that pass every gate above reach this.
 *
 * Every drop, at every stage, is logged with its reason — this file
 * produces a full funnel, not just a final count.
 *
 * runOrchestratorV2() itself still makes NO Sanity write — the only live
 * Sanity calls in it are read-only (Stage 9's recent-posts check inside
 * dedupeFeature.ts, and a category-doc-id lookup for Stage 8's assembled
 * `category` reference). runOrchestratorV2AndPublish() (added below,
 * explicitly requested) is the new real-write path: it runs the exact
 * same dry-run funnel, then actually publishes every Stage-8 publish-ready
 * result via publishAssembly.ts's publishAssembledDocument() — a real
 * sanityClient.create() call per article, matching the existing
 * production pipeline's immediate-publish behavior. Only call it when a
 * real publish run is actually intended.
 */
import { runTopicDiscoveryShadow, type TopicDiscoveryResult, type Stage0Usage } from './topicDiscovery';
import { gatherSources } from './sourceGathering';
import { evaluateSufficiency } from './sufficiencyGate';
import { writeArticle, type WrittenArticle, type WriteArticleOptions, type ArticlePersona, type ArticleStyle } from './articleWriter';
import { verifyArticle, type VerificationResult } from './verificationGate';
import { sourceImage } from './imageSourcing';
import { assemblePublishDocument, publishAssembledDocument, type AssemblyResult } from './publishAssembly';
import { checkForDuplicates, type SeenThisRunEntry } from './dedupeFeature';

// ---------------------------------------------------------------------------
// Run-log types — every topic that entered, and exactly which stage/gate
// dropped it and why, for topics that didn't make it through.
// ---------------------------------------------------------------------------

type DroppedTopic = { title: string; link: string; reason: string };

type PublishedTopic = {
  title: string;
  link: string;
  proseScore: number;
  document: Record<string, unknown>;
};

export type OrchestratorV2RunResult = {
  rawPoolSize: number;
  cappedPoolSize: number;
  stage1Kept: TopicDiscoveryResult[];
  stage1Skipped: { title: string; link: string; reason: string }[];
  droppedAtDedupe: DroppedTopic[];
  droppedAtSufficiency: DroppedTopic[];
  droppedAtWriting: DroppedTopic[];
  droppedAtVerification: DroppedTopic[];
  published: PublishedTopic[];
  wallClockMs: number;
  stage0Usage: Stage0Usage;
};

// ---------------------------------------------------------------------------
// Read-only category-doc-id lookup — same pattern already used in
// publishAssembly.ts's own test harness. Never a write.
// ---------------------------------------------------------------------------

async function resolveCategoryDocId(section: string): Promise<string | undefined> {
  try {
    const { getSanityClient } = await import('../../agents/sanityPublisher');
    const client = getSanityClient();
    const doc = await client.fetch<{ _id: string } | null>(
      `*[_type == "category" && slug.current == $slug][0]{ _id }`,
      { slug: section }
    );
    return doc?._id;
  } catch (err: unknown) {
    console.warn(
      `[orchestrator-v2] category lookup failed for section="${section}" (read-only; assembling without a category ref):`,
      err instanceof Error ? err.message : String(err)
    );
    return undefined;
  }
}

function wordCount(md: string): number {
  return md.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Per-topic pipeline
// ---------------------------------------------------------------------------

async function runTopicThroughPipeline(
  topic: TopicDiscoveryResult,
  buckets: {
    droppedAtDedupe: DroppedTopic[];
    droppedAtSufficiency: DroppedTopic[];
    droppedAtWriting: DroppedTopic[];
    droppedAtVerification: DroppedTopic[];
    published: PublishedTopic[];
    /**
     * Accumulated across the whole run's topic loop — see
     * dedupeFeature.ts's checkForDuplicates() doc comment: Sanity's
     * fetchRecentPosts() only sees posts published in PREVIOUS runs, so
     * two sibling candidates discovered in this same run (e.g. the same
     * event covered by two outlets) would never be cross-checked against
     * each other without this. One entry pushed per topic that clears
     * Stage 9 this run, checked (not just appended) before the push.
     */
    seenThisRun: SeenThisRunEntry[];
  },
  /**
   * Undefined for every existing call site (runOrchestratorV2()'s own loop
   * below never passes this) — writeArticle() then gets no options, exactly
   * today's behavior. Only processSelectedTopics() (added below) passes a
   * real value, threading a topicCandidate's selectedPersona/selectedStyle
   * through to Stage 5.
   */
  writerOptions?: WriteArticleOptions
): Promise<void> {
  console.log(`\n[orchestrator-v2] === "${topic.title}" (verdict=${topic.verdict}, section=${topic.section}, tag=${topic.subjectTag}) ===`);

  // --- STAGE 9: dedupe, as early as possible (before Stage 3's fetch work) ---
  const dedupeCheck = await checkForDuplicates(
    {
      title: topic.title,
      entityName: topic.specificSubject || topic.subjectTag,
      date: topic.publishedDate ?? undefined,
      sourceUrl: topic.link,
    },
    buckets.seenThisRun
  );
  if (dedupeCheck.isDuplicate) {
    const reason = `Stage 9: likely duplicate (${dedupeCheck.matches[0]?.matchType ?? 'entity'} match) — key "${dedupeCheck.candidateKey}" matches ${dedupeCheck.matches.length} recent post(s): ${dedupeCheck.matches.map((m) => `"${m.title}"`).join('; ')}`;
    console.log(`[orchestrator-v2] DROP (Stage 9 dedupe): ${reason}`);
    buckets.droppedAtDedupe.push({ title: topic.title, link: topic.link, reason });
    return;
  }
  buckets.seenThisRun.push({ key: dedupeCheck.candidateKey, title: topic.title, sourceUrl: topic.link });

  // --- STAGE 3: source gathering ---
  const sourcing = await gatherSources(topic);

  // --- STAGE 4: sufficiency ---
  const sufficiency = evaluateSufficiency(sourcing);
  if (sufficiency.decision === 'skip') {
    const reason = `Stage 4: decision=skip — ${sufficiency.reasoning}`;
    console.log(`[orchestrator-v2] DROP (Stage 3/4 insufficient): ${reason}`);
    buckets.droppedAtSufficiency.push({ title: topic.title, link: topic.link, reason });
    return;
  }
  console.log(`[orchestrator-v2] Stage 4: decision=${sufficiency.decision}`);

  // --- STAGE 5: write ---
  const article = await writeArticle(topic, sourcing, sufficiency, writerOptions);
  if (!article) {
    const reason = 'Stage 5: writeArticle() returned null unexpectedly despite a non-skip Stage 4 decision.';
    console.warn(`[orchestrator-v2] DROP (Stage 5): ${reason}`);
    buckets.droppedAtWriting.push({ title: topic.title, link: topic.link, reason });
    return;
  }
  console.log(`[orchestrator-v2] Stage 5: wrote "${article.title}" (${wordCount(article.bodyMarkdown)} words)`);

  // --- STAGE 6: verify ---
  const verification: VerificationResult = await verifyArticle(article, sourcing.facts);
  if (!verification.passed) {
    const reason = `Stage 6: FAILED — ${verification.overallReason}`;
    console.log(`[orchestrator-v2] DROP (Stage 6 verification): ${reason}`);
    buckets.droppedAtVerification.push({ title: topic.title, link: topic.link, reason });
    return;
  }
  console.log(`[orchestrator-v2] Stage 6: PASSED (prose ${verification.proseCheck.score}/10)`);

  // --- STAGE 7: image (never blocks the pipeline — a missing image is not a publish-blocking gate) ---
  const venueFact = sourcing.facts.find((f) => f.field === 'venueName');
  const entity = venueFact?.value ?? topic.subjectTag;
  const imageOutcome = await sourceImage({
    tags: article.tags,
    section: topic.section,
    entity,
    title: article.title,
  });
  const image = imageOutcome.status === 'ok' ? imageOutcome.result : null;
  console.log(`[orchestrator-v2] Stage 7: ${imageOutcome.status}${image ? ` — photographer="${image.photographerName}"` : ''}`);

  // --- STAGE 8: assemble (never writes to Sanity) ---
  const categoryDocId = await resolveCategoryDocId(topic.section);
  const assembly: AssemblyResult = assemblePublishDocument(article, verification, image, topic, categoryDocId);

  if (!assembly.publishReady) {
    // Defensive only — Stage 6's gate above should make this unreachable,
    // since assemblePublishDocument's own refusal condition is exactly
    // "verification.passed === false", already filtered out above.
    const reason = `Stage 8 refused (unexpected — Stage 6 already gated this): ${assembly.reason}`;
    console.warn(`[orchestrator-v2] DROP (Stage 8): ${reason}`);
    buckets.droppedAtVerification.push({ title: topic.title, link: topic.link, reason });
    return;
  }

  console.log(`[orchestrator-v2] PUBLISH-READY: "${article.title}"`);
  buckets.published.push({
    title: topic.title,
    link: topic.link,
    proseScore: verification.proseCheck.score,
    document: assembly.document,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator entry point
// ---------------------------------------------------------------------------

export async function runOrchestratorV2(): Promise<OrchestratorV2RunResult> {
  const startedAt = Date.now();
  console.log('[orchestrator-v2] ========== RUN start ==========');

  const discovery = await runTopicDiscoveryShadow();
  console.log(
    `[orchestrator-v2] Stage 0-2 done: rawPool=${discovery.dedupeCounts.rawCount}, cappedPool=${discovery.dedupeCounts.cappedCount}, kept=${discovery.kept.length}, skipped=${discovery.skipped.length}`
  );

  const droppedAtDedupe: DroppedTopic[] = [];
  const droppedAtSufficiency: DroppedTopic[] = [];
  const droppedAtWriting: DroppedTopic[] = [];
  const droppedAtVerification: DroppedTopic[] = [];
  const published: PublishedTopic[] = [];
  const seenThisRun: SeenThisRunEntry[] = [];

  for (const topic of discovery.kept) {
    await runTopicThroughPipeline(topic, {
      droppedAtDedupe,
      droppedAtSufficiency,
      droppedAtWriting,
      droppedAtVerification,
      published,
      seenThisRun,
    });
  }

  const wallClockMs = Date.now() - startedAt;

  const result: OrchestratorV2RunResult = {
    rawPoolSize: discovery.dedupeCounts.rawCount,
    cappedPoolSize: discovery.dedupeCounts.cappedCount,
    stage1Kept: discovery.kept,
    stage1Skipped: discovery.skipped,
    droppedAtDedupe,
    droppedAtSufficiency,
    droppedAtWriting,
    droppedAtVerification,
    published,
    wallClockMs,
    stage0Usage: discovery.stage0Usage,
  };

  console.log(`[orchestrator-v2] ========== RUN end (${(wallClockMs / 1000).toFixed(1)}s) ==========`);
  return result;
}

// ---------------------------------------------------------------------------
// REAL PUBLISH — runOrchestratorV2AndPublish(). Explicitly requested.
// Runs the identical dry-run funnel above, then actually publishes every
// Stage-8 publish-ready result via publishAssembledDocument() — real
// sanityClient.create() calls. Nothing here changes runOrchestratorV2()'s
// own behavior; this only adds a publish step after it.
// ---------------------------------------------------------------------------

export type RealPublishRecord = { title: string; link: string; sanityId: string; slug: string };
export type RealPublishFailure = { title: string; link: string; message: string };

export type OrchestratorV2PublishRunResult = OrchestratorV2RunResult & {
  realPublishes: RealPublishRecord[];
  realPublishFailures: RealPublishFailure[];
};

export async function runOrchestratorV2AndPublish(): Promise<OrchestratorV2PublishRunResult> {
  const result = await runOrchestratorV2();

  const realPublishes: RealPublishRecord[] = [];
  const realPublishFailures: RealPublishFailure[] = [];

  for (const p of result.published) {
    console.log(`[orchestrator-v2] REAL PUBLISH attempt: "${p.title}"`);
    const outcome = await publishAssembledDocument({ publishReady: true, document: p.document });
    if (outcome.status === 'published') {
      realPublishes.push({ title: p.title, link: p.link, sanityId: outcome.id, slug: outcome.slug });
      console.log(`[orchestrator-v2] REAL PUBLISH ok: "${p.title}" → _id=${outcome.id}, slug=${outcome.slug}`);
    } else {
      const message = outcome.status === 'error' ? outcome.message : outcome.reason;
      realPublishFailures.push({ title: p.title, link: p.link, message });
      console.error(`[orchestrator-v2] REAL PUBLISH FAILED: "${p.title}" → ${message}`);
    }
  }

  return { ...result, realPublishes, realPublishFailures };
}

// ---------------------------------------------------------------------------
// Test harness — runs the real thing against live topicDiscovery.ts
// output, no fixtures anywhere. Prints a full funnel report plus the
// complete assembled document JSON for every topic that made it all the
// way through. No Sanity write anywhere in this run.
// ---------------------------------------------------------------------------

function safeErrorSummary(err: unknown): string {
  const axiosLike = err as { isAxiosError?: boolean; response?: { status?: number; data?: unknown }; message?: string };
  if (axiosLike?.isAxiosError) {
    const status = axiosLike.response?.status;
    const body = axiosLike.response?.data;
    const apiMessage =
      body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)
        ? JSON.stringify((body as Record<string, unknown>).error)
        : undefined;
    return `AxiosError: HTTP ${status ?? '(no response)'}${apiMessage ? ` — ${apiMessage}` : ` — ${axiosLike.message}`}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function runTestHarness(): Promise<void> {
  const result = await runOrchestratorV2();

  console.log('\n\n########## ORCHESTRATOR V2 — FULL FUNNEL SUMMARY ##########');
  console.log(`Raw Stage 0 pool: ${result.rawPoolSize}`);
  console.log(`Capped pool fed to Stage 1 (cap=20): ${result.cappedPoolSize}`);
  console.log(`Stage 1 verdicts issued: ${result.stage1Kept.length + result.stage1Skipped.length} (kept=${result.stage1Kept.length}, skipped=${result.stage1Skipped.length})`);

  console.log(`\n--- Dropped at Stage 1 (${result.stage1Skipped.length}) ---`);
  for (const s of result.stage1Skipped) {
    console.log(`  "${s.title.slice(0, 80)}" — ${s.reason}`);
  }

  console.log(`\n--- Dropped at Stage 9 dedupe (${result.droppedAtDedupe.length}) ---`);
  for (const d of result.droppedAtDedupe) {
    console.log(`  "${d.title.slice(0, 80)}" — ${d.reason}`);
  }

  console.log(`\n--- Dropped at Stage 3/4 insufficient facts (${result.droppedAtSufficiency.length}) ---`);
  for (const d of result.droppedAtSufficiency) {
    console.log(`  "${d.title.slice(0, 80)}" — ${d.reason}`);
  }

  console.log(`\n--- Dropped at Stage 5 writing (${result.droppedAtWriting.length}) ---`);
  for (const d of result.droppedAtWriting) {
    console.log(`  "${d.title.slice(0, 80)}" — ${d.reason}`);
  }

  console.log(`\n--- Dropped at Stage 6 verification (${result.droppedAtVerification.length}) ---`);
  for (const d of result.droppedAtVerification) {
    console.log(`  "${d.title.slice(0, 80)}" — ${d.reason}`);
  }

  console.log(`\n--- PUBLISH-READY — made it through every gate (${result.published.length}) ---`);
  for (const p of result.published) {
    console.log(`  "${p.title}" — proseScore=${p.proseScore}/10`);
  }

  const totalIn = result.stage1Kept.length + result.stage1Skipped.length;
  const yieldPct = totalIn > 0 ? ((result.published.length / totalIn) * 100).toFixed(1) : '0.0';
  console.log(`\nYIELD: ${result.published.length}/${totalIn} candidate topics reached publish-ready (${yieldPct}%)`);
  console.log(`Wall-clock: ${(result.wallClockMs / 1000).toFixed(1)}s`);

  console.log('\n\n########## FULL ASSEMBLED DOCUMENTS (publish-ready) ##########');
  for (const p of result.published) {
    console.log(`\n=== "${p.title}" ===`);
    console.log(JSON.stringify(p.document, null, 2));
  }

  console.log('\n[orchestrator-v2] ========== TEST HARNESS end ==========');
}

// ---------------------------------------------------------------------------
// HUMAN-SELECTION PATH — discoverAndPersistTopics(). Fully additive: runs
// Stage 0-2 (runTopicDiscoveryShadow(), UNCHANGED — same function
// runOrchestratorV2() already calls) and persists discovery.kept to Sanity
// as topicCandidate documents for a human to review/select, INSTEAD OF
// looping into runTopicThroughPipeline(). Does not call
// runTopicThroughPipeline, runOrchestratorV2, or runOrchestratorV2AndPublish
// at all — a parallel path alongside the existing automatic syncNewsV2
// flow, not a replacement for it. Nothing above this point is modified.
// ---------------------------------------------------------------------------

export type DiscoverAndPersistTopicsResult = {
  keptCount: number;
  skippedCount: number;
  persistedCount: number;
  persistedIds: string[];
  wallClockMs: number;
};

/**
 * Maps one TopicDiscoveryResult to a topicCandidate document body (no
 * write). discoveredAt is stamped at persistence time (topicDiscovery.ts's
 * own publishedDate is a different, optional field — when the source
 * article was published, not when this pipeline discovered it — and per
 * schemas/topicCandidate.ts's header comment is deliberately not carried
 * onto this document).
 */
function toTopicCandidateDoc(topic: TopicDiscoveryResult, discoveredAt: string): Record<string, unknown> {
  return {
    _type: 'topicCandidate',
    title: topic.title,
    sourceUrl: topic.link,
    snippet: topic.snippet,
    discoveredAt,
    section: topic.section,
    verdict: topic.verdict,
    relevanceScore: topic.relevanceScore,
    subjectTag: topic.subjectTag,
    specificSubject: topic.specificSubject,
    status: 'pending',
  };
}

export async function discoverAndPersistTopics(): Promise<DiscoverAndPersistTopicsResult> {
  const startedAt = Date.now();
  console.log('[orchestrator-v2] ========== discoverAndPersistTopics start ==========');

  const discovery = await runTopicDiscoveryShadow();
  console.log(
    `[orchestrator-v2] Stage 0-2 done: kept=${discovery.kept.length}, skipped=${discovery.skipped.length} — persisting kept topics as topicCandidate docs (no Stage 3-8).`
  );

  const discoveredAt = new Date().toISOString();
  const persistedIds: string[] = [];

  if (discovery.kept.length > 0) {
    const { getSanityClient } = await import('../../agents/sanityPublisher');
    const client = getSanityClient();
    const tx = client.transaction();
    const docs = discovery.kept.map((topic) => {
      const doc = toTopicCandidateDoc(topic, discoveredAt);
      tx.create(doc as Parameters<typeof client.create>[0]);
      return doc;
    });
    const txResult = await tx.commit();
    for (const r of txResult.results ?? []) persistedIds.push(r.id);
    console.log(`[orchestrator-v2] Persisted ${persistedIds.length} topicCandidate doc(s): ${docs.map((d) => `"${(d.title as string).slice(0, 60)}"`).join(', ')}`);
  }

  const wallClockMs = Date.now() - startedAt;
  const result: DiscoverAndPersistTopicsResult = {
    keptCount: discovery.kept.length,
    skippedCount: discovery.skipped.length,
    persistedCount: persistedIds.length,
    persistedIds,
    wallClockMs,
  };
  console.log(`[orchestrator-v2] ========== discoverAndPersistTopics end (${(wallClockMs / 1000).toFixed(1)}s) ==========`);
  return result;
}

// ---------------------------------------------------------------------------
// HUMAN-SELECTION PATH, part 2 — processSelectedTopics(). Takes topicCandidate
// IDs a human has already selected (with selectedPersona/selectedStyle set),
// reconstructs each as a TopicDiscoveryResult, and runs them through the
// EXISTING runTopicThroughPipeline() (same Stage 9/3/4/6/7/8 as
// runOrchestratorV2()'s own loop — only the new, optional writerOptions
// 3rd parameter differs) plus the same real-publish step
// runOrchestratorV2AndPublish() already uses. Fully additive — does not
// call runOrchestratorV2/runOrchestratorV2AndPublish/discoverAndPersistTopics.
// ---------------------------------------------------------------------------

const ARTICLE_PERSONAS = new Set<ArticlePersona>(['fat-jimmy', 'sonny-blaze', 'health-nut']);
const ARTICLE_STYLES = new Set<ArticleStyle>(['straight-recap', 'listicle', 'opinion']);

function coercePersona(value: unknown): ArticlePersona | undefined {
  return typeof value === 'string' && (ARTICLE_PERSONAS as Set<string>).has(value) ? (value as ArticlePersona) : undefined;
}
function coerceStyle(value: unknown): ArticleStyle | undefined {
  return typeof value === 'string' && (ARTICLE_STYLES as Set<string>).has(value) ? (value as ArticleStyle) : undefined;
}

type TopicCandidateDoc = {
  _id: string;
  title: string;
  sourceUrl: string;
  snippet?: string;
  section?: string;
  verdict?: string;
  relevanceScore?: number;
  subjectTag?: string;
  specificSubject?: string;
  selectedPersona?: string;
  selectedStyle?: string;
};

export type ProcessedTopicOutcome = {
  candidateId: string;
  title: string;
  outcome: 'published' | 'dropped-dedupe' | 'dropped-sufficiency' | 'dropped-writing' | 'dropped-verification' | 'publish-failed';
  /** Human-readable — the real drop reason from whichever stage caught it, or the sanityId/slug on success. Never silent. */
  detail: string;
};

export type ProcessSelectedTopicsResult = {
  processedCount: number;
  publishedCount: number;
  outcomes: ProcessedTopicOutcome[];
  wallClockMs: number;
};

export async function processSelectedTopics(candidateIds: string[]): Promise<ProcessSelectedTopicsResult> {
  const startedAt = Date.now();
  console.log(`[orchestrator-v2] ========== processSelectedTopics start (${candidateIds.length} candidate(s)) ==========`);

  const { getSanityClient } = await import('../../agents/sanityPublisher');
  const client = getSanityClient();

  const candidates = await client.fetch<TopicCandidateDoc[]>(
    `*[_type == "topicCandidate" && _id in $ids]{ _id, title, sourceUrl, snippet, section, verdict, relevanceScore, subjectTag, specificSubject, selectedPersona, selectedStyle }`,
    { ids: candidateIds }
  );
  console.log(`[orchestrator-v2] Fetched ${candidates.length}/${candidateIds.length} requested topicCandidate doc(s).`);

  const droppedAtDedupe: DroppedTopic[] = [];
  const droppedAtSufficiency: DroppedTopic[] = [];
  const droppedAtWriting: DroppedTopic[] = [];
  const droppedAtVerification: DroppedTopic[] = [];
  const published: PublishedTopic[] = [];
  // Shared across the WHOLE batch, per the earlier decision — topics
  // selected together get cross-checked against each other, not just
  // against Sanity's existing posts (same mechanism as
  // runOrchestratorV2()'s own loop, see runTopicThroughPipeline's doc
  // comment on seenThisRun).
  const seenThisRun: SeenThisRunEntry[] = [];

  for (const candidate of candidates) {
    // Reconstructed from topicCandidate — sourceOutlet/publishedDate/
    // searchSummaries were deliberately never persisted on that document
    // (see schemas/topicCandidate.ts's header comment), so those three
    // fields fall back to null/null/[]. Stage 9's date-based dedupe check
    // and Stage 3's searchSummaries-based fallback URLs are unavailable
    // for reconstructed topics as a result — topic.link (the real
    // sourceUrl) is still Stage 3's primary candidate either way, so this
    // is a minor degradation, not a break.
    const topic: TopicDiscoveryResult = {
      title: candidate.title,
      snippet: candidate.snippet ?? '',
      link: candidate.sourceUrl,
      sourceOutlet: null,
      publishedDate: null,
      verdict: (candidate.verdict as TopicDiscoveryResult['verdict']) ?? 'direct-local',
      section: (candidate.section as TopicDiscoveryResult['section']) ?? 'news',
      relevanceScore: candidate.relevanceScore ?? 0,
      subjectTag: candidate.subjectTag ?? '',
      specificSubject: candidate.specificSubject ?? '',
      searchSummaries: [],
    };

    const writerOptions: WriteArticleOptions = {
      persona: coercePersona(candidate.selectedPersona),
      style: coerceStyle(candidate.selectedStyle),
    };
    console.log(
      `[orchestrator-v2] Reconstructed "${topic.title}" (candidateId=${candidate._id}) — persona=${writerOptions.persona ?? '(none)'}, style=${writerOptions.style ?? '(none)'}`
    );

    await runTopicThroughPipeline(
      topic,
      { droppedAtDedupe, droppedAtSufficiency, droppedAtWriting, droppedAtVerification, published, seenThisRun },
      writerOptions
    );
  }

  // --- Real publish — same publishAssembledDocument() path
  // runOrchestratorV2AndPublish() already uses, reused here so selected
  // topics actually land in Sanity, not just reach a dry-run publish-ready
  // state. ---
  const realPublishes: RealPublishRecord[] = [];
  const realPublishFailures: RealPublishFailure[] = [];
  for (const p of published) {
    console.log(`[orchestrator-v2] REAL PUBLISH attempt: "${p.title}"`);
    const outcome = await publishAssembledDocument({ publishReady: true, document: p.document });
    if (outcome.status === 'published') {
      realPublishes.push({ title: p.title, link: p.link, sanityId: outcome.id, slug: outcome.slug });
      console.log(`[orchestrator-v2] REAL PUBLISH ok: "${p.title}" → _id=${outcome.id}, slug=${outcome.slug}`);
    } else {
      const message = outcome.status === 'error' ? outcome.message : outcome.reason;
      realPublishFailures.push({ title: p.title, link: p.link, message });
      console.error(`[orchestrator-v2] REAL PUBLISH FAILED: "${p.title}" → ${message}`);
    }
  }

  // --- Record what actually happened to each pick, then mark every
  // candidate status: 'processed' — matched back by sourceUrl/link, unique
  // per candidate in a batch. ---
  const outcomes: ProcessedTopicOutcome[] = [];
  const patchTx = client.transaction();
  for (const candidate of candidates) {
    const realPub = realPublishes.find((r) => r.link === candidate.sourceUrl);
    const realFail = realPublishFailures.find((r) => r.link === candidate.sourceUrl);
    const dedupeHit = droppedAtDedupe.find((d) => d.link === candidate.sourceUrl);
    const sufficiencyHit = droppedAtSufficiency.find((d) => d.link === candidate.sourceUrl);
    const writingHit = droppedAtWriting.find((d) => d.link === candidate.sourceUrl);
    const verificationHit = droppedAtVerification.find((d) => d.link === candidate.sourceUrl);

    let outcome: ProcessedTopicOutcome;
    if (realPub) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'published', detail: `Published — sanityId=${realPub.sanityId}, slug=${realPub.slug}` };
    } else if (realFail) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'publish-failed', detail: realFail.message };
    } else if (dedupeHit) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'dropped-dedupe', detail: dedupeHit.reason };
    } else if (sufficiencyHit) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'dropped-sufficiency', detail: sufficiencyHit.reason };
    } else if (writingHit) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'dropped-writing', detail: writingHit.reason };
    } else if (verificationHit) {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'dropped-verification', detail: verificationHit.reason };
    } else {
      outcome = { candidateId: candidate._id, title: candidate.title, outcome: 'publish-failed', detail: 'Unexpected — candidate did not land in any known outcome bucket.' };
    }
    outcomes.push(outcome);
    patchTx.patch(candidate._id, (p) => p.set({ status: 'processed', processingNote: outcome.detail }));
  }

  const missingIds = candidateIds.filter((id) => !candidates.some((c) => c._id === id));
  for (const id of missingIds) {
    outcomes.push({ candidateId: id, title: '(not found)', outcome: 'publish-failed', detail: 'topicCandidate document not found — never processed.' });
  }

  if (candidates.length > 0) {
    await patchTx.commit();
    console.log(`[orchestrator-v2] Marked ${candidates.length} topicCandidate doc(s) as status=processed.`);
  }

  const wallClockMs = Date.now() - startedAt;
  console.log(
    `[orchestrator-v2] ========== processSelectedTopics end (${(wallClockMs / 1000).toFixed(1)}s) — published=${realPublishes.length}/${candidates.length} ==========`
  );

  return {
    processedCount: candidates.length,
    publishedCount: realPublishes.length,
    outcomes,
    wallClockMs,
  };
}

if (require.main === module) {
  runTestHarness().catch((err) => {
    console.error('[orchestrator-v2] Fatal:', safeErrorSummary(err));
    process.exit(1);
  });
}

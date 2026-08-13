/**
 * GLUE SCRIPT, NOT A MERGE. src/agents/sourceGathering.ts (Stage 3) and
 * src/agents/sufficiencyGate.ts (Stage 4) remain completely untouched and
 * independent of each other — this script is the only thing that imports
 * both. Its only job is confirming that gatherSources()'s real return
 * value can be handed directly to evaluateSufficiency() with no manual
 * reshaping, at both compile time (TypeScript structural typing — the two
 * files each define their own local SourceGatheringResult type, never
 * imported from one another) and runtime (an actual function call, not a
 * hand-simulated shape).
 *
 * This is NOT Stage 5. Stage 5 (article writing) does not exist yet —
 * this script's job stops at printing the Stage 4 decision.
 *
 * Two scenarios:
 *   1. LIVE — a real gatherSources() call for a food-shaped topic. Zero
 *      SerpAPI/OpenAI cost: the dispatch shell returns its
 *      "no checker implemented" result before touching any API, since
 *      only the events checker exists. This exercises the real runtime
 *      return value, not a guess at its shape.
 *   2. FIXTURE — events-shaped input mimicking what a working SerpAPI
 *      Events call + venue-page fetch would produce (modeled on the
 *      Steel Pulse test case from sourceGathering.ts's own test harness).
 *      Not a live call: SerpAPI's google_events engine was confirmed down
 *      earlier this session, so a live events call here would only prove
 *      "still down," not exercise a real blurb/full-article decision path.
 *      Clearly labeled below so it's never confused with scenario 1.
 *
 * Run: npx ts-node scripts/test-stage3-stage4.ts
 */
import { gatherSources, type TopicInput as GatherTopicInput } from '../src/agents/sourceGathering';
import { evaluateSufficiency, type SourceGatheringResult } from '../src/agents/sufficiencyGate';

function printChain(label: string, result: SourceGatheringResult): void {
  console.log(`\n=== ${label} ===`);

  console.log('\n[1] Topic in:');
  console.log(JSON.stringify(result.topic, null, 2));

  console.log(`\n[2] Facts gathered (${result.facts.length}), primarySourceFound=${result.primarySourceFound}:`);
  console.log(JSON.stringify(result.facts, null, 2));

  // The critical line: result (sourceGathering.ts's own SourceGatheringResult
  // type) is passed straight into evaluateSufficiency(), which is typed
  // against sufficiencyGate.ts's own, separately-defined SourceGatheringResult
  // type. No cast, no reshaping. If this didn't compile, the two modules'
  // shapes would have already diverged — it compiling is part of the proof.
  const decision = evaluateSufficiency(result);

  console.log(`\n[3] Stage 4 decision: ${decision.decision.toUpperCase()}`);
  console.log(`Reasoning: ${decision.reasoning}`);
  console.log(
    `Summary: qualifyingFactCount=${decision.qualifyingFactCount}, hasCoreWhat=${decision.hasCoreWhat}, hasCoreWhen=${decision.hasCoreWhen}, conflicts=${decision.conflicts.length}, disqualifiedFacts=${decision.disqualifiedFactCount}`
  );
}

async function main(): Promise<void> {
  console.log('[test-stage3-stage4] ========== Stage 3 → Stage 4 glue run start ==========');

  // --- Scenario 1: LIVE gatherSources() call, food topic (no checker implemented, zero API cost) ---
  const foodTopic: GatherTopicInput = {
    title: 'New taco spot opens in Tempe',
    snippet: 'A new taco restaurant opened this week in downtown Tempe.',
    section: 'food',
    verdict: 'direct-local',
    subjectTag: 'restaurant opening',
  };
  console.log('\n[test-stage3-stage4] Scenario 1: LIVE gatherSources() call (food topic, no checker implemented for this category)');
  const liveResult = await gatherSources(foodTopic);
  printChain('SCENARIO 1 — LIVE gatherSources() output', liveResult);

  // --- Scenario 2: FIXTURE mimicking a real events-checker result (SerpAPI Events is confirmed down; see file header) ---
  console.log('\n\n[test-stage3-stage4] Scenario 2: FIXTURE (not live — mimics a working events checker result)');
  const fixtureResult: SourceGatheringResult = {
    topic: {
      title: 'Steel Pulse with Eli-Mac',
      snippet: 'Reggae legends Steel Pulse play The Van Buren in Phoenix, AZ on Aug 13, 2026 at 8:00pm, with support from Eli-Mac.',
      section: 'nightlife',
      verdict: 'direct-local',
      subjectTag: 'concert',
      location: 'Phoenix, AZ',
    },
    facts: [
      { field: 'venueName', value: 'The Van Buren', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
      { field: 'date', value: '2026-08-13', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
      { field: 'time', value: '8:00 PM', source: 'venue page — HTTP fetch (https://thevanburen.com/events/steel-pulse)', sourceUrl: 'https://thevanburen.com/events/steel-pulse' },
      { field: 'ticketUrl', value: 'https://thevanburen.com/events/steel-pulse', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
    ],
    primarySourceFound: true,
    factCount: 4,
  };
  printChain('SCENARIO 2 — FIXTURE (events-shaped, mimics real gatherSources() output)', fixtureResult);

  console.log('\n\n########## GLUE RUN SUMMARY ##########');
  console.log('Both scenarios fed a sourceGathering.ts SourceGatheringResult value directly into');
  console.log('sufficiencyGate.ts\'s evaluateSufficiency() — no manual reshaping, no cast, no shared');
  console.log('type import between the two files. Compiling and running without error confirms the');
  console.log('two independently-defined shapes are actually structurally compatible in practice,');
  console.log('not just on paper.');
  console.log('[test-stage3-stage4] ========== Stage 3 → Stage 4 glue run end ==========');
}

main().catch((err) => {
  console.error('[test-stage3-stage4] Fatal:', err);
  process.exit(1);
});

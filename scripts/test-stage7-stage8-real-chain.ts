/**
 * TEST SCRIPT ONLY — does not modify imageSourcing.ts, publishAssembly.ts,
 * or any other production file. Chains the REAL Stage 3 -> 4 -> 5 -> 6 -> 7
 * -> 8 pipeline against 2 real topics from tonight's actual live
 * topicDiscovery.ts run (topic-discovery-2026-08-15T04-46-34-267Z.json),
 * with their real searchSummaries attached — not the 4 hand-built
 * fixtures used for earlier Stage 5/6/7/8 testing.
 *
 * Purpose: confirm Stages 7 and 8 work against genuine Stage 5 output
 * (real tags, real section, no guaranteed venueName fact) rather than
 * fixture data that always happened to have the fields those stages
 * expect.
 *
 * NO Sanity write anywhere in this script — the one live Sanity call is
 * a read-only category-doc-id lookup (via the existing, unmodified
 * getSanityClient()), same as publishAssembly.ts's own test harness.
 *
 * Run: npx ts-node scripts/test-stage7-stage8-real-chain.ts
 */
import { gatherSources } from '../src/agents/sourceGathering';
import { evaluateSufficiency } from '../src/agents/sufficiencyGate';
import { writeArticle, type WrittenArticle } from '../src/agents/articleWriter';
import { verifyArticle, type VerificationResult } from '../src/agents/verificationGate';
import { sourceImage, type ImageSourcingOutcome } from '../src/agents/imageSourcing';
import { assemblePublishDocument, type AssemblyResult } from '../src/agents/publishAssembly';

type SearchSummary = { title?: string; url?: string; summary?: string };
type RealTopic = {
  title: string;
  link: string;
  section: string;
  subjectTag: string;
  verdict: string;
  searchSummaries: SearchSummary[];
};

const REAL_TOPICS: RealTopic[] = [
  {
    title: 'Heat risk climbs as drier air returns to southern Arizona and monsoon takes a bit of a weekend break',
    link: 'https://www.kgun9.com/weather/forecast/todays-forecast/heat-risk-climbs-as-drier-air-returns-to-southern-arizona-and-monsoon-takes-a-bit-of-a-weekend-break',
    section: 'news',
    subjectTag: 'weather',
    verdict: 'direct-local',
    searchSummaries: [
      { title: 'KGUN 9 Weather Forecast: Heat risk climbs...', url: 'https://www.kgun9.com/weather/forecast/todays-forecast/heat-risk-climbs-as-drier-air-returns-to-southern-arizona-and-monsoon-takes-a-bit-of-a-weekend-break', summary: 'This is the candidate local forecast story itself.' },
      { title: 'National Weather Service Phoenix Area Forecast Discussion', url: 'https://marine.weather.gov/product.php?format=CI&glossary=1&issuedby=PSR&product=AFD&site=HNX&version=16', summary: 'NWS Phoenix discusses drier conditions.' },
      { title: 'National Weather Service Monsoon Information Page', url: 'https://www.weather.gov/twc/MonsoonInfo', summary: 'Official NWS background on monsoon breaks.' },
    ],
  },
  {
    title: 'Arizona Restaurant Association Announces Dates of 2026 Fall Arizona Restaurant Week',
    link: 'https://www.azcentral.com/things-to-do/events/?_evDiscoveryPath=/event/3778574-arizona-restaurant-association-announces-dates-of-2026-fall-arizona-restaurant-week',
    section: 'food',
    subjectTag: 'restaurant week',
    verdict: 'direct-local',
    searchSummaries: [
      { title: 'Arizona Restaurant Week – Enjoy local eats during this special week', url: 'https://arizonarestaurantweek.com/', summary: 'Official page announcing Fall 2026.' },
      { title: 'FAQs – Arizona Restaurant Week', url: 'https://arizonarestaurantweek.com/faqs', summary: 'States AZ Restaurant Week returns Sept 18-27, 2026.' },
      { title: 'Home – Arizona Restaurant Week', url: 'https://arizonarestaurantweek.com/home', summary: 'Lists participating restaurants across Phoenix-area cities.' },
    ],
  },
];

function wordCount(md: string): number {
  return md.split(/\s+/).filter(Boolean).length;
}

async function resolveCategoryDocId(section: string): Promise<string | undefined> {
  try {
    const { getSanityClient } = await import('../agents/sanityPublisher');
    const client = getSanityClient();
    const doc = await client.fetch<{ _id: string } | null>(
      `*[_type == "category" && slug.current == $slug][0]{ _id }`,
      { slug: section }
    );
    return doc?._id;
  } catch (err: unknown) {
    console.warn(`[test] category lookup failed for section="${section}" (read-only; assembling without a category ref):`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function runOne(topic: RealTopic): Promise<{ label: string; article: WrittenArticle | null; verification: VerificationResult | null; image: ImageSourcingOutcome | null; assembly: AssemblyResult | null }> {
  console.log(`\n\n${'='.repeat(90)}`);
  console.log(`TOPIC: "${topic.title}"`);
  console.log(`  link=${topic.link}, section=${topic.section}, subjectTag=${topic.subjectTag}`);
  console.log('='.repeat(90));

  console.log('\n--- STAGE 3: gatherSources() ---');
  const sourcing = await gatherSources(topic);
  console.log(`factCount=${sourcing.factCount}, primarySourceFound=${sourcing.primarySourceFound}`);
  console.log(`facts: ${sourcing.facts.map((f) => f.field).join(', ') || '(none)'}`);

  console.log('\n--- STAGE 4: evaluateSufficiency() ---');
  const sufficiency = evaluateSufficiency(sourcing);
  console.log(`decision=${sufficiency.decision}`);

  if (sufficiency.decision === 'skip') {
    console.log('(skip — stopping chain here)');
    return { label: topic.title, article: null, verification: null, image: null, assembly: null };
  }

  console.log('\n--- STAGE 5: writeArticle() ---');
  const article = await writeArticle(topic, sourcing, sufficiency);
  if (!article) {
    console.log('(writeArticle returned null unexpectedly)');
    return { label: topic.title, article: null, verification: null, image: null, assembly: null };
  }
  console.log(`title="${article.title}", words=${wordCount(article.bodyMarkdown)}`);
  console.log(`tags=${JSON.stringify(article.tags)}`);
  console.log(`categories (Stage 5's own pick, NOT used for assembly)=${JSON.stringify(article.categories)}`);
  console.log(`phantomFactCount=${article.phantomFactCount}, phantomSourceCount=${article.phantomSourceCount}`);

  console.log('\n--- STAGE 6: verifyArticle() ---');
  const verification = await verifyArticle(article, sourcing.facts);
  console.log(`passed=${verification.passed}, proseScore=${verification.proseCheck.score}/10`);

  console.log('\n--- STAGE 7: sourceImage() — REAL article tags/section/entity, not fixture data ---');
  // No venueName fact exists for default-checker topics — entity falls back
  // to topic.subjectTag, exactly as extractEntity() did in earlier harnesses.
  const venueFact = sourcing.facts.find((f) => f.field === 'venueName');
  const entity = venueFact?.value ?? topic.subjectTag;
  console.log(`Stage 7 input: entity=${JSON.stringify(entity)} (no venueName fact — fell back to subjectTag), section=${topic.section}, tags=${JSON.stringify(article.tags)}`);
  const imageOutcome = await sourceImage({
    tags: article.tags,
    section: topic.section,
    entity,
    title: article.title,
  });
  console.log(`Stage 7 outcome: ${JSON.stringify(imageOutcome, null, 2)}`);

  console.log('\n--- STAGE 8: assemblePublishDocument() — assembly only, no Sanity write ---');
  const imageForAssembly = imageOutcome.status === 'ok' ? imageOutcome.result : null;
  const categoryDocId = await resolveCategoryDocId(topic.section);
  console.log(`Category doc lookup for section="${topic.section}": ${categoryDocId ?? '(not found)'}`);
  const assembly = assemblePublishDocument(article, verification, imageForAssembly, topic, categoryDocId);
  console.log('\nFULL ASSEMBLED DOCUMENT:');
  console.log(JSON.stringify(assembly, null, 2));

  return { label: topic.title, article, verification, image: imageOutcome, assembly };
}

async function main(): Promise<void> {
  const results = [];
  for (const topic of REAL_TOPICS) {
    results.push(await runOne(topic));
  }

  console.log('\n\n########## STAGE 7/8 REAL-CHAIN TEST SUMMARY ##########');
  for (const r of results) {
    if (!r.article) {
      console.log(`${r.label} → no article written`);
      continue;
    }
    const stage7 = r.image ? `${r.image.status}${r.image.status === 'ok' ? ` (photographer="${r.image.result.photographerName}")` : ''}` : '(not run)';
    const stage8 = r.assembly ? (r.assembly.publishReady ? 'publishReady=true' : `publishReady=false — ${r.assembly.reason}`) : '(not run)';
    console.log(`${r.label}\n  Stage 6: passed=${r.verification?.passed}, score=${r.verification?.proseCheck.score}/10\n  Stage 7: ${stage7}\n  Stage 8: ${stage8}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

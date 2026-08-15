/**
 * Stage 8 — Sanity Publish Assembly (pipeline-redesign-architecture.md).
 *
 * ASSEMBLY ONLY. This module never calls sanityClient.create(), .patch(),
 * or any other write method — not here, not in its test harness. It
 * builds and returns the document object that WOULD be created; actually
 * writing it to Sanity is a separate, deliberate manual step performed
 * later, after human review, not something this stage or its tests do.
 *
 * Fixes a confirmed production bug in agents/sanityPublisher.ts's
 * publishGoogleNewsArticleToSanity (read read-only for reference, not
 * modified): `section`, `categories[]`, and the `category` reference are
 * each populated from a mix of sources — `categories[]` unions the
 * slot-derived primary category with whatever categories the model
 * independently chose in its own JSON output (article.categories), so the
 * model's free-form categorization can drift from the slot/section-derived
 * value. That's how a meteor-shower article ended up filed under
 * health-wellness. Fix: Stage 2's `section` value (from the original topic
 * metadata, never Stage 5's own article.categories) is the ONLY source of
 * truth; `categories[]` and the `category` reference are derived from it
 * mechanically and nothing else is unioned in.
 *
 * NEW MODULE. STANDALONE, SHADOW MODE ONLY — not wired into
 * editorAgent.ts, newsApiSync.ts, or orchestrator.ts. No production file
 * is modified.
 */

// ---------------------------------------------------------------------------
// Input shapes — mirror articleWriter.ts's WrittenArticle, verificationGate.ts's
// VerificationResult, and imageSourcing.ts's ImageSourcingResult, redefined
// locally (not imported), same decoupling pattern as every other stage.
// ---------------------------------------------------------------------------

export type SourceCredit = { outlet: string; url: string };

export type WrittenArticleInput = {
  title: string;
  slug: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  /** Deliberately NOT used for document assembly — see file header. Present on the type only because it's part of the real WrittenArticle shape. */
  categories: string[];
  tags: string[];
  visualStyle: string;
  heroImagePrompt: string;
  bodyMarkdown: string;
  factsUsed: string[];
  sourceCredits: SourceCredit[];
  phantomFactCount: number;
  phantomSourceCount: number;
};

export type VerificationInput = {
  passed: boolean;
  mechanicalCheck: { phantomFactCount: number; phantomSourceCount: number };
  proseCheck: { score: number; reason: string };
  overallReason: string;
};

export type ImageResultInput = {
  query: string;
  photoId: string;
  imageUrl: string;
  photographerName: string;
  photographerProfileUrl: string;
  altText: string;
  downloadTriggerFired: boolean;
} | null;

/**
 * Original topic metadata from Stage 0-2. `section` is THE source of truth
 * for this stage's category derivation — see file header.
 */
export type TopicMetadataInput = {
  title: string;
  section: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Section — single source of truth. Matches schemas/post.ts's `section`
// field's exact options list (checked directly against that file; not
// imported, since it's a Sanity schema definition, not a TS module).
// ---------------------------------------------------------------------------

const SECTION_VALUES = [
  'cannabis',
  'health-wellness',
  'nightlife',
  'food',
  'events',
  'sports',
  'global',
  'news',
] as const;
type SectionValue = (typeof SECTION_VALUES)[number];

function isValidSection(section: string): section is SectionValue {
  return (SECTION_VALUES as readonly string[]).includes(section);
}

/**
 * categories[] and the category reference are BOTH derived from section
 * alone — a single-element array, never unioned with anything else
 * (specifically never with WrittenArticle.categories, the model's own
 * free-form pick, which is the field that drifted in the bug this fixes).
 * A richer section→categories fan-out (e.g. tagging one section under
 * multiple related categories) would still be "derived, never independent"
 * and could replace this later — flagged as a judgment call in the build
 * report, not something this pass invents without being asked.
 */
function deriveCategoriesAndRef(
  section: SectionValue,
  categoryDocId: string | undefined
): { categories: string[]; category?: { _type: 'reference'; _ref: string } } {
  return {
    categories: [section],
    ...(categoryDocId ? { category: { _type: 'reference' as const, _ref: categoryDocId } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Disclaimer / attribution — composes source credits (from Stage 5) and
// photo credit (from Stage 7) into the existing `disclaimer` text field.
// No new schema field invented for this; `disclaimer` already exists and
// its schema description ("wire/AI sourcing notice shown with the
// article") fits.
// ---------------------------------------------------------------------------

function buildDisclaimer(article: WrittenArticleInput, image: ImageResultInput): string {
  const sourceLine =
    article.sourceCredits.length > 0
      ? `Sourced from: ${article.sourceCredits.map((c) => `${c.outlet} (${c.url})`).join('; ')}.`
      : 'Sourced from HappyTimesAZ reporting.';
  const photoLine = image
    ? ` Hero photo by ${image.photographerName} on Unsplash (${image.photographerProfileUrl || 'https://unsplash.com'}).`
    : '';
  return `${sourceLine}${photoLine}`;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type AssemblyResult =
  | { publishReady: true; document: Record<string, unknown> }
  | { publishReady: false; reason: string };

/**
 * Assembles the exact Sanity `post` document object that WOULD be created —
 * without writing it anywhere. Refuses to assemble anything if Stage 6's
 * verification failed, and refuses if the topic's section isn't one of the
 * schema's recognized values (assembling a document with an invalid
 * section would silently reproduce the drift bug this stage exists to
 * prevent).
 *
 * `categoryDocId`, if supplied, is the real Sanity `category` document's
 * `_id` for this section (resolved by the caller via a read-only lookup —
 * this function itself performs no Sanity I/O, matching every other
 * standalone stage built this session). Omitted, the assembled document
 * simply has no `category` reference rather than a fabricated one.
 */
export function assemblePublishDocument(
  article: WrittenArticleInput,
  verification: VerificationInput,
  image: ImageResultInput,
  topic: TopicMetadataInput,
  categoryDocId?: string
): AssemblyResult {
  if (!verification.passed) {
    const reason = `Stage 6 verification failed — refusing to assemble a publishable document. ${verification.overallReason}`;
    console.warn(`[publish-assembly] "${article.title}" → ${reason}`);
    return { publishReady: false, reason };
  }

  if (!isValidSection(topic.section)) {
    const reason = `Topic section "${topic.section}" is not a recognized section value (${SECTION_VALUES.join(', ')}) — refusing to assemble rather than derive categories from an invalid section.`;
    console.warn(`[publish-assembly] "${article.title}" → ${reason}`);
    return { publishReady: false, reason };
  }

  const section = topic.section;
  const { categories, category } = deriveCategoriesAndRef(section, categoryDocId);

  if (!image) {
    console.warn(`[publish-assembly] "${article.title}" → no image result supplied; assembling without a hero image (not treated as fatal — mirrors existing publish flows that tolerate a missing hero image).`);
  }

  const document: Record<string, unknown> = {
    _type: 'post',
    // "draft-" prefix marks this as a pre-publish preview id, not a live
    // document id — a real publish step assigns its own id at write time.
    _id: `draft-${article.slug}`,
    title: article.title,
    slug: { _type: 'slug', current: article.slug },
    excerpt: article.excerpt,
    seoTitle: article.seoTitle,
    seoDescription: article.seoDescription,
    visualStyle: article.visualStyle,
    tags: article.tags,
    // Single source of truth — see file header. article.categories
    // (Stage 5's own free-form pick) is deliberately never read here.
    section,
    categories,
    ...(category ? { category } : {}),
    // NOTE: real publish converts bodyMarkdown to Portable Text via
    // sanityPublisher.ts's markdownToPortableText() (existing production
    // function, not duplicated here) before it can be written to the
    // schema's real `body` field. Kept as plain markdown + a flag so this
    // is never mistaken for already-schema-shaped body content.
    bodyMarkdown: article.bodyMarkdown,
    bodyNeedsPortableTextConversion: true,
    disclaimer: buildDisclaimer(article, image),
    // NOTE: schemas/post.ts's `heroImage` field has no `alt` (or any other
    // custom) field declared today, and actually attaching an image
    // requires uploading bytes to a Sanity asset first — a write this
    // assembly-only stage never performs. heroImageSource carries
    // everything Stage 7 gathered so a real publish step can upload the
    // image and attach heroImage (with alt, once the schema supports it).
    heroImageSource: image
      ? {
          provider: 'unsplash',
          photoId: image.photoId,
          imageUrl: image.imageUrl,
          photographerName: image.photographerName,
          photographerProfileUrl: image.photographerProfileUrl,
          altText: image.altText,
          downloadTriggerFired: image.downloadTriggerFired,
        }
      : null,
    // Provisional value — schemas/post.ts's `contentSource` options list is
    // currently only manual | newsapi | google_news; this pipeline isn't a
    // registered option yet. Flagged in the build report, not silently
    // decided as final.
    contentSource: 'pipeline_v2',
    isActive: true,
    // Never 'published' — this stage never actually publishes. A human
    // flips this at the real, deliberate publish step.
    status: 'draft',
    // Traceability metadata, not a real schemas/post.ts field — useful for
    // human review of the assembled draft, flagged as extra/non-schema.
    _stage6Verification: {
      passed: verification.passed,
      proseScore: verification.proseCheck.score,
      overallReason: verification.overallReason,
    },
  };

  console.log(`[publish-assembly] "${article.title}" → assembled (section=${section}, categories=${JSON.stringify(categories)}, category ref=${category ? 'yes' : 'NO (no categoryDocId supplied)'}, heroImage=${image ? 'yes' : 'NO'})`);

  return { publishReady: true, document };
}

// ---------------------------------------------------------------------------
// Test harness — chains real Stage 4 → 5 → 6 → 7 → this stage for tests
// 1-4 (same fixtures used all session). All prior-stage functions are
// dynamic-imported here, test-harness-only, same pattern as every other
// stage tonight. Performs ONE read-only Sanity GROQ read (via the already
// production-exported getSanityClient()) per section to resolve a real
// `category` document _id for realism — this is a read, never a write,
// and getSanityClient() itself is unmodified, existing production code.
// If that lookup fails for any reason, categoryDocId is simply omitted
// (see assemblePublishDocument's documented behavior for that case).
// ---------------------------------------------------------------------------

type HarnessTopicInput = {
  title: string;
  snippet?: string;
  section?: string;
  verdict?: string;
  subjectTag?: string;
  [key: string]: unknown;
};

type HarnessFact = { field: string; value: string; source: string; sourceUrl?: string };

type HarnessSourceGatheringResult = {
  topic: HarnessTopicInput;
  facts: HarnessFact[];
  primarySourceFound: boolean;
  factCount: number;
};

function extractEntity(sourcing: HarnessSourceGatheringResult): string | undefined {
  const venueFact = sourcing.facts.find((f) => f.field === 'venueName');
  if (venueFact) return venueFact.value;
  return sourcing.topic.subjectTag;
}

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
    console.warn(`[publish-assembly] category lookup failed for section="${section}" (read-only; assembling without a category ref):`, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function runTestHarness(): Promise<void> {
  const { writeArticle } = await import('./articleWriter');
  const { evaluateSufficiency } = await import('./sufficiencyGate');
  const { verifyArticle } = await import('./verificationGate');
  const { sourceImage } = await import('./imageSourcing');

  type Case = { label: string; topic: HarnessTopicInput; sourcing: HarnessSourceGatheringResult };

  const cases: Case[] = [
    {
      label: 'TEST 1: WordCamp US 2026 (rich facts, section=news)',
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
      label: 'TEST 2: Sunday Yoga (thin facts, section=health-wellness)',
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
      label: 'TEST 3: Rare Meteor Shower (national-reframe, section=news)',
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
      label: 'TEST 4: Trivia Night (conflicting facts, section=nightlife)',
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

  console.log('[publish-assembly] ========== TEST HARNESS start ==========');

  const summary: { label: string; result: AssemblyResult }[] = [];
  let lastGoodArticle: WrittenArticleInput | null = null;
  let lastGoodTopic: TopicMetadataInput | null = null;
  let lastGoodImage: ImageResultInput = null;

  for (const c of cases) {
    console.log(`\n\n=== ${c.label} ===`);
    const sufficiency = evaluateSufficiency(c.sourcing);
    const article = await writeArticle(c.topic, c.sourcing, sufficiency);
    if (!article) {
      console.log('(no article written — decision was skip; nothing to assemble)');
      continue;
    }

    const verification = await verifyArticle(article, c.sourcing.facts);
    console.log(`Stage 6: passed=${verification.passed}, prose=${verification.proseCheck.score}/10`);

    const entity = extractEntity(c.sourcing);
    const imageOutcome = await sourceImage({
      tags: article.tags,
      section: c.topic.section || 'news',
      entity,
      title: article.title,
    });
    const image = imageOutcome.status === 'ok' ? imageOutcome.result : null;
    console.log(`Stage 7: ${imageOutcome.status}${image ? ` — photographer="${image.photographerName}"` : ''}`);

    const categoryDocId = await resolveCategoryDocId(c.topic.section || 'news');
    console.log(`Category doc lookup for section="${c.topic.section}": ${categoryDocId ? categoryDocId : '(not found — assembling without a category ref)'}`);

    const result = assemblePublishDocument(
      article,
      verification,
      image,
      { ...c.topic, section: c.topic.section || 'news' },
      categoryDocId
    );
    summary.push({ label: c.label, result });
    lastGoodArticle = article;
    lastGoodTopic = { ...c.topic, section: c.topic.section || 'news' };
    lastGoodImage = image;

    console.log('\nStage 8 assembled result:');
    console.log(JSON.stringify(result, null, 2));
  }

  // --- Synthetic negative-path tests — neither real fixture happened to
  // fail Stage 6 or carry an invalid section, so these prove the two
  // refusal paths the build spec explicitly requires, using the last real
  // article/image as a realistic base with one field deliberately broken. ---
  if (lastGoodArticle && lastGoodTopic) {
    console.log('\n\n=== SYNTHETIC: Stage 6 verification failed → must refuse to assemble ===');
    const failedVerification: VerificationInput = {
      passed: false,
      mechanicalCheck: { phantomFactCount: 1, phantomSourceCount: 0 },
      proseCheck: { score: 0, reason: 'Not evaluated — mechanical check failed, no OpenAI call made.' },
      overallReason: 'FAILED mechanical check: 1 phantom fact(s), 0 phantom source(s) — draft claimed something it can\'t support.',
    };
    const failedResult = assemblePublishDocument(lastGoodArticle, failedVerification, lastGoodImage, lastGoodTopic);
    summary.push({ label: 'SYNTHETIC: verification failed', result: failedResult });
    console.log(JSON.stringify(failedResult, null, 2));

    console.log('\n\n=== SYNTHETIC: invalid section → must refuse to assemble ===');
    const passedVerification: VerificationInput = {
      passed: true,
      mechanicalCheck: { phantomFactCount: 0, phantomSourceCount: 0 },
      proseCheck: { score: 9, reason: 'Fine.' },
      overallReason: 'PASSED',
    };
    const invalidSectionTopic: TopicMetadataInput = { ...lastGoodTopic, section: 'lifestyle' };
    const invalidSectionResult = assemblePublishDocument(lastGoodArticle, passedVerification, lastGoodImage, invalidSectionTopic);
    summary.push({ label: 'SYNTHETIC: invalid section ("lifestyle")', result: invalidSectionResult });
    console.log(JSON.stringify(invalidSectionResult, null, 2));
  }

  console.log('\n\n########## PUBLISH ASSEMBLY TEST HARNESS SUMMARY ##########');
  for (const { label, result } of summary) {
    if (result.publishReady) {
      const doc = result.document as Record<string, unknown>;
      console.log(`${label} → publishReady=true, section=${doc.section}, categories=${JSON.stringify(doc.categories)}, category ref=${doc.category ? 'yes' : 'no'}, heroImageSource=${doc.heroImageSource ? 'yes' : 'no'}`);
    } else {
      console.log(`${label} → publishReady=false — ${result.reason}`);
    }
  }
  console.log('[publish-assembly] ========== TEST HARNESS end ==========');
}

if (require.main === module) {
  runTestHarness().catch((err) => {
    console.error('[publish-assembly] Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

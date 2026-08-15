/**
 * Stage 4 — Fact Sufficiency Gate (pipeline-redesign-architecture.md).
 *
 * PURE LOGIC MODULE. No network calls, no OpenAI, no SerpAPI, no Sanity —
 * this file imports nothing beyond the TypeScript standard library. Input
 * is the exact shape src/agents/sourceGathering.ts's gatherSources()
 * produces; this file does NOT import from sourceGathering.ts (or any
 * production file) — the shape is redefined locally so this module stays
 * fully standalone and decoupled, consistent with every other shadow
 * module built this session. Run directly (`ts-node
 * src/agents/sufficiencyGate.ts`) to execute the 6 hand-written fixtures
 * below; nothing here is wired into topicDiscovery.ts, sourceGathering.ts,
 * or any publish flow.
 *
 * Decision rule is a concrete, named-constant threshold (not a vibes
 * check) precisely because Stage 1's original locality-only gate made
 * that mistake once already (see the crime/tragedy keyword-gate
 * investigation earlier this session) — a sufficiency decision this
 * consequential (does an article get written at all, and at what length)
 * needs to be inspectable and tunable, not implicit in scattered logic.
 */

// ---------------------------------------------------------------------------
// Input shape — mirrors src/agents/sourceGathering.ts's SourceGatheringResult
// exactly, redefined locally (not imported; see file header).
// ---------------------------------------------------------------------------

export type Fact = {
  field: string;
  value: string;
  source: string;
  sourceUrl?: string;
};

export type TopicInput = {
  title: string;
  [key: string]: unknown;
};

export type SourceGatheringResult = {
  topic: TopicInput;
  facts: Fact[];
  primarySourceFound: boolean;
  factCount: number;
};

// ---------------------------------------------------------------------------
// Decision thresholds — named constants, tune here, not in the logic below.
// ---------------------------------------------------------------------------

/** Distinct qualifying fact fields required (with both core fields present) for 'full-article'. */
const MIN_FACTS_FULL_ARTICLE = 4;
/** Distinct qualifying fact fields required for 'blurb' (anything at or above this, below full-article's bar, is a blurb). */
const MIN_FACTS_BLURB = 1;

/**
 * "WHAT" core field candidates — identifies the entity/venue the topic is
 * about. Currently just the events checker's field name; a future
 * category checker (cannabis, food, etc.) would add its own WHAT-field
 * name(s) here rather than this module inventing category-specific logic.
 */
const WHAT_FIELDS = ['venueName'];
/** "WHEN" core field candidates — either satisfies the WHEN requirement. */
const WHEN_FIELDS = ['date', 'time'];

/**
 * ADDITIONAL full-article path, independent of the event-field
 * (WHAT/WHEN) check above — for sourceGathering.ts's general-purpose
 * default checker (gatherDefaultSources), whose output has no
 * venueName/date/time at all, just a single long-form sourceArticleText
 * fact. A substantial real source article is its own sufficient basis for
 * a full-article decision; it doesn't need to look like an event.
 *
 * Not raw character count alone — a long block of short, punctuation-less
 * nav-link fragments can be just as long as real prose (this file doesn't
 * import sourceGathering.ts's fetchVenuePageText fix, but applies the same
 * lesson: requires a minimum number of actual sentence-shaped chunks, not
 * just total length).
 */
const SOURCE_ARTICLE_TEXT_FIELD = 'sourceArticleText';
const MIN_SOURCE_ARTICLE_TEXT_CHARS = 800;
const MIN_SOURCE_ARTICLE_SUBSTANTIAL_SENTENCES = 5;
const MIN_SUBSTANTIAL_SENTENCE_CHARS = 40;
/** See sourceGathering.ts's identical constant/comment — a long run of nav-link labels with one incidental period can otherwise pass as one long "sentence." */
const MAX_SUBSTANTIAL_SENTENCE_CHARS = 300;
const MIN_PROSE_STOPWORD_RATIO = 0.2;
const PROSE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'was', 'are', 'were', 'that', 'this', 'for',
  'on', 'at', 'from', 'by', 'with', 'as', 'it', 'its', 'be', 'has', 'have', 'had', 'will',
  'would', 'can', 'could', 'not', 'but', 'or', 'if', 'than', 'so', 'which', 'who', 'what',
  'when', 'where', 'how', 'your', 'our', 'their', 'his', 'her',
]);

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type FormatDecision = 'full-article' | 'blurb' | 'skip';

export type FactConflict = {
  field: string;
  /** Every disagreeing value for this field, each with its own source — never auto-resolved here. */
  values: { value: string; source: string; sourceUrl?: string }[];
};

export type SufficiencyResult = {
  decision: FormatDecision;
  /** Distinct field names with at least one valid (non-empty value + named source) fact — NOT the same as raw factCount, which can overcount (duplicate fields) or undercount validity (malformed facts). */
  qualifyingFactCount: number;
  hasCoreWhat: boolean;
  hasCoreWhen: boolean;
  /** Fields where two+ valid facts disagree on value — flagged, never silently resolved. See file header / CONFLICT POLICY below. */
  conflicts: FactConflict[];
  /** Raw facts discarded for having an empty value or no source — see isValidFact. */
  disqualifiedFactCount: number;
  disqualifiedFields: string[];
  reasoning: string;
};

// ---------------------------------------------------------------------------
// CONFLICT POLICY (Stage 4 fixture 4's explicit design question):
//
// When two+ valid facts share a field name but disagree on value (e.g. two
// different prices from SerpAPI vs. the venue page), this module does NOT
// average them (meaningless for most field types — averaging two dates or
// two free-text prices produces garbage) and does NOT silently prefer one
// source over the other (that would hide a real discrepancy from whatever
// writes the article). Instead: the field still counts toward
// qualifyingFactCount (real, sourced information exists for it — treating
// it as absent would be worse than treating it as disputed), but it is
// recorded in the `conflicts` array with every value + its source intact.
// This is a "flag for a later step" policy: Stage 5/6 (or a human editor)
// must look at `conflicts` before treating that field's value as settled.
// A conflicted field can still contribute to a 'full-article' decision,
// but the article must not silently print one of the disputed values as
// fact without resolving or attributing it.
// ---------------------------------------------------------------------------

function isValidFact(fact: Fact): boolean {
  return (
    typeof fact.value === 'string' &&
    fact.value.trim().length > 0 &&
    typeof fact.source === 'string' &&
    fact.source.trim().length > 0
  );
}

function groupByField(facts: Fact[]): Map<string, Fact[]> {
  const byField = new Map<string, Fact[]>();
  for (const f of facts) {
    const list = byField.get(f.field);
    if (list) list.push(f);
    else byField.set(f.field, [f]);
  }
  return byField;
}

function detectConflicts(byField: Map<string, Fact[]>): FactConflict[] {
  const conflicts: FactConflict[] = [];
  for (const [field, factsForField] of byField) {
    const distinctValues = new Set(factsForField.map((f) => f.value.trim()));
    if (distinctValues.size > 1) {
      conflicts.push({
        field,
        values: factsForField.map((f) => ({ value: f.value, source: f.source, sourceUrl: f.sourceUrl })),
      });
    }
  }
  return conflicts;
}

function looksLikeProseSentence(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (trimmed.length < MIN_SUBSTANTIAL_SENTENCE_CHARS || trimmed.length > MAX_SUBSTANTIAL_SENTENCE_CHARS) {
    return false;
  }
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const stopwordCount = words.filter((w) => PROSE_STOPWORDS.has(w.replace(/[^a-z]/g, ''))).length;
  return stopwordCount / words.length >= MIN_PROSE_STOPWORD_RATIO;
}

function countSubstantialSentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(looksLikeProseSentence).length;
}

/** True when a valid sourceArticleText fact exists with enough real length AND enough sentence-shaped content — see the constant block above for why length alone isn't used. */
function hasSubstantialSourceArticleText(validFacts: Fact[]): boolean {
  const fact = validFacts.find((f) => f.field === SOURCE_ARTICLE_TEXT_FIELD);
  if (!fact) return false;
  if (fact.value.length < MIN_SOURCE_ARTICLE_TEXT_CHARS) return false;
  return countSubstantialSentences(fact.value) >= MIN_SOURCE_ARTICLE_SUBSTANTIAL_SENTENCES;
}

function decideFormat(
  qualifyingFactCount: number,
  hasCoreWhat: boolean,
  hasCoreWhen: boolean,
  hasSubstantialSourceText: boolean
): FormatDecision {
  if (qualifyingFactCount >= MIN_FACTS_FULL_ARTICLE && hasCoreWhat && hasCoreWhen) {
    return 'full-article';
  }
  if (hasSubstantialSourceText) {
    return 'full-article';
  }
  if (qualifyingFactCount >= MIN_FACTS_BLURB) {
    return 'blurb';
  }
  return 'skip';
}

function buildReasoning(params: {
  decision: FormatDecision;
  qualifyingFactCount: number;
  qualifyingFields: string[];
  hasCoreWhat: boolean;
  hasCoreWhen: boolean;
  hasSubstantialSourceText: boolean;
  conflicts: FactConflict[];
  disqualifiedFields: string[];
  primarySourceFound: boolean;
}): string {
  const { decision, qualifyingFactCount, qualifyingFields, hasCoreWhat, hasCoreWhen, hasSubstantialSourceText, conflicts, disqualifiedFields, primarySourceFound } = params;
  const parts: string[] = [];

  parts.push(
    `${qualifyingFactCount} distinct qualifying field(s)${qualifyingFields.length ? ` [${qualifyingFields.join(', ')}]` : ''}.`
  );
  parts.push(
    `Core WHAT (${WHAT_FIELDS.join('/')}): ${hasCoreWhat ? 'present' : 'MISSING'}. Core WHEN (${WHEN_FIELDS.join('/')}): ${hasCoreWhen ? 'present' : 'MISSING'}.`
  );
  parts.push(
    `Substantial sourceArticleText (>=${MIN_SOURCE_ARTICLE_TEXT_CHARS} chars, >=${MIN_SOURCE_ARTICLE_SUBSTANTIAL_SENTENCES} real sentences): ${hasSubstantialSourceText ? 'present' : 'absent'}.`
  );
  if (disqualifiedFields.length > 0) {
    parts.push(`${disqualifiedFields.length} raw fact(s) discarded as malformed (empty value or no source): ${disqualifiedFields.join(', ')} — not counted toward the total.`);
  }
  if (conflicts.length > 0) {
    for (const c of conflicts) {
      parts.push(
        `⚠ CONFLICT on "${c.field}": ${c.values.map((v) => `"${v.value}" (${v.source})`).join(' vs. ')} — field still counts as qualifying, but not auto-resolved; flagged for a later editor/Stage 6 step.`
      );
    }
  }
  if (!primarySourceFound) {
    parts.push('primarySourceFound=false (SerpAPI-only or nothing fetched) — did not by itself force a skip; only the qualifying-field count did.');
  }

  switch (decision) {
    case 'full-article':
      if (qualifyingFactCount >= MIN_FACTS_FULL_ARTICLE && hasCoreWhat && hasCoreWhen) {
        parts.push(
          `→ full-article: meets MIN_FACTS_FULL_ARTICLE=${MIN_FACTS_FULL_ARTICLE} with both core fields present.`
        );
      } else {
        parts.push(
          `→ full-article: substantial sourceArticleText fact present — sufficient on its own, independent of the event WHAT/WHEN fields (which don't apply to this topic shape).`
        );
      }
      break;
    case 'blurb':
      if (qualifyingFactCount >= MIN_FACTS_FULL_ARTICLE) {
        parts.push(
          `→ blurb: ${qualifyingFactCount} fields meets the full-article count, but a core field is missing, which overrides count alone.`
        );
      } else {
        parts.push(
          `→ blurb: ${qualifyingFactCount} qualifying field(s) meets MIN_FACTS_BLURB=${MIN_FACTS_BLURB} but below MIN_FACTS_FULL_ARTICLE=${MIN_FACTS_FULL_ARTICLE}.`
        );
      }
      break;
    case 'skip':
      parts.push(`→ skip: 0 qualifying fields after discarding malformed facts — nothing usable to write from.`);
      break;
  }

  return parts.join(' ');
}

/**
 * Stage 4 entry point. Pure function, no I/O.
 */
export function evaluateSufficiency(result: SourceGatheringResult): SufficiencyResult {
  const validFacts = result.facts.filter(isValidFact);
  const disqualified = result.facts.filter((f) => !isValidFact(f));
  const disqualifiedFields = disqualified.map((f) => f.field || '(no field name)');

  const byField = groupByField(validFacts);
  const qualifyingFields = [...byField.keys()];
  const qualifyingFactCount = qualifyingFields.length;

  const hasCoreWhat = WHAT_FIELDS.some((f) => byField.has(f));
  const hasCoreWhen = WHEN_FIELDS.some((f) => byField.has(f));
  const hasSubstantialSourceText = hasSubstantialSourceArticleText(validFacts);
  const conflicts = detectConflicts(byField);

  const decision = decideFormat(qualifyingFactCount, hasCoreWhat, hasCoreWhen, hasSubstantialSourceText);

  const reasoning = buildReasoning({
    decision,
    qualifyingFactCount,
    qualifyingFields,
    hasCoreWhat,
    hasCoreWhen,
    hasSubstantialSourceText,
    conflicts,
    disqualifiedFields,
    primarySourceFound: result.primarySourceFound,
  });

  return {
    decision,
    qualifyingFactCount,
    hasCoreWhat,
    hasCoreWhen,
    conflicts,
    disqualifiedFactCount: disqualified.length,
    disqualifiedFields,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures — hand-written, no network calls, no dependency on a real
// gatherSources() run. Field names/shapes mirror what
// src/agents/sourceGathering.ts's events checker actually produces.
// ---------------------------------------------------------------------------

type Fixture = { label: string; input: SourceGatheringResult };

const FIXTURES: Fixture[] = [
  {
    label: '1. Rich (WordCamp-like: well-documented conference, 7 real facts, primarySourceFound=true)',
    input: {
      topic: { title: 'WordCamp US 2026', section: 'news', subjectTag: 'conference' },
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
    label: '2. Moderate (3 facts, both core fields present, no venue-page fetch)',
    input: {
      topic: { title: 'Steel Pulse with Eli-Mac', section: 'nightlife', subjectTag: 'concert' },
      facts: [
        { field: 'venueName', value: 'The Van Buren', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
        { field: 'date', value: '2026-08-13', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
        { field: 'ticketUrl', value: 'https://thevanburen.com/events/steel-pulse', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/steelpulse' },
      ],
      primarySourceFound: false,
      factCount: 3,
    },
  },
  {
    label: '3. Thin (Sunday Yoga-like: name only, no confirmed date/time — missing WHEN)',
    input: {
      topic: { title: 'Sunday Yoga', section: 'health-wellness', subjectTag: 'yoga class' },
      facts: [
        { field: 'venueName', value: 'Kähvi Coffee + Cafe', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/sundayyoga' },
      ],
      primarySourceFound: false,
      factCount: 1,
    },
  },
  {
    label: '4. Conflicting (two different price figures for the same field, from different sources)',
    input: {
      topic: { title: 'Trivia Night at Arizona Wilderness Brewing Co.', section: 'nightlife', subjectTag: 'trivia' },
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
  {
    label: '5. Empty (no SerpAPI match, nothing fetched)',
    input: {
      topic: { title: 'Untitled Local Meetup', section: 'news', subjectTag: 'meetup' },
      facts: [],
      primarySourceFound: false,
      factCount: 0,
    },
  },
  {
    label: '6. Malformed (empty value on one fact, missing source on another — neither should count)',
    input: {
      topic: { title: 'Mesa International Film Festival', section: 'news', subjectTag: 'film festival' },
      facts: [
        { field: 'venueName', value: '', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/mesafilm' },
        { field: 'date', value: '2026-08-12', source: '' },
        { field: 'description', value: 'Annual film festival screening independent films across Mesa venues.', source: 'SerpAPI Events', sourceUrl: 'https://serpapi.example/mesafilm' },
      ],
      primarySourceFound: true,
      factCount: 3,
    },
  },
];

function runFixtures(): void {
  console.log('[sufficiency-gate] ========== FIXTURE RUN start ==========');
  console.log(`[sufficiency-gate] Thresholds: MIN_FACTS_FULL_ARTICLE=${MIN_FACTS_FULL_ARTICLE}, MIN_FACTS_BLURB=${MIN_FACTS_BLURB}, WHAT_FIELDS=[${WHAT_FIELDS.join(', ')}], WHEN_FIELDS=[${WHEN_FIELDS.join(', ')}]`);

  for (const fixture of FIXTURES) {
    console.log(`\n\n--- ${fixture.label} ---`);
    console.log('Input:');
    console.log(JSON.stringify(fixture.input, null, 2));

    const result = evaluateSufficiency(fixture.input);

    console.log(`\nDecision: ${result.decision.toUpperCase()}`);
    console.log(`Reasoning: ${result.reasoning}`);
    console.log(
      `Summary: qualifyingFactCount=${result.qualifyingFactCount}, hasCoreWhat=${result.hasCoreWhat}, hasCoreWhen=${result.hasCoreWhen}, conflicts=${result.conflicts.length}, disqualifiedFacts=${result.disqualifiedFactCount}`
    );
  }

  console.log('\n\n########## SUFFICIENCY GATE FIXTURE SUMMARY ##########');
  for (const fixture of FIXTURES) {
    const result = evaluateSufficiency(fixture.input);
    console.log(`${fixture.label.split('(')[0]!.trim()} → ${result.decision.toUpperCase()} (${result.qualifyingFactCount} qualifying field(s), ${result.conflicts.length} conflict(s), ${result.disqualifiedFactCount} discarded)`);
  }
  console.log('\n[sufficiency-gate] ========== FIXTURE RUN end ==========');
}

if (require.main === module) {
  runFixtures();
}

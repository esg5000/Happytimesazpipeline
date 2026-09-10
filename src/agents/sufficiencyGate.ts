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
  /** Mirrors sourceGathering.ts's SourceGatheringResult.sourceArticleTextSubstantial — see that file for the full comment. Only meaningful alongside a 'sourceArticleText' fact; false means Stage 3 itself only trusted this as a thin last-resort fallback, not real substantial content. */
  sourceArticleTextSubstantial?: boolean;
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
 * ONE narrow, additive exception to the venue+date "Core WHAT/WHEN" path
 * above — business/deal news (confirmed real case: "JARS Cannabis Acquires
 * Sonoran Roots to Create Arizona's Largest Retail Network", a real
 * PRNewswire acquisition release covered by 7+ outlets, rich detail —
 * confirmed substantial by direct web research). An acquisition story has
 * no venue and no event-shaped date, so it structurally can never satisfy
 * WHAT_FIELDS/WHEN_FIELDS, even when it's clearly substantial enough to
 * write from. This does NOT replace or restructure the venue+date path —
 * it is checked only as an additional way to reach 'full-article', exactly
 * parallel to hasSubstantialSourceArticleText above. Deliberately NOT
 * generalized to other topic shapes (science reporting, roundups/
 * listicles) that showed similar sufficiency-gate friction — those are
 * left as-is for a future pass if/when they recur.
 *
 * Classification signal: an acquisition/merger keyword in the title. Title
 * phrasing for these press-release-style stories is consistently
 * "<Company A> Acquires/Buys/Merges with <Company B> ...", which both
 * flags the story as business/deal-shaped AND (via ENTITY_TITLE_RE below)
 * is the same regex that extracts the two entities — deliberately not
 * gated on topic.section, since acquisition stories can land in 'cannabis'
 * (the confirmed case), 'food', 'nightlife', or 'news' depending on the
 * industry, and section alone is too broad/narrow a signal either way.
 */
const BUSINESS_DEAL_KEYWORD_RE =
  /\b(acquir(?:es?|ing|ed)|acquisition|to acquire|merge[sd]?|merger|buys|buyout|purchases?)\b/i;
/**
 * Captures (primary/acquiring entity, secondary/acquired entity) out of a
 * title shaped like "<A> Acquires <B> to <verb> ..." or "<A> to Acquire
 * <B> ..." or "<A> Merges with <B> ...". Non-greedy secondary-entity
 * capture stops at the first " to "/" for "/comma, which is where these
 * headlines pivot into the "why" clause (e.g. "... Sonoran Roots to
 * Create Arizona's Largest Retail Network" correctly yields "Sonoran
 * Roots", not the whole tail).
 */
const ENTITY_TITLE_RE =
  /^(.+?)\s+(?:acquires?|to\s+acquire|announces?\s+(?:the\s+)?acquisition\s+of|buys|purchases?|merges?\s+with)\s+(.+?)(?:\s+to\b|\s+for\b|,|$)/i;
/**
 * At least one concrete, checkable deal detail — a dollar figure, a
 * store/location count, a completion timeline, or a named executive
 * change. This is what separates a real acquisition story (JARS/Sonoran
 * Roots: "27-store combined network", "8 Ponderosa locations", "expected
 * Q3 2026 closing", CEO quotes) from a thin, merely business-sounding
 * headline with nothing behind it — the latter must still fail this path.
 */
const DEAL_DETAIL_RE =
  /\$[\d,.]+\s*(?:million|billion|[MB])?\b|\b\d+[\s-]*(?:stores?|locations?|outlets?|dispensar(?:y|ies))\b|\bQ[1-4]\s*20\d{2}\b|\bexpected\s+to\s+close\b|\b(?:CEO|CFO|president|chairman|co-founder)\b[^.]{0,60}\b(?:said|says|will|named|appointed|to lead)\b/i;

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

/**
 * Content-quality floor for sourceArticleText at the 'blurb' tier — see
 * hasSubstantialSourceArticleText below for the (much higher) 'full-article'
 * bar, which this doesn't touch. Confirmed gap: a 2026-08-25 topic whose
 * only fact was mshale.com's own placeholder text ("No game recap available
 * from the provided source") passed the old blurb check trivially — any
 * non-empty value + a named source qualified, with no floor on whether the
 * text was actually about anything. 150 chars is well under
 * MIN_SOURCE_ARTICLE_TEXT_CHARS (800) — this only needs to reject one-line
 * placeholders, not demand full-article-length text for a blurb.
 */
const MIN_BLURB_SOURCE_TEXT_CHARS = 150;
/** Catches the placeholder/meta-statement pattern regardless of length (a padded error page could clear MIN_BLURB_SOURCE_TEXT_CHARS on boilerplate alone). Deliberately conservative — false negatives (an unrecognized phrasing) are expected and acceptable; this is one layer of defense-in-depth, not the only one (see sourceArticleTextSubstantial below). */
const META_UNAVAILABLE_RE =
  /\bno\s+(game\s+)?(recap|report|preview|article|coverage|content|summary)\s+(is\s+|was\s+)?available\b|\bcontent\s+(is\s+)?(currently\s+)?unavailable\b|\bno\s+(report|recap|article)\s+found\b|\bpage\s+not\s+found\b|\baccess\s+denied\b|\b404\s+error\b/i;
/**
 * Injected unconditionally by sourceGathering.ts's gatherDefaultSources
 * alongside every sourceArticleText fact (WRITING_GUIDANCE_FACT) — a fixed
 * editorial instruction, not real-world information about the topic. It
 * always has a non-empty value + a named source, so isValidFact alone
 * always counted it as qualifying — meaning even a fully-disqualified
 * sourceArticleText left qualifyingFactCount at 1 (this field alone),
 * still producing 'blurb'. Excluded here so disqualifying the content
 * fact actually changes the decision.
 */
const NON_INFORMATIONAL_FIELDS = new Set(['writingGuidance']);
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

/**
 * Content-quality gate — separate from isValidFact's structural check
 * (non-empty value + named source). A fact can be perfectly well-formed and
 * still not be real, usable information: a fixed editorial instruction
 * (writingGuidance) or a source page's own "no content available"
 * placeholder text (real bytes, real source, zero actual information).
 * Returns a human-readable reason when the fact should be excluded from
 * qualifyingFactCount, or undefined when it's fine.
 */
function disqualifyContentReason(fact: Fact, sourceArticleTextSubstantial: boolean | undefined): string | undefined {
  if (NON_INFORMATIONAL_FIELDS.has(fact.field)) {
    return 'editorial instruction, not real-world information about the topic — never counts toward qualifying facts';
  }
  if (fact.field === SOURCE_ARTICLE_TEXT_FIELD) {
    if (sourceArticleTextSubstantial === false) {
      return 'Stage 3 only trusted this as a thin last-resort fallback (sourceArticleTextSubstantial=false), not substantial content';
    }
    const value = fact.value.trim();
    if (value.length < MIN_BLURB_SOURCE_TEXT_CHARS) {
      return `below the ${MIN_BLURB_SOURCE_TEXT_CHARS}-char blurb-eligible floor (${value.length} chars)`;
    }
    if (META_UNAVAILABLE_RE.test(value)) {
      return 'matches a known "no content available" meta-statement pattern';
    }
  }
  return undefined;
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

/**
 * Per-domain override of the full-article substantiality bar — scoped
 * narrowly to mouthbysouthwest.com. Its house style is short punchy
 * mini-reviews (confirmed real example: 605 chars, 2 measured substantial
 * sentences — genuinely useful, specific content that will still rarely
 * reach MIN_SOURCE_ARTICLE_TEXT_CHARS/SENTENCES's full-article bar even
 * with this override, and that's the correct outcome: this content depth
 * should land as 'blurb', not be inflated into 'full-article' treatment).
 * This override exists so a longer-than-usual mouthbysouthwest piece isn't
 * needlessly capped at 'blurb' purely for being from this domain. See
 * sourceGathering.ts's matching DOMAIN_PROSE_OVERRIDES — that's the gate
 * that actually determines whether this fact survives to be checked here
 * at all (sourceArticleTextSubstantial=false disqualifies it entirely,
 * upstream of this function).
 */
const DOMAIN_SUFFICIENCY_OVERRIDES: Record<string, { minChars: number; minSentences: number }> = {
  'mouthbysouthwest.com': { minChars: 400, minSentences: 3 },
};

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when a valid sourceArticleText fact exists with enough real length AND enough sentence-shaped content — see the constant block above for why length alone isn't used. */
function hasSubstantialSourceArticleText(validFacts: Fact[]): boolean {
  const fact = validFacts.find((f) => f.field === SOURCE_ARTICLE_TEXT_FIELD);
  if (!fact) return false;
  const host = hostnameOf(fact.sourceUrl);
  const override = host ? DOMAIN_SUFFICIENCY_OVERRIDES[host] : undefined;
  const minChars = override?.minChars ?? MIN_SOURCE_ARTICLE_TEXT_CHARS;
  const minSentences = override?.minSentences ?? MIN_SOURCE_ARTICLE_SUBSTANTIAL_SENTENCES;
  if (fact.value.length < minChars) return false;
  return countSubstantialSentences(fact.value) >= minSentences;
}

/** Result of the business/deal exception check — see BUSINESS_DEAL_KEYWORD_RE above. */
type BusinessDealCheck = {
  qualifies: boolean;
  isBusinessDealShaped: boolean;
  primaryEntity?: string;
  secondaryEntity?: string;
  hasDealDetail: boolean;
};

/**
 * The one additive exception path itself. Only even attempts extraction
 * when the title matches BUSINESS_DEAL_KEYWORD_RE (classification signal);
 * otherwise returns immediately so this never affects any non-business-deal
 * topic. Searches title + every valid fact's value + topic.searchSummaries
 * (Stage 1's web_search snippets from the other outlets covering the same
 * story) for the deal-detail signal — deliberately broader than just the
 * Stage 3 sourceArticleText fact, since a real multi-outlet story (JARS/
 * Sonoran Roots: 7+ outlets) often has the concrete detail sitting in a
 * search snippet even when the one page Stage 3 fetched came back thin.
 */
function checkBusinessDealPath(topic: TopicInput, validFacts: Fact[]): BusinessDealCheck {
  const title = typeof topic.title === 'string' ? topic.title : '';
  const isBusinessDealShaped = BUSINESS_DEAL_KEYWORD_RE.test(title);
  if (!isBusinessDealShaped) {
    return { qualifies: false, isBusinessDealShaped: false, hasDealDetail: false };
  }

  const titleMatch = title.match(ENTITY_TITLE_RE);
  const primaryEntity = titleMatch?.[1]?.trim();
  const secondaryEntity = titleMatch?.[2]?.trim();

  const searchSummaries = Array.isArray(topic.searchSummaries)
    ? (topic.searchSummaries as { title?: string; summary?: string }[])
    : [];
  const corpus = [
    title,
    ...validFacts.map((f) => f.value),
    ...searchSummaries.map((s) => `${s.title ?? ''} ${s.summary ?? ''}`),
  ].join('\n');
  const hasDealDetail = DEAL_DETAIL_RE.test(corpus);

  const qualifies = Boolean(primaryEntity) && Boolean(secondaryEntity) && hasDealDetail;
  return { qualifies, isBusinessDealShaped: true, primaryEntity, secondaryEntity, hasDealDetail };
}

function decideFormat(
  qualifyingFactCount: number,
  hasCoreWhat: boolean,
  hasCoreWhen: boolean,
  hasSubstantialSourceText: boolean,
  hasBusinessDealSufficiency: boolean
): FormatDecision {
  if (qualifyingFactCount >= MIN_FACTS_FULL_ARTICLE && hasCoreWhat && hasCoreWhen) {
    return 'full-article';
  }
  if (hasSubstantialSourceText) {
    return 'full-article';
  }
  if (hasBusinessDealSufficiency) {
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
  businessDeal: BusinessDealCheck;
  conflicts: FactConflict[];
  disqualifiedFields: string[];
  primarySourceFound: boolean;
}): string {
  const { decision, qualifyingFactCount, qualifyingFields, hasCoreWhat, hasCoreWhen, hasSubstantialSourceText, businessDeal, conflicts, disqualifiedFields, primarySourceFound } = params;
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
  if (businessDeal.isBusinessDealShaped) {
    parts.push(
      `Business/deal exception: title matched acquisition/merger keyword — primary entity: ${businessDeal.primaryEntity ?? 'MISSING'}, secondary entity: ${businessDeal.secondaryEntity ?? 'MISSING'}, concrete deal detail (dollar/store-count/timeline/exec-change): ${businessDeal.hasDealDetail ? 'present' : 'absent'} → ${businessDeal.qualifies ? 'QUALIFIES via business/deal path' : 'does not qualify via business/deal path'}.`
    );
  }
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
      } else if (hasSubstantialSourceText) {
        parts.push(
          `→ full-article: substantial sourceArticleText fact present — sufficient on its own, independent of the event WHAT/WHEN fields (which don't apply to this topic shape).`
        );
      } else {
        parts.push(
          `→ full-article: business/deal exception — primary entity + secondary entity + a concrete deal detail are sufficient on their own for this topic shape, independent of the event WHAT/WHEN fields (which don't apply to an acquisition story).`
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
  const structurallyValid = result.facts.filter(isValidFact);
  const structurallyInvalid = result.facts.filter((f) => !isValidFact(f));

  // Second pass, content-quality — see disqualifyContentReason. Runs only
  // over facts that already passed the structural check above; a fact
  // disqualified here is content-worthless (editorial instruction, or a
  // source placeholder), not malformed, but is folded into the same
  // disqualified bucket since either way it must not count toward
  // qualifyingFactCount.
  const validFacts: Fact[] = [];
  const contentDisqualifiedFields: string[] = [];
  for (const f of structurallyValid) {
    const reason = disqualifyContentReason(f, result.sourceArticleTextSubstantial);
    if (reason) {
      contentDisqualifiedFields.push(`${f.field} (${reason})`);
    } else {
      validFacts.push(f);
    }
  }

  const disqualifiedFields = [
    ...structurallyInvalid.map((f) => f.field || '(no field name)'),
    ...contentDisqualifiedFields,
  ];

  const byField = groupByField(validFacts);
  const qualifyingFields = [...byField.keys()];
  const qualifyingFactCount = qualifyingFields.length;

  const hasCoreWhat = WHAT_FIELDS.some((f) => byField.has(f));
  const hasCoreWhen = WHEN_FIELDS.some((f) => byField.has(f));
  const hasSubstantialSourceText = hasSubstantialSourceArticleText(validFacts);
  const businessDeal = checkBusinessDealPath(result.topic, validFacts);
  const conflicts = detectConflicts(byField);

  const decision = decideFormat(qualifyingFactCount, hasCoreWhat, hasCoreWhen, hasSubstantialSourceText, businessDeal.qualifies);

  const reasoning = buildReasoning({
    decision,
    qualifyingFactCount,
    qualifyingFields,
    hasCoreWhat,
    hasCoreWhen,
    hasSubstantialSourceText,
    businessDeal,
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
    disqualifiedFactCount: structurallyInvalid.length + contentDisqualifiedFields.length,
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
  {
    label: '7. Business/deal exception (JARS/Sonoran Roots acquisition — confirmed real case, no venue/date)',
    input: {
      topic: {
        title: "JARS Cannabis Acquires Sonoran Roots to Create Arizona's Largest Retail Network",
        section: 'cannabis',
        subjectTag: 'acquisition',
        searchSummaries: [
          {
            title: 'JARS Cannabis to acquire Sonoran Roots dispensaries',
            url: 'https://mjbizdaily.example/jars-sonoran-roots',
            summary:
              'The deal combines JARS Cannabis and Sonoran Roots into a 27-store network across Arizona, including 8 Ponderosa locations, with the transaction expected to close in Q3 2026.',
          },
        ],
      },
      facts: [
        {
          field: 'sourceArticleText',
          value:
            'JARS Cannabis announced Tuesday it will acquire Sonoran Roots, a move that creates the largest cannabis retail network in Arizona. The combined company will operate 27 stores statewide, including 8 former Ponderosa locations. "This acquisition strengthens our footprint across the Valley," said JARS Cannabis CEO in a statement. The deal is expected to close in Q3 2026 pending regulatory approval.',
          source: 'PRNewswire — HTTP fetch (https://prnewswire.example/jars-sonoran-roots)',
          sourceUrl: 'https://prnewswire.example/jars-sonoran-roots',
        },
        { field: 'writingGuidance', value: 'Write an original piece informed by this source material.', source: 'source-gathering (Stage 3 editorial instruction)' },
      ],
      primarySourceFound: true,
      factCount: 2,
      // Deliberately false — models the real failure: the fetched press-release
      // page came back thin/short, so Stage 3 didn't trust it as substantial,
      // which is exactly what made the venue+date AND the sourceArticleText
      // paths both fail before this exception existed.
      sourceArticleTextSubstantial: false,
    },
  },
  {
    label: '8. Thin/bad business news (title matches the acquisition keyword, but no real entities or deal detail — must still fail)',
    input: {
      topic: {
        title: 'Local Company Acquires Another Business',
        section: 'cannabis',
        subjectTag: 'business',
        searchSummaries: [],
      },
      facts: [
        {
          field: 'sourceArticleText',
          value:
            'A local company said it is acquiring another business. No further details, terms, or timeline were disclosed at this time.',
          source: 'example.com — HTTP fetch (https://example.com/vague-cannabis-news)',
          sourceUrl: 'https://example.com/vague-cannabis-news',
        },
        { field: 'writingGuidance', value: 'Write an original piece informed by this source material.', source: 'source-gathering (Stage 3 editorial instruction)' },
      ],
      primarySourceFound: true,
      factCount: 2,
      sourceArticleTextSubstantial: false,
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

import { defineField, defineType } from 'sanity';

/**
 * A Stage 0-2 discovery result persisted for human review, instead of
 * flowing straight into Stage 3-8 (runTopicThroughPipeline). Written by
 * discoverAndPersistTopics() in src/agents/orchestratorV2.ts — a parallel
 * path alongside (not a replacement for) runOrchestratorV2AndPublish's
 * existing automatic flow. Fields mirror topicDiscovery.ts's
 * TopicDiscoveryResult (the classification fields only; snippet/section/
 * verdict/etc — sourceOutlet and publishedDate are deliberately not
 * carried over here, out of scope for this document). searchSummaries'
 * URLs ARE carried over (as alternateSourceUrls, below) — Stage 3 fallback
 * source URLs for when the primary sourceUrl can't be fetched.
 */
export default defineType({
  name: 'topicCandidate',
  title: 'Topic Candidate',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'sourceUrl', type: 'url', validation: (r) => r.required() }),
    defineField({ name: 'snippet', type: 'text', rows: 3 }),
    defineField({ name: 'discoveredAt', type: 'datetime', validation: (r) => r.required() }),
    defineField({
      name: 'section',
      type: 'string',
      options: {
        list: ['food', 'nightlife', 'cannabis', 'health-wellness', 'sports', 'news'],
      },
    }),
    defineField({
      name: 'verdict',
      type: 'string',
      description: "Stage 1's locality verdict — mirrors topicDiscovery.ts's Stage1Verdict.",
      options: {
        list: ['direct-local', 'national-reframe', 'national-verify-local', 'national-skip'],
      },
    }),
    defineField({ name: 'relevanceScore', type: 'number' }),
    defineField({ name: 'subjectTag', type: 'string' }),
    defineField({ name: 'specificSubject', type: 'string' }),
    defineField({
      name: 'alternateSourceUrls',
      title: 'Alternate Source URLs',
      type: 'array',
      of: [{ type: 'url' }],
      description: 'Stage 1 web_search fallback URLs (title/summary text not persisted — only the URL, which is all Stage 3 ever reads). Read back by processSelectedTopics() and threaded into Stage 3 as searchSummaries so a dashboard-selected candidate has a real fallback if sourceUrl itself is unfetchable (bot-blocked, paywalled, redirect loop), the same as the automated pipeline already has.',
      readOnly: true,
    }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {
        list: [
          { title: 'Pending', value: 'pending' },
          { title: 'Selected', value: 'selected' },
          { title: 'Rejected', value: 'rejected' },
          { title: 'Processed', value: 'processed' },
        ],
        layout: 'radio',
      },
      initialValue: 'pending',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'processingNote',
      title: 'Processing Result',
      type: 'text',
      rows: 3,
      readOnly: true,
      description: 'Set by processSelectedTopics() when status flips to "processed" — what actually happened to this pick (published with a real Sanity id/slug, or the real drop reason from whichever gate caught it). Never left blank on a processed doc, so this is visible in Studio without needing the API response or server logs.',
    }),
    defineField({
      name: 'outcome',
      title: 'Outcome',
      type: 'string',
      readOnly: true,
      description: 'Set alongside status:"processed" by processSelectedTopics() — the same outcome enum returned in that API call\'s response, now persisted so "processed" can be told apart from an actual publish without reading processingNote\'s free text. Undefined for status "pending"/"rejected" docs (nothing to report yet).',
      options: {
        list: [
          { title: 'Published', value: 'published' },
          { title: 'Publish failed', value: 'publish-failed' },
          { title: 'Dropped — duplicate (Stage 9)', value: 'dropped-dedupe' },
          { title: 'Dropped — insufficient facts (Stage 4)', value: 'dropped-sufficiency' },
          { title: 'Dropped — writing failed (Stage 5)', value: 'dropped-writing' },
          { title: 'Dropped — verification failed (Stage 6)', value: 'dropped-verification' },
        ],
      },
    }),
    defineField({
      name: 'selectedPersona',
      title: 'Selected Persona',
      type: 'string',
      description: 'Set by the human reviewer at selection time — which writing persona to use when this candidate is later run through the write/publish pipeline. Values match src/agents/articleWriter.ts\'s ArticlePersona exactly (processSelectedTopics() reads this string directly) — update both together if the writer\'s persona set ever changes.',
      options: {
        list: [
          { title: 'Fat Jimmy (food/nightlife)', value: 'fat-jimmy' },
          { title: 'Sonny Blaze (cannabis)', value: 'sonny-blaze' },
          { title: 'The Health Nut (health-wellness)', value: 'health-nut' },
          { title: 'Stephen A. Spliff (sports)', value: 'stephen-a-spliff' },
          { title: 'Stephen A. Spliff — Unhinged (sports)', value: 'stephen-a-spliff-unhinged' },
          { title: 'Bill Farr (news)', value: 'bill-farr' },
          { title: 'Sloan Rivers (nightlife/events)', value: 'sloan-rivers' },
        ],
      },
    }),
    defineField({
      name: 'selectedStyle',
      title: 'Selected Style',
      type: 'string',
      description: 'Set by the human reviewer at selection time — which format/style to use when this candidate is later run through the write/publish pipeline. Values match src/agents/articleWriter.ts\'s ArticleStyle exactly (processSelectedTopics() reads this string directly) — update both together if the writer\'s style set ever changes.',
      options: {
        list: [
          { title: 'Straight Recap', value: 'straight-recap' },
          { title: 'Listicle', value: 'listicle' },
          { title: 'Opinion', value: 'opinion' },
        ],
      },
    }),
  ],
  preview: {
    select: { title: 'title', section: 'section', status: 'status', outcome: 'outcome' },
    prepare({ title, section, status, outcome }) {
      const statusLabel = status === 'processed' && outcome ? `processed — ${outcome}` : status || 'pending';
      return {
        title: title || '(untitled)',
        subtitle: `${section || 'no section'} — ${statusLabel}`,
      };
    },
  },
});

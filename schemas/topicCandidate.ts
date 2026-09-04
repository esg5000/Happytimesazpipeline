import { defineField, defineType } from 'sanity';

/**
 * A Stage 0-2 discovery result persisted for human review, instead of
 * flowing straight into Stage 3-8 (runTopicThroughPipeline). Written by
 * discoverAndPersistTopics() in src/agents/orchestratorV2.ts — a parallel
 * path alongside (not a replacement for) runOrchestratorV2AndPublish's
 * existing automatic flow. Fields mirror topicDiscovery.ts's
 * TopicDiscoveryResult (the classification fields only; snippet/section/
 * verdict/etc — sourceOutlet, publishedDate, and searchSummaries are
 * deliberately not carried over here, out of scope for this document).
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
      name: 'selectedPersona',
      title: 'Selected Persona',
      type: 'string',
      description: 'Set by the human reviewer at selection time — which writing persona to use when this candidate is later run through the write/publish pipeline.',
    }),
    defineField({
      name: 'selectedStyle',
      title: 'Selected Style',
      type: 'string',
      description: 'Set by the human reviewer at selection time — which visual/prose style to use when this candidate is later run through the write/publish pipeline.',
    }),
  ],
  preview: {
    select: { title: 'title', section: 'section', status: 'status' },
    prepare({ title, section, status }) {
      return {
        title: title || '(untitled)',
        subtitle: `${section || 'no section'} — ${status || 'pending'}`,
      };
    },
  },
});

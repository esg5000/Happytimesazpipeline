import { defineField, defineType } from 'sanity';

/**
 * One document per discoverTopics run, linked back to that run's syncRun doc.
 * Split out from syncRun (rather than added as a field there) so the syncRun
 * list — queried often by the dashboard — stays lean; this doc only exists to
 * be read when someone actually wants to eyeball a run's candidate pool.
 *
 * Replaces the local-only /tmp/happytimesaz-topic-discovery/*.json shadow log
 * (topicDiscovery.ts's writeShadowLog, still written as-is) with something
 * durable and queryable regardless of which host ran the job.
 */
export default defineType({
  name: 'topicDiscoveryDebugLog',
  title: 'Topic Discovery Debug Log',
  type: 'document',
  fields: [
    defineField({
      name: 'syncRun',
      type: 'reference',
      to: [{ type: 'syncRun' }],
      description: 'The discoverTopics syncRun doc this debug data belongs to.',
      validation: (r) => r.required(),
    }),
    defineField({ name: 'createdAt', type: 'datetime', validation: (r) => r.required() }),
    defineField({
      name: 'nearDedupedPool',
      type: 'array',
      description:
        'The full near-deduped, pre-cap Stage 0 pool (before the STAGE1_CANDIDATE_CAP recency cut) — the set Shawn wants to review by eye. Does NOT include the raw pre-dedupe pool (~1000-1500 items); only counts of that are recorded (see this run\'s syncRun.topicDiscoveryUsage).',
      of: [
        {
          type: 'object',
          fields: [
            defineField({ name: 'title', type: 'string' }),
            defineField({ name: 'link', type: 'url' }),
            defineField({ name: 'queryClass', type: 'string' }),
            defineField({ name: 'sourceOutlet', type: 'string' }),
            defineField({ name: 'publishedDate', type: 'datetime' }),
            defineField({
              name: 'possibleNearDupe',
              type: 'boolean',
              description:
                'OBSERVE-ONLY (topicDiscovery.ts\'s flagPossibleNearDupes) — shares a distinguishing title phrase + publish-time proximity with another pool item but fell under the Jaccard merge threshold, so it was NOT actually merged. For manual review only.',
            }),
            defineField({
              name: 'possibleNearDupeReason',
              type: 'string',
              description: 'The matched phrase and which other pool item it matched, when possibleNearDupe is true.',
            }),
          ],
        },
      ],
    }),
    defineField({
      name: 'alreadySeenSkips',
      type: 'array',
      description:
        'Kept Stage 0-2 candidates that were skipped at persist time because their sourceUrl matched something already seen (an existing topicCandidate doc of any status, or a published post) — see discoverAndPersistTopics\'s fetchKnownSourceUrls.',
      of: [
        {
          type: 'object',
          fields: [
            defineField({ name: 'title', type: 'string' }),
            defineField({ name: 'link', type: 'url' }),
            defineField({
              name: 'reason',
              type: 'string',
              options: { list: ['existing-candidate', 'published-post'] },
            }),
          ],
        },
      ],
    }),
  ],
  preview: {
    select: { createdAt: 'createdAt', poolSize: 'nearDedupedPool.length' },
    prepare({ createdAt, poolSize }) {
      return {
        title: `Topic discovery debug log — ${poolSize ?? 0} pool item(s)`,
        subtitle: createdAt,
      };
    },
  },
});

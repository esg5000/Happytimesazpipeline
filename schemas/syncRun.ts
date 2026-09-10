import { defineField, defineType } from 'sanity';

/**
 * One document per completed scheduled sync run — durable, queryable record
 * of whether a cron job actually did anything, surviving process
 * restarts/redeploys (unlike the in-memory tracking in pipelineStatus.ts).
 */
export default defineType({
  name: 'syncRun',
  title: 'Sync Run',
  type: 'document',
  fields: [
    defineField({
      name: 'syncType',
      type: 'string',
      description: 'e.g. events, news, newsV2, discoverTopics, eventsCleanup, pipeline',
      validation: (r) => r.required(),
    }),
    defineField({ name: 'startedAt', type: 'datetime', validation: (r) => r.required() }),
    defineField({ name: 'finishedAt', type: 'datetime' }),
    defineField({ name: 'itemsSynced', type: 'number' }),
    defineField({ name: 'errors', type: 'number', initialValue: 0 }),
    defineField({
      name: 'errorSample',
      type: 'array',
      of: [{ type: 'string' }],
      description: 'A few example error messages from this run, not all of them',
    }),
    defineField({
      name: 'actionsSample',
      type: 'array',
      of: [{ type: 'string' }],
      description: 'A few example actions taken by this run (e.g. hero image re-fixed, duplicate unpublished), not all of them',
    }),
    defineField({
      name: 'stage0Usage',
      type: 'object',
      description: 'newsV2 and discoverTopics runs — per-provider Stage 0 call accounting, so it is directly queryable which provider (Bright Data vs SerpAPI fallback) actually discovered this run\'s items.',
      fields: [
        defineField({
          name: 'brightData',
          type: 'object',
          fields: [
            defineField({ name: 'calls', type: 'number' }),
            defineField({ name: 'served', type: 'number' }),
            defineField({ name: 'errors', type: 'number' }),
          ],
        }),
        defineField({
          name: 'serpApi',
          type: 'object',
          fields: [
            defineField({ name: 'calls', type: 'number' }),
            defineField({ name: 'served', type: 'number' }),
            defineField({ name: 'errors', type: 'number' }),
          ],
        }),
      ],
    }),
    defineField({
      name: 'topicDiscoveryUsage',
      type: 'object',
      description: 'discoverTopics runs only — Stage 0 query volume, Stage 1 kept/dropped, and cross-run sourceUrl-dedup counts, so a day\'s topic-picker volume is queryable here instead of only in the local shadow-mode JSON log on whichever host ran it.',
      fields: [
        defineField({ name: 'queriesAttempted', type: 'number', description: 'STAGE0_QUERIES.length at run time.' }),
        defineField({ name: 'stage1Kept', type: 'number', description: 'Stage 0-2 kept count, before the cross-run sourceUrl dedup check.' }),
        defineField({ name: 'stage1Dropped', type: 'number', description: 'Stage 1 skipped count (editorial gate + crime/tragedy + editorial-fit + national-skip verdicts combined).' }),
        defineField({ name: 'skippedAsAlreadySeen', type: 'number', description: 'Kept candidates whose sourceUrl matched an existing topicCandidate doc (any status) or a published post, and were not persisted as new docs.' }),
        defineField({ name: 'preExistingPendingCount', type: 'number', description: 'Pending topicCandidate docs already sitting in Sanity from an earlier, unreviewed run before this run persisted its own.' }),
      ],
    }),
    defineField({
      name: 'triggeredBy',
      type: 'string',
      options: { list: ['cron', 'manual'] },
      validation: (r) => r.required(),
    }),
  ],
  preview: {
    select: { syncType: 'syncType', errors: 'errors', startedAt: 'startedAt' },
    prepare({ syncType, errors, startedAt }) {
      return {
        title: `${syncType || 'sync'} — errors: ${errors ?? 0}`,
        subtitle: startedAt,
      };
    },
  },
});

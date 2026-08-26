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
      description: 'e.g. events, news, eventsCleanup, pipeline',
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
      description: 'newsV2 runs only — per-provider Stage 0 call accounting, so it is directly queryable which provider (Bright Data vs SerpAPI fallback) actually discovered this run\'s items.',
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

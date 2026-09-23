import { getSanityClient } from './sanityPublisher';

const ERROR_SAMPLE_MAX = 5;
const RETENTION_DAYS = 14;

/**
 * Deletes `topicDiscoveryDebugLog` documents (the nearDedupedPool/
 * alreadySeenSkips debug data written on every discoverTopics run — see
 * syncRunLogger.ts's recordTopicDiscoveryDebugLog) older than
 * RETENTION_DAYS. Debug data only, nothing pipeline-critical reads it.
 *
 * Deliberately scoped to `_type == "topicDiscoveryDebugLog"` alone — never
 * touches topicCandidate docs, published posts, or any other syncRun record
 * (news/newsV2/events/etc). The age check is on that document's own
 * `_createdAt` (Sanity's built-in creation timestamp), not on the syncRun
 * doc it references, so this cleanup has no dependency on syncRun's shape
 * or retention at all.
 */
export async function cleanupOldTopicDiscoveryDebugLogs(): Promise<{
  deleted: number;
  errors: number;
  /** A few example error messages from this run, capped — not every failure. */
  errorSample: string[];
}> {
  const client = getSanityClient();
  const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const ids = await client.fetch<string[]>(
    `*[_type == "topicDiscoveryDebugLog" && _createdAt < $cutoff]._id`,
    { cutoff: cutoffIso }
  );

  let deleted = 0;
  let errors = 0;
  const errorSample: string[] = [];

  for (const id of ids) {
    try {
      await client.delete(id);
      deleted++;
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[topic-discovery-debug-log-cleanup] Failed to delete ${id}:`, msg);
      if (errorSample.length < ERROR_SAMPLE_MAX) errorSample.push(`${id}: ${msg}`);
    }
  }

  return { deleted, errors, errorSample };
}

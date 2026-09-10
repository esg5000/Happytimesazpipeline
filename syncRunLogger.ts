import { getSanityClient } from './agents/sanityPublisher';

/** Durable counterpart to pipelineStatus.ts's in-memory activityLog — one Sanity `syncRun` doc per completed job, survives process restarts/redeploys. */
export type SyncRunRecord = {
  syncType: string;
  startedAt: string;
  finishedAt: string;
  /** Omit when no real item count is available for this job rather than writing a misleading 0. */
  itemsSynced?: number;
  errors: number;
  errorSample?: string[];
  /** A few example actions this run took (e.g. hero re-fixed, duplicate unpublished) — not all of them. */
  actionsSample?: string[];
  /** Per-provider Stage 0 call accounting for newsV2/discoverTopics runs — which provider actually discovered this run's items. Omitted for sync types with no Stage 0 concept. */
  stage0Usage?: {
    brightData: { calls: number; served: number; errors: number };
    serpApi: { calls: number; served: number; errors: number };
  };
  /** discoverTopics runs only — Stage 0 query volume, Stage 1 kept/dropped, and cross-run sourceUrl-dedup counts. See schemas/syncRun.ts's topicDiscoveryUsage field. */
  topicDiscoveryUsage?: {
    queriesAttempted: number;
    stage1Kept: number;
    stage1Dropped: number;
    skippedAsAlreadySeen: number;
    preExistingPendingCount: number;
  };
  triggeredBy: 'cron' | 'manual';
};

const ERROR_SAMPLE_MAX = 5;
const ACTIONS_SAMPLE_MAX = 5;

/**
 * Writes one syncRun document. Best-effort: a failure to write this record
 * must never fail the sync it's describing, so errors here are caught and
 * logged, not thrown.
 */
export async function recordSyncRun(record: SyncRunRecord): Promise<void> {
  try {
    const client = getSanityClient();
    await client.create({
      _type: 'syncRun',
      syncType: record.syncType,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      ...(record.itemsSynced !== undefined ? { itemsSynced: record.itemsSynced } : {}),
      errors: record.errors,
      ...(record.errorSample && record.errorSample.length > 0
        ? { errorSample: record.errorSample.slice(0, ERROR_SAMPLE_MAX) }
        : {}),
      ...(record.actionsSample && record.actionsSample.length > 0
        ? { actionsSample: record.actionsSample.slice(0, ACTIONS_SAMPLE_MAX) }
        : {}),
      ...(record.stage0Usage ? { stage0Usage: record.stage0Usage } : {}),
      ...(record.topicDiscoveryUsage ? { topicDiscoveryUsage: record.topicDiscoveryUsage } : {}),
      triggeredBy: record.triggeredBy,
    });
  } catch (err: unknown) {
    console.error(
      '[sync-run-logger] Failed to write syncRun record (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}

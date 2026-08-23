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
      triggeredBy: record.triggeredBy,
    });
  } catch (err: unknown) {
    console.error(
      '[sync-run-logger] Failed to write syncRun record (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}

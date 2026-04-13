export type PipelineLastStatus = 'success' | 'failed' | 'never';

/** Recent operational messages (e.g. sync progress); newest first. Exposed on GET /api/status. */
export type ActivityLogEntry = {
  at: string;
  message: string;
  kind?: string;
};

const MAX_ACTIVITY_LOG = 200;
const activityLog: ActivityLogEntry[] = [];

let lastRunAt: string | null = null;
let lastStatus: PipelineLastStatus = 'never';
let lastError: string | undefined;

export function appendActivityLog(message: string, kind?: string): void {
  activityLog.unshift({
    at: new Date().toISOString(),
    message,
    ...(kind !== undefined && kind !== '' ? { kind } : {}),
  });
  if (activityLog.length > MAX_ACTIVITY_LOG) {
    activityLog.length = MAX_ACTIVITY_LOG;
  }
}

export function recordScheduledPipelineFinish(success: boolean, errorMessage?: string): void {
  lastRunAt = new Date().toISOString();
  lastStatus = success ? 'success' : 'failed';
  lastError = success ? undefined : errorMessage;
}

export function getPipelineStatusSnapshot(): {
  lastPipelineRunAt: string | null;
  lastPipelineStatus: PipelineLastStatus;
  lastPipelineError?: string;
  activityLog: ActivityLogEntry[];
} {
  return {
    lastPipelineRunAt: lastRunAt,
    lastPipelineStatus: lastStatus,
    activityLog: activityLog.slice(),
    ...(lastError ? { lastPipelineError: lastError } : {}),
  };
}

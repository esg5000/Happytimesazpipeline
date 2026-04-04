export type PipelineLastStatus = 'success' | 'failed' | 'never';

let lastRunAt: string | null = null;
let lastStatus: PipelineLastStatus = 'never';
let lastError: string | undefined;

export function recordScheduledPipelineFinish(success: boolean, errorMessage?: string): void {
  lastRunAt = new Date().toISOString();
  lastStatus = success ? 'success' : 'failed';
  lastError = success ? undefined : errorMessage;
}

export function getPipelineStatusSnapshot(): {
  lastPipelineRunAt: string | null;
  lastPipelineStatus: PipelineLastStatus;
  lastPipelineError?: string;
} {
  return {
    lastPipelineRunAt: lastRunAt,
    lastPipelineStatus: lastStatus,
    ...(lastError ? { lastPipelineError: lastError } : {}),
  };
}

import { recordScheduledPipelineFinish } from './pipelineStatus';
import { runPipeline, type RunPipelineOptions } from './orchestrator';

let pipelineRunning = false;

/**
 * Runs the batch publishing pipeline (same as the daily cron). Serializes concurrent
 * invocations: returns `{ skipped: true }` if a run is already in progress.
 */
export async function runPipelineJob(
  options?: RunPipelineOptions
): Promise<{ skipped: boolean }> {
  if (pipelineRunning) {
    return { skipped: true };
  }
  pipelineRunning = true;
  try {
    await runPipeline(options);
    recordScheduledPipelineFinish(true);
    return { skipped: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    recordScheduledPipelineFinish(false, msg);
    throw err;
  } finally {
    pipelineRunning = false;
  }
}

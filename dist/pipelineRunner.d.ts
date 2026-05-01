import { type RunPipelineOptions } from './orchestrator';
/**
 * Runs the batch publishing pipeline (same as the daily cron). Serializes concurrent
 * invocations: returns `{ skipped: true }` if a run is already in progress.
 */
export declare function runPipelineJob(options?: RunPipelineOptions): Promise<{
    skipped: boolean;
}>;
//# sourceMappingURL=pipelineRunner.d.ts.map
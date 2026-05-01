"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPipelineJob = runPipelineJob;
const pipelineStatus_1 = require("./pipelineStatus");
const orchestrator_1 = require("./orchestrator");
let pipelineRunning = false;
/**
 * Runs the batch publishing pipeline (same as the daily cron). Serializes concurrent
 * invocations: returns `{ skipped: true }` if a run is already in progress.
 */
async function runPipelineJob(options) {
    if (pipelineRunning) {
        return { skipped: true };
    }
    pipelineRunning = true;
    try {
        await (0, orchestrator_1.runPipeline)(options);
        (0, pipelineStatus_1.recordScheduledPipelineFinish)(true);
        return { skipped: false };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, pipelineStatus_1.recordScheduledPipelineFinish)(false, msg);
        throw err;
    }
    finally {
        pipelineRunning = false;
    }
}
//# sourceMappingURL=pipelineRunner.js.map
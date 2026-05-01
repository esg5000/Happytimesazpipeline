"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendActivityLog = appendActivityLog;
exports.recordScheduledPipelineFinish = recordScheduledPipelineFinish;
exports.getPipelineStatusSnapshot = getPipelineStatusSnapshot;
const MAX_ACTIVITY_LOG = 200;
const activityLog = [];
let lastRunAt = null;
let lastStatus = 'never';
let lastError;
function appendActivityLog(message, kind) {
    activityLog.unshift({
        at: new Date().toISOString(),
        message,
        ...(kind !== undefined && kind !== '' ? { kind } : {}),
    });
    if (activityLog.length > MAX_ACTIVITY_LOG) {
        activityLog.length = MAX_ACTIVITY_LOG;
    }
}
function recordScheduledPipelineFinish(success, errorMessage) {
    lastRunAt = new Date().toISOString();
    lastStatus = success ? 'success' : 'failed';
    lastError = success ? undefined : errorMessage;
}
function getPipelineStatusSnapshot() {
    return {
        lastPipelineRunAt: lastRunAt,
        lastPipelineStatus: lastStatus,
        activityLog: activityLog.slice(),
        ...(lastError ? { lastPipelineError: lastError } : {}),
    };
}
//# sourceMappingURL=pipelineStatus.js.map
export type PipelineLastStatus = 'success' | 'failed' | 'never';
/** Recent operational messages (e.g. sync progress); newest first. Exposed on GET /api/status. */
export type ActivityLogEntry = {
    at: string;
    message: string;
    kind?: string;
};
export declare function appendActivityLog(message: string, kind?: string): void;
export declare function recordScheduledPipelineFinish(success: boolean, errorMessage?: string): void;
export declare function getPipelineStatusSnapshot(): {
    lastPipelineRunAt: string | null;
    lastPipelineStatus: PipelineLastStatus;
    lastPipelineError?: string;
    activityLog: ActivityLogEntry[];
};
//# sourceMappingURL=pipelineStatus.d.ts.map
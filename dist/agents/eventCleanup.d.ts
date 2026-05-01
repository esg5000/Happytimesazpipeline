/**
 * Sets `isActive` to false on all `event` documents whose `date` is in the past.
 */
export declare function deactivatePastEvents(): Promise<{
    deactivated: number;
    errors: number;
}>;
//# sourceMappingURL=eventCleanup.d.ts.map
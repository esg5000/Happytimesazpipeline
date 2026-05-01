type EventRow = {
    _id: string;
    title: string | null;
    description: string | null;
    venue: string | null;
    date: string | null;
    endDate: string | null;
    _createdAt: string;
};
/**
 * Groups events whose titles share the first {@link TITLE_PREFIX_CHARS} characters (trimmed, case-insensitive).
 * Logs every group with ≥3 events, with full titles and dates — useful to spot recurring rows that do not share
 * an exact title (so they are not merged by the same-title merge step).
 */
export declare function logPotentialRecurringByTitlePrefix(events: Array<Pick<EventRow, '_id' | 'title' | 'date' | 'endDate'>>): void;
export {};
//# sourceMappingURL=cleanupEvents.d.ts.map
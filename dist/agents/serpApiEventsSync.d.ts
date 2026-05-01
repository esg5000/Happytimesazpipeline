/**
 * Fetches Google Events via SerpApi for Phoenix-area cities and upserts `event` documents in Sanity.
 * One document per normalized title (recurring dates deduped). HappyTimesAZ category + audience filters apply.
 */
export declare function syncSerpApiEventsToSanity(): Promise<{
    synced: number;
    skipped: number;
    errors: number;
}>;
//# sourceMappingURL=serpApiEventsSync.d.ts.map
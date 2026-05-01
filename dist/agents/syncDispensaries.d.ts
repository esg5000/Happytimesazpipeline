type SyncDispensariesResult = {
    /** Unique dispensaries seen after dedupe (SerpApi + cross-city). */
    uniqueFound: number;
    /** Successfully written to Sanity. */
    saved: number;
    errors: number;
};
/**
 * SerpApi Google Maps (`engine=google_maps`, `type=search`) per Arizona search location, then upsert `dispensary` docs.
 * Deduplicates across **all** cities in one pass: `place_id` when present, else normalized name + address.
 */
export declare function syncDispensariesToSanity(): Promise<SyncDispensariesResult>;
export {};
//# sourceMappingURL=syncDispensaries.d.ts.map
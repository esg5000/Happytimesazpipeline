/**
 * SerpApi Google News — five independent slots (Suns/NBA, rotating AZ sports, local, lifestyle, events).
 * Each slot: own Serp queries → filter (incl. 7d recency, 48h for sports slots) → score (6+, else 4 for that slot) → publish at most one.
 * Manual: POST /api/command { "command": "syncNews" }. Uses SERPAPI_API_KEY.
 */
export declare function syncNewsApiToSanity(): Promise<{
    fetched: number;
    published: number;
    skipped: number;
    errors: number;
}>;
//# sourceMappingURL=newsApiSync.d.ts.map
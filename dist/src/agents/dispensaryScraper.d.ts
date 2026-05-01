export type ScrapeDispensariesResult = {
    total: number;
    ok: number;
    failed: number;
    skipped: number;
};
/**
 * Fetches all dispensaries with a website, finds a deals page URL and optionally captures a homepage logo
 * into `scrapedImage`, patches `dealsUrl`, `dealsScrapedAt`, and `scrapedImage` (never `image` or `logo`).
 * Rows with a manual `logo` skip image capture.
 * One failure does not stop the batch.
 */
export declare function scrapeDispensaries(): Promise<ScrapeDispensariesResult>;
//# sourceMappingURL=dispensaryScraper.d.ts.map
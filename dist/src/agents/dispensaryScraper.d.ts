/**
 * Dispensary website scraper: resolves and stores a deals page URL (`dealsUrl`) and optionally
 * captures a homepage logo screenshot into `scrapedImage` (never `image` or manual `logo`),
 * uploads to Sanity assets, and patches the dispensary doc.
 *
 * Redirects: an axios preflight (maxRedirects: 10) resolves the final base URL after 301/302/307/308
 * chains; `page.goto` also follows HTTP redirects by default in Chromium.
 *
 * Requires: `playwright` (see package.json). First run on a machine: `npx playwright install chromium`
 */
import './playwrightBrowsersPath';
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
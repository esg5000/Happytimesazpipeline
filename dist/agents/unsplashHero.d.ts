/** Build a short search query from headline + note keywords (Unsplash search). */
export declare function buildUnsplashSearchQuery(title: string, notes: string): string;
/**
 * Search Unsplash, trigger attribution download, fetch best-resolution bytes.
 * Returns null if no key, no results, or download fails.
 */
export declare function fetchUnsplashHeroImageBuffer(title: string, notes: string): Promise<Buffer | null>;
//# sourceMappingURL=unsplashHero.d.ts.map
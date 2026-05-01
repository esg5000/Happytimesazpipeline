"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildUnsplashSearchQuery = buildUnsplashSearchQuery;
exports.fetchUnsplashHeroImageBuffer = fetchUnsplashHeroImageBuffer;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';
/** Build a short search query from headline + note keywords (Unsplash search). */
function buildUnsplashSearchQuery(title, notes) {
    const stop = new Set([
        'the',
        'and',
        'for',
        'with',
        'that',
        'this',
        'from',
        'are',
        'was',
        'has',
        'have',
        'will',
        'been',
        'about',
        'into',
        'your',
        'their',
    ]);
    const words = `${title}\n${notes}`
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stop.has(w));
    const unique = [];
    for (const w of words) {
        if (!unique.includes(w))
            unique.push(w);
        if (unique.length >= 10)
            break;
    }
    const q = [title.slice(0, 60).trim(), ...unique.slice(0, 6)].filter(Boolean).join(' ');
    return q.slice(0, 100).trim() || title.slice(0, 80).trim() || 'editorial';
}
async function triggerUnsplashDownload(downloadLocation) {
    const key = config_1.config.unsplash.accessKey;
    if (!key || !downloadLocation.startsWith('http'))
        return;
    try {
        await axios_1.default.get(downloadLocation, {
            headers: { Authorization: `Client-ID ${key}` },
            timeout: 15000,
            validateStatus: () => true,
        });
    }
    catch {
        /* best-effort for Unsplash download guidelines */
    }
}
function pickHighestResolutionPhoto(results) {
    if (!results.length)
        return null;
    let best = results[0];
    let bestPx = (best.width || 0) * (best.height || 0);
    for (const p of results) {
        const px = (p.width || 0) * (p.height || 0);
        if (px > bestPx) {
            bestPx = px;
            best = p;
        }
    }
    return best;
}
/**
 * Search Unsplash, trigger attribution download, fetch best-resolution bytes.
 * Returns null if no key, no results, or download fails.
 */
async function fetchUnsplashHeroImageBuffer(title, notes) {
    const key = config_1.config.unsplash.accessKey;
    if (!key) {
        console.warn('[unsplash] UNSPLASH_ACCESS_KEY not set; skipping Unsplash hero');
        return null;
    }
    const query = buildUnsplashSearchQuery(title, notes);
    const { data, status } = await axios_1.default.get(UNSPLASH_SEARCH, {
        params: {
            query,
            per_page: 15,
            orientation: 'landscape',
        },
        headers: { Authorization: `Client-ID ${key}` },
        timeout: 20000,
        validateStatus: () => true,
    });
    if (status !== 200 || !data?.results?.length) {
        console.warn(`[unsplash] search failed or empty (status=${status}, query=${JSON.stringify(query.slice(0, 80))})`);
        return null;
    }
    const photo = pickHighestResolutionPhoto(data.results);
    if (!photo?.urls)
        return null;
    const downloadLoc = photo.links?.download_location;
    if (downloadLoc) {
        await triggerUnsplashDownload(downloadLoc);
    }
    const imageUrl = photo.urls.raw || photo.urls.full || photo.urls.regular;
    if (!imageUrl?.startsWith('http'))
        return null;
    try {
        const img = await axios_1.default.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            validateStatus: () => true,
        });
        if (img.status !== 200 || !img.data || img.data.byteLength < 500) {
            console.warn(`[unsplash] image fetch failed status=${img.status} bytes=${img.data?.byteLength ?? 0}`);
            return null;
        }
        return Buffer.from(img.data);
    }
    catch (e) {
        console.warn('[unsplash] image fetch error:', e instanceof Error ? e.message : e);
        return null;
    }
}
//# sourceMappingURL=unsplashHero.js.map
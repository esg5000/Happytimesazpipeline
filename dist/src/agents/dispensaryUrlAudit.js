"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditDispensaryWebsiteUrls = auditDispensaryWebsiteUrls;
/**
 * HTTP health check for dispensary `website` URLs stored in Sanity.
 *
 * Run: `npm run audit-dispensaries`
 * Requires: SANITY_* env (same as pipeline) — see `config.ts`.
 */
const axios_1 = __importDefault(require("axios"));
const sanityPublisher_1 = require("../../agents/sanityPublisher");
function normalizeWebsiteUrl(raw) {
    if (raw && typeof raw === 'object' && raw !== null && 'url' in raw) {
        const u = raw.url;
        if (typeof u === 'string')
            return normalizeWebsiteUrl(u);
    }
    if (typeof raw !== 'string')
        return null;
    const t = raw.trim();
    if (t.length < 4)
        return null;
    let href = t;
    if (!/^https?:\/\//i.test(href)) {
        href = `https://${href}`;
    }
    try {
        const u = new URL(href);
        if (!u.hostname)
            return null;
        return u.href;
    }
    catch {
        return null;
    }
}
function classifyHttpStatus(status) {
    if (status === 200)
        return 'OK';
    if (status === 301 || status === 302)
        return 'REDIRECT';
    if (status === 404)
        return 'NOT_FOUND';
    return 'ERROR';
}
async function checkUrlOnce(url) {
    try {
        const res = await axios_1.default.get(url, {
            timeout: 20000,
            maxRedirects: 0,
            validateStatus: () => true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; HappyTimesAZ-DispensaryAudit/1.0; +https://happytimesaz.com)',
                Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            },
        });
        return { category: classifyHttpStatus(res.status), status: res.status };
    }
    catch {
        return { category: 'ERROR', status: null };
    }
}
async function auditDispensaryWebsiteUrls() {
    const client = (0, sanityPublisher_1.getSanityClient)();
    const rows = await client.fetch(`*[_type == "dispensary" && defined(website)] | order(name asc) {
      _id,
      name,
      "slug": slug.current,
      website
    }`);
    const list = Array.isArray(rows) ? rows : [];
    const counts = {
        OK: 0,
        REDIRECT: 0,
        NOT_FOUND: 0,
        ERROR: 0,
    };
    console.log(`[dispensaryUrlAudit] ========== start: ${list.length} dispensary row(s) with website ==========`);
    for (const row of list) {
        const label = row.name?.trim() || row._id;
        const slug = row.slug?.trim() || '(no-slug)';
        const href = normalizeWebsiteUrl(row.website);
        if (!href) {
            counts.ERROR += 1;
            console.log(`[dispensaryUrlAudit] "${label}" [${slug}] — ERROR — invalid or missing website field`);
            continue;
        }
        const { category, status } = await checkUrlOnce(href);
        counts[category] += 1;
        const statusPart = status === null ? 'no status' : String(status);
        console.log(`[dispensaryUrlAudit] "${label}" [${slug}] — ${category} (${statusPart}) — ${href}`);
    }
    console.log('[dispensaryUrlAudit] ========== summary ==========');
    console.log(`[dispensaryUrlAudit] OK (200):        ${counts.OK}`);
    console.log(`[dispensaryUrlAudit] REDIRECT (301/302): ${counts.REDIRECT}`);
    console.log(`[dispensaryUrlAudit] NOT FOUND (404): ${counts.NOT_FOUND}`);
    console.log(`[dispensaryUrlAudit] ERROR:          ${counts.ERROR}`);
    console.log(`[dispensaryUrlAudit] Total:          ${list.length}`);
    return counts;
}
async function main() {
    await auditDispensaryWebsiteUrls();
}
void main().catch((err) => {
    console.error('[dispensaryUrlAudit] fatal:', err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
});
//# sourceMappingURL=dispensaryUrlAudit.js.map
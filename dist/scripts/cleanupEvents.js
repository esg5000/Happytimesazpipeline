"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logPotentialRecurringByTitlePrefix = logPotentialRecurringByTitlePrefix;
const config_1 = require("../config");
const sanityPublisher_1 = require("../agents/sanityPublisher");
const slug_1 = require("../utils/slug");
/**
 * Case-insensitive substring match on combined title + description + venue.
 * `tot` uses a word boundary to avoid matching e.g. "total".
 * Order: longer phrases listed first for readability (matching is order-independent).
 */
const KEYWORDS_FAMILY_DELETE = [
    'magic show for kids',
    'wizard of oz youth',
    'family storytime',
    'family fun',
    'family friendly',
    'family event',
    'parent and tot',
    'vision kids',
    'birthday party',
    'story time',
    'kids camp',
    'summer camp',
    'ages 2-12',
    'ages 3-10',
    'puppet show',
    'face painting',
    'bounce house',
    'fairy tale',
    'little ones',
    'munchkins',
    "children's",
    'storytime',
    'preschool',
    'daycare',
    'pediatric',
    'children',
    'toddler',
    'infant',
    'princess',
    'superhero',
    'sensory',
    'junior',
    'school',
    'youth',
    'teen',
    'tween',
    'baby',
    'kids',
    'teddy bear',
];
/** Short token: word match only. */
const TOT_RE = /\btot\b/i;
const FETCH_OPTS = { perspective: 'raw' };
function combinedText(ev) {
    return [ev.title || '', ev.description || '', ev.venue || ''].join('\n');
}
function matchesFamilyDeleteKeywords(ev) {
    const haystack = combinedText(ev).toLowerCase();
    if (!haystack.trim())
        return false;
    if (TOT_RE.test(haystack))
        return true;
    for (const kw of KEYWORDS_FAMILY_DELETE) {
        if (haystack.includes(kw.toLowerCase()))
            return true;
    }
    return false;
}
function normalizeTitle(title) {
    return (title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function parseTime(iso) {
    if (!iso)
        return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
}
const TITLE_PREFIX_CHARS = 20;
/**
 * Groups events whose titles share the first {@link TITLE_PREFIX_CHARS} characters (trimmed, case-insensitive).
 * Logs every group with ≥3 events, with full titles and dates — useful to spot recurring rows that do not share
 * an exact title (so they are not merged by the same-title merge step).
 */
function logPotentialRecurringByTitlePrefix(events) {
    const byPrefix = new Map();
    for (const ev of events) {
        const t = (ev.title || '').trim();
        if (!t)
            continue;
        const key = t.toLowerCase().slice(0, TITLE_PREFIX_CHARS);
        const list = byPrefix.get(key);
        if (list)
            list.push(ev);
        else
            byPrefix.set(key, [ev]);
    }
    const groups = [...byPrefix.entries()].filter(([, rows]) => rows.length >= 3);
    groups.sort((a, b) => a[0].localeCompare(b[0]));
    console.log('');
    console.log(`[cleanup-events] Potential recurring — ≥3 events sharing first ${TITLE_PREFIX_CHARS} title characters (trimmed, case-insensitive): ${groups.length} group(s)`);
    if (groups.length === 0) {
        console.log('[cleanup-events] No title-prefix groups of 3 or more.');
        return;
    }
    for (const [prefixKey, rows] of groups) {
        const sorted = [...rows].sort((a, b) => (parseTime(a.date) ?? 0) - (parseTime(b.date) ?? 0));
        console.log(`[cleanup-events] — Group prefix "${prefixKey}" (${sorted.length} events) —`);
        for (const r of sorted) {
            console.log(`    [${r._id}] "${r.title ?? '(no title)'}"  |  date: ${r.date ?? '(none)'}  |  endDate: ${r.endDate ?? '—'}`);
        }
    }
}
/** End of a single occurrence: prefers endDate, else start date. */
function occurrenceEndMs(doc) {
    const end = parseTime(doc.endDate);
    const start = parseTime(doc.date);
    if (end !== null)
        return end;
    return start;
}
function formatDateRange(start, end) {
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    const a = start.toLocaleDateString('en-US', opts);
    const b = end.toLocaleDateString('en-US', opts);
    if (start.getTime() === end.getTime())
        return a;
    return `${a} – ${b}`;
}
async function main() {
    (0, config_1.validateConfig)();
    const client = (0, sanityPublisher_1.getSanityClient)();
    const events = await client.fetch(`*[_type == "event"] | order(_createdAt asc){ _id, title, description, venue, date, endDate, _createdAt }`, {}, FETCH_OPTS);
    console.log(`[cleanup-events] Loaded ${events.length} event document(s) (perspective=raw: drafts + published).`);
    logPotentialRecurringByTitlePrefix(events);
    let deletedByKeyword = 0;
    for (const ev of events) {
        if (!matchesFamilyDeleteKeywords(ev))
            continue;
        const displayTitle = ev.title || '(no title)';
        try {
            await client.delete(ev._id);
            deletedByKeyword++;
            console.log(`[cleanup-events] Deleted (title/description/venue keyword): "${displayTitle}" [${ev._id}]`);
        }
        catch (e) {
            console.error(`[cleanup-events] Failed to delete ${ev._id} ("${displayTitle.slice(0, 120)}"):`, e instanceof Error ? e.message : e);
        }
    }
    const afterKeywordPass = await client.fetch(`*[_type == "event"] | order(_createdAt asc){ _id, title, date, endDate }`, {}, FETCH_OPTS);
    const byTitle = new Map();
    for (const ev of afterKeywordPass) {
        const key = normalizeTitle(ev.title);
        const list = byTitle.get(key);
        if (list)
            list.push(ev);
        else
            byTitle.set(key, [ev]);
    }
    let mergedGroups = 0;
    let deletedInMerge = 0;
    for (const [normTitle, rows] of byTitle) {
        if (rows.length <= 1)
            continue;
        const missingDate = rows.filter((r) => parseTime(r.date) === null);
        if (missingDate.length > 0) {
            console.log(`[cleanup-events] Skip recurring merge (missing \`date\` on ${missingDate.length} of ${rows.length}): "${rows[0]?.title || normTitle}"`);
            continue;
        }
        const withDates = rows;
        withDates.sort((a, b) => parseTime(a.date) - parseTime(b.date));
        const keeper = withDates[0];
        const starts = withDates.map((r) => parseTime(r.date));
        const ends = withDates.map((r) => occurrenceEndMs(r)).filter((t) => t !== null);
        const rangeStartMs = Math.min(...starts);
        const rangeEndMs = Math.max(...ends);
        const rangeStart = new Date(rangeStartMs);
        const rangeEnd = new Date(rangeEndMs);
        const baseTitle = (keeper.title || 'Event').trim();
        const rangeLabel = formatDateRange(rangeStart, rangeEnd);
        const newTitle = `${baseTitle} (${rangeLabel})`;
        const newSlug = (0, slug_1.generateSlug)(newTitle);
        const toDelete = withDates.slice(1);
        try {
            await client
                .patch(keeper._id)
                .set({
                date: rangeStart.toISOString(),
                endDate: rangeEnd.toISOString(),
                title: newTitle,
                slug: { _type: 'slug', current: newSlug },
            })
                .commit();
            mergedGroups++;
            console.log(`[cleanup-events] Merged recurring "${baseTitle}": kept [${keeper._id}] ` +
                `date=${rangeStart.toISOString()} endDate=${rangeEnd.toISOString()} ` +
                `newTitle="${newTitle}" slug=${newSlug}`);
        }
        catch (e) {
            console.error(`[cleanup-events] Failed to patch keeper ${keeper._id}:`, e instanceof Error ? e.message : e);
            continue;
        }
        for (const doc of toDelete) {
            try {
                await client.delete(doc._id);
                deletedInMerge++;
                console.log(`[cleanup-events] Deleted (recurring duplicate): "${doc.title || '(no title)'}" [${doc._id}]`);
            }
            catch (e) {
                console.error(`[cleanup-events] Failed to delete ${doc._id}:`, e instanceof Error ? e.message : e);
            }
        }
    }
    console.log('');
    console.log('[cleanup-events] Summary');
    console.log(`  Deleted (family keyword in title, description, or venue): ${deletedByKeyword}`);
    console.log(`  Recurring title groups merged (date range in title): ${mergedGroups}`);
    console.log(`  Documents deleted (recurring duplicates after merge): ${deletedInMerge}`);
}
main().catch((e) => {
    console.error('[cleanup-events] Fatal:', e);
    process.exit(1);
});
//# sourceMappingURL=cleanupEvents.js.map
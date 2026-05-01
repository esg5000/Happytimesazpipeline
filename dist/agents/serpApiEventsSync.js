"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncSerpApiEventsToSanity = syncSerpApiEventsToSanity;
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const sanityPublisher_1 = require("./sanityPublisher");
const SERPAPI_SEARCH = 'https://serpapi.com/search.json';
/** Max events written to Sanity per run (manual API and scheduled cron). */
const MAX_EVENTS_PER_SYNC = 50;
/** Cities to search (Google Events query + location). */
const TARGET_CITIES = [
    'Phoenix',
    'Scottsdale',
    'Tempe',
    'Mesa',
    'Glendale',
    'Peoria',
    'Chandler',
    'Gilbert',
];
function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function normalizeTitle(title) {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
/** One stable document id per normalized title (recurring performances share one Sanity doc). */
function titleKeyHex(title) {
    return crypto_1.default.createHash('sha256').update(normalizeTitle(title)).digest('hex');
}
function documentIdFromTitle(title) {
    return `event-ge-${titleKeyHex(title).slice(0, 32)}`;
}
function slugFromTitle(title) {
    return `ge-${titleKeyHex(title).slice(0, 24)}`;
}
/** Exclude kids / school / family-only style events (checked before include list). */
function isExcludedAudience(textLower) {
    const excludePhrases = [
        'family-only',
        'family only',
        'kid-friendly',
        'kid friendly',
        'kids-only',
        'kids only',
        'for kids',
        'toddler',
        'toddlers',
        "children's",
        'children',
    ];
    for (const p of excludePhrases) {
        if (textLower.includes(p))
            return true;
    }
    if (/\bkids\b/.test(textLower))
        return true;
    if (/\bchild\b/.test(textLower))
        return true;
    if (/\bschool\b/.test(textLower))
        return true;
    return false;
}
/** HappyTimesAZ focus: at least one category keyword in title, description, or venue. */
function matchesHappyTimesCategories(title, description, venue) {
    const textLower = `${title}\n${description}\n${venue}`.toLowerCase();
    if (isExcludedAudience(textLower))
        return false;
    const includeTerms = [
        'food',
        'nightlife',
        'music',
        'cannabis',
        'arts',
        'health',
        'wellness',
        'fitness',
        'comedy',
        'festival',
        'festivals',
    ];
    for (const term of includeTerms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(textLower))
            return true;
    }
    return false;
}
/** Stable ISO start time for dedupe; prefers `when`, falls back to start_date + year. */
function parseStartIso(dateBlock) {
    if (!dateBlock)
        return null;
    const when = dateBlock.when?.trim();
    if (when) {
        const parsed = Date.parse(when);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    const sd = dateBlock.start_date?.trim();
    if (!sd)
        return null;
    const y = new Date().getFullYear();
    let d = new Date(`${sd}, ${y}`);
    if (Number.isNaN(d.getTime())) {
        d = new Date(`${sd} ${y}`);
    }
    if (Number.isNaN(d.getTime()))
        return null;
    const now = new Date();
    if (d < now) {
        d = new Date(`${sd}, ${y + 1}`);
    }
    return d.toISOString();
}
function parseAddressLines(address) {
    if (!address?.length) {
        return { venue: '', addressLine: '', city: '' };
    }
    const first = address[0] || '';
    const last = address[address.length - 1] || '';
    let city = '';
    const m = last.match(/^([^,]+),\s*([A-Z]{2})\b/i);
    if (m) {
        city = m[1].trim();
    }
    else {
        city = last.split(',')[0]?.trim() || '';
    }
    const venueFromLine = first.split(',')[0]?.trim() || '';
    return {
        venue: venueFromLine,
        addressLine: address.join(', '),
        city,
    };
}
function pickTicketUrl(ev) {
    const tickets = ev.ticket_info?.find((t) => t.link_type === 'tickets' && t.link);
    if (tickets?.link)
        return tickets.link;
    return ev.link || '';
}
function pickPrice(ev) {
    const ti = ev.ticket_info;
    if (!ti?.length)
        return '';
    const t = ti.find((x) => x.link_type === 'tickets');
    return t?.source ? `See ${t.source}` : '';
}
async function fetchEventsForCity(city) {
    const apiKey = config_1.config.serpApi.apiKey;
    if (!apiKey)
        throw new Error('SERPAPI_API_KEY is not set');
    const out = [];
    let start = 0;
    for (let page = 0; page < 8; page++) {
        const { status, data } = await axios_1.default.get(SERPAPI_SEARCH, {
            params: {
                engine: 'google_events',
                api_key: apiKey,
                q: `Events in ${city}, Arizona`,
                location: `${city}, Arizona, United States`,
                hl: 'en',
                gl: 'us',
                htichips: 'date:month,date:next_month',
                start,
            },
            validateStatus: () => true,
        });
        if (status !== 200) {
            throw new Error(`SerpApi HTTP ${status}: ${typeof data === 'object' && data && 'error' in data ? String(data.error) : 'request failed'}`);
        }
        if (data.error) {
            throw new Error(data.error);
        }
        const results = data.events_results || [];
        if (results.length === 0)
            break;
        out.push(...results);
        start += 10;
        if (results.length < 10)
            break;
    }
    return out;
}
/**
 * Fetches Google Events via SerpApi for Phoenix-area cities and upserts `event` documents in Sanity.
 * One document per normalized title (recurring dates deduped). HappyTimesAZ category + audience filters apply.
 */
async function syncSerpApiEventsToSanity() {
    if (!config_1.config.serpApi.apiKey) {
        throw new Error('SERPAPI_API_KEY is not set');
    }
    const client = (0, sanityPublisher_1.getSanityClient)();
    const existingTitles = await client.fetch(`*[_type == "event" && defined(title)].title`);
    const claimedTitles = new Set((existingTitles || []).map((t) => normalizeTitle(t)));
    let skipped = 0;
    let errors = 0;
    let synced = 0;
    cityLoop: for (const city of TARGET_CITIES) {
        if (synced >= MAX_EVENTS_PER_SYNC)
            break;
        let batch;
        try {
            batch = await fetchEventsForCity(city);
        }
        catch (e) {
            console.error(`[serpapi] City "${city}" fetch failed:`, e);
            errors++;
            continue;
        }
        for (const raw of batch) {
            if (synced >= MAX_EVENTS_PER_SYNC)
                break cityLoop;
            const ev = { ...raw, _searchCity: city };
            const title = ev.title?.trim() || '';
            if (!title) {
                skipped++;
                continue;
            }
            const normTitle = normalizeTitle(title);
            if (claimedTitles.has(normTitle)) {
                skipped++;
                continue;
            }
            const { venue: venueFromAddr, addressLine, city: cityParsed } = parseAddressLines(ev.address);
            const venueName = ev.venue?.name?.trim() || venueFromAddr;
            const description = stripHtml(ev.description || '').slice(0, 30000);
            if (!matchesHappyTimesCategories(title, description, venueName)) {
                skipped++;
                continue;
            }
            const startIso = parseStartIso(ev.date);
            if (!startIso) {
                skipped++;
                continue;
            }
            const imageUrl = ev.image || ev.thumbnail;
            const tKey = titleKeyHex(title).slice(0, 16);
            let imageAssetId;
            if (imageUrl) {
                try {
                    imageAssetId = await (0, sanityPublisher_1.uploadImageToSanity)(imageUrl, `google-events-${tKey}.jpg`);
                }
                catch (e) {
                    console.warn(`[serpapi] Image upload failed for "${title}":`, e instanceof Error ? e.message : e);
                }
            }
            const ticketUrl = pickTicketUrl(ev);
            const price = pickPrice(ev);
            const cityOut = cityParsed || ev._searchCity || '';
            const doc = {
                _type: 'event',
                _id: documentIdFromTitle(title),
                title,
                slug: {
                    _type: 'slug',
                    current: slugFromTitle(title),
                },
                date: startIso,
                venue: venueName,
                address: addressLine,
                city: cityOut,
                description,
                price,
                categories: ['google_events', 'Events'],
                isActive: true,
                source: 'google_events',
            };
            if (ticketUrl) {
                doc.ticketUrl = ticketUrl;
            }
            if (imageAssetId) {
                doc.image = {
                    _type: 'image',
                    asset: {
                        _type: 'reference',
                        _ref: imageAssetId,
                    },
                };
            }
            try {
                await client.createOrReplace(doc);
                synced++;
                claimedTitles.add(normTitle);
            }
            catch (e) {
                errors++;
                console.error(`[serpapi] Failed to upsert event "${title}":`, e instanceof Error ? e.message : e);
            }
        }
    }
    return { synced, skipped, errors };
}
//# sourceMappingURL=serpApiEventsSync.js.map
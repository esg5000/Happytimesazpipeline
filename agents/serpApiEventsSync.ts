import crypto from 'crypto';

import axios from 'axios';

import { config } from '../config';
import { getSanityClient, uploadImageToSanity } from './sanityPublisher';

/**
 * Data source: Ticketmaster Discovery API (bulk per-city listing), not
 * SerpApi's google_events — google_events stopped returning real results
 * (confirmed dead across every tested query before this swap) and SerpApi's
 * Bing Events product does not trigger an events carousel on this account
 * either (also confirmed dead, including SerpApi's own documented example
 * queries). File/function names below still say "SerpApi" — kept as-is
 * because daemonServer.ts and telegramHttpServer.ts import
 * syncSerpApiEventsToSanity by that exact name and renaming it is out of
 * scope for this fix (this file only). The name is now misleading, worth
 * a follow-up rename later.
 */
const TICKETMASTER_DISCOVERY_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
/** How far ahead to pull events per run — matches this sync's existing weekly cadence (config.serpApi.cronSchedule in daemonServer.ts) with margin so a missed week doesn't leave a coverage gap. */
const TICKETMASTER_LOOKAHEAD_DAYS = 45;
/** One page per city — mirrors the old fetchEventsForCity, which also only ever read a single page. MAX_EVENTS_PER_SYNC=150 across ~19 cities means 50 raw candidates per city is already far more than a run will ever write. */
const TICKETMASTER_PAGE_SIZE = 50;

/** Max events written to Sanity per run (manual API and scheduled cron). */
const MAX_EVENTS_PER_SYNC = 150;

/** Cities to search (Ticketmaster city + stateCode filter). */
const TARGET_CITIES = [
  'Phoenix',
  'Scottsdale',
  'Tempe',
  'Mesa',
  'Chandler',
  'Gilbert',
  'Glendale',
  'Peoria',
  'Surprise',
  'Flagstaff',
  'Sedona',
  'Prescott',
  'Kingman',
  'Tucson',
  'Sierra Vista',
  'Yuma',
  'Lake Havasu City',
  'Show Low',
  'Safford',
] as const;

type TicketmasterVenue = {
  name?: string;
  address?: { line1?: string };
  city?: { name?: string };
  state?: { stateCode?: string };
};

type TicketmasterImage = { ratio?: string; width?: number; url?: string };

type TicketmasterPriceRange = { currency?: string; min?: number; max?: number };

type TicketmasterClassification = {
  segment?: { name?: string };
  genre?: { name?: string };
  subGenre?: { name?: string };
};

export type TicketmasterEvent = {
  name?: string;
  url?: string;
  images?: TicketmasterImage[];
  dates?: { start?: { localDate?: string; localTime?: string; dateTime?: string } };
  priceRanges?: TicketmasterPriceRange[];
  classifications?: TicketmasterClassification[];
  _embedded?: { venues?: TicketmasterVenue[] };
};

type TicketmasterEventsResponse = {
  _embedded?: { events?: TicketmasterEvent[] };
  page?: { totalElements?: number; totalPages?: number };
};

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** One stable document id per normalized title (recurring performances share one Sanity doc). */
function titleKeyHex(title: string): string {
  return crypto.createHash('sha256').update(normalizeTitle(title)).digest('hex');
}

function documentIdFromTitle(title: string): string {
  return `event-tm-${titleKeyHex(title).slice(0, 32)}`;
}

function slugFromTitle(title: string): string {
  return `tm-${titleKeyHex(title).slice(0, 24)}`;
}

/** Exclude kids / school / family-only style events (checked before include list). */
export function isExcludedAudience(textLower: string): boolean {
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
    if (textLower.includes(p)) return true;
  }
  if (/\bkids\b/.test(textLower)) return true;
  if (/\bchild\b/.test(textLower)) return true;
  return false;
}

/** HappyTimesAZ focus: at least one category keyword in title, description, or venue. Unchanged from the google_events version — see build report for how well this fits Ticketmaster's classification taxonomy instead of free-text description. */
export function matchesHappyTimesCategories(
  title: string,
  description: string,
  venue: string
): boolean {
  const textLower = `${title}\n${description}\n${venue}`.toLowerCase();
  if (isExcludedAudience(textLower)) return false;

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
    'sports',
    'tournament',
  ];
  for (const term of includeTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(textLower)) return true;
  }
  return false;
}

/**
 * Ticketmaster's base event response has no real event-description text —
 * `info`/`pleaseNote` are venue policy/logistics copy (bag policy, cashless
 * payment, mobile-ticket requirements), not a description of the event, so
 * using them here would mislabel real data as something it isn't. This
 * builds a short real-data summary from `classifications` instead (e.g.
 * "Sports — Baseball — MLB") — every word traces to an actual API field,
 * unlike a fabricated blurb, and it also gives matchesHappyTimesCategories
 * something to match against beyond title/venue text alone, since a title
 * like "Arizona Diamondbacks vs. New York Yankees" contains no category
 * keyword on its own. See build report: this is a real trade-off (shorter,
 * less descriptive than the old Google-sourced blurbs) called out
 * explicitly, not a silent change to the include-keyword gate itself.
 */
export function buildTicketmasterClassificationSummary(ev: TicketmasterEvent): string {
  const parts: string[] = [];
  for (const c of ev.classifications || []) {
    const bits = [c.segment?.name, c.genre?.name, c.subGenre?.name].filter(
      (b): b is string => !!b && b.trim().length > 0 && b.toLowerCase() !== 'undefined'
    );
    if (bits.length) parts.push(bits.join(' — '));
  }
  return parts.join('; ');
}

/** Ticketmaster gives a full ISO 8601 UTC dateTime directly — no loose-string parsing needed, unlike Google Events' date.when/start_date. */
export function parseTicketmasterStartIso(ev: TicketmasterEvent): string | null {
  const start = ev.dates?.start;
  if (!start) return null;
  if (start.dateTime) return start.dateTime;
  if (start.localDate) {
    const iso = new Date(`${start.localDate}T${start.localTime || '00:00:00'}`);
    return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
  }
  return null;
}

export function extractTicketmasterVenueFields(ev: TicketmasterEvent): {
  venue: string;
  address: string;
  city: string;
} {
  const v = ev._embedded?.venues?.[0];
  const venue = v?.name?.trim() || '';
  const city = v?.city?.name?.trim() || '';
  const addressParts = [v?.address?.line1, city, v?.state?.stateCode].filter(
    (p): p is string => !!p && p.trim().length > 0
  );
  return { venue, address: addressParts.join(', '), city };
}

/** Prefers a 16:9 image in a reasonable display width; Ticketmaster's `images` array otherwise skews toward either tiny thumbnails or huge originals. */
export function pickTicketmasterImageUrl(images: TicketmasterImage[] | undefined): string | undefined {
  if (!images?.length) return undefined;
  const wide = images.find((im) => im.ratio === '16_9' && (im.width || 0) >= 640 && (im.width || 0) <= 1200);
  return (wide || images[0])?.url;
}

/**
 * Only a real Ticketmaster priceRanges entry becomes a price fact — confirmed
 * live that priceRanges is frequently absent entirely (0 of 20 sampled
 * Phoenix events had it), so no synthesized/placeholder price. This
 * replaces the old pickPrice, which returned a non-numeric "See {ticket
 * source}" placeholder string — that placeholder is gone now, not ported.
 */
export function pickTicketmasterPrice(ev: TicketmasterEvent): string {
  const pr = (ev.priceRanges || []).find((p) => typeof p.min === 'number' || typeof p.max === 'number');
  if (!pr) return '';
  const currency = pr.currency || 'USD';
  const { min, max } = pr;
  if (min != null && max != null && min !== max) return `${currency} ${min}–${max}`;
  return `${currency} ${min ?? max}`;
}

function ticketmasterIsoParam(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-with-backoff tuning for Ticketmaster's 429 rate limit — confirmed live: "Spike arrest violation. Allowed rate: MessageRate{messagesPerPeriod=5, periodInMicroseconds=1000000, maxBurstMessageCount=1.0}" (5 req/sec, burst of 1) hit on the Surprise call during the first full 19-city run. Same pattern as the Gemini 503 fix in topicDiscovery.ts. */
const TICKETMASTER_429_MAX_RETRIES = 2; // up to 2 retries (3 total attempts)
const TICKETMASTER_429_RETRY_DELAY_MS = 1500;
/**
 * Stagger before each city's fetch, in the loop itself (not just reactive
 * retry) — the 429 in testing happened right after Peoria returned 0
 * results: with nothing to process (no image uploads/Sanity writes to
 * create a natural gap), the Peoria and Surprise fetches fired back to
 * back with ~0ms between them, tripping the burst-of-1 limit. A city with
 * real results doesn't need this (processing time already spaces the next
 * fetch out), but a zero-result city has no such natural delay.
 */
const TICKETMASTER_CITY_STAGGER_MS = 500;

/** One Ticketmaster Discovery API call per city: city + stateCode filter, bounded to the next TICKETMASTER_LOOKAHEAD_DAYS days, single page (TICKETMASTER_PAGE_SIZE). Retries on 429 specifically; any other error status throws immediately. */
export async function fetchTicketmasterEventsForCity(city: string): Promise<TicketmasterEvent[]> {
  const apiKey = config.ticketmaster.apiKey;
  if (!apiKey) throw new Error('TICKETMASTER_API_KEY is not set');

  const now = new Date();
  const end = new Date(now.getTime() + TICKETMASTER_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  for (let attempt = 0; ; attempt++) {
    const { status, data } = await axios.get<TicketmasterEventsResponse>(TICKETMASTER_DISCOVERY_URL, {
      params: {
        apikey: apiKey,
        city,
        stateCode: 'AZ',
        startDateTime: ticketmasterIsoParam(now),
        endDateTime: ticketmasterIsoParam(end),
        size: TICKETMASTER_PAGE_SIZE,
      },
      validateStatus: () => true,
    });

    if (status === 404) {
      // Ticketmaster returns 404 (not an empty 200) when a city has zero matches in range — confirmed live for Sedona/Show Low.
      return [];
    }

    if (status === 429 && attempt < TICKETMASTER_429_MAX_RETRIES) {
      console.warn(
        `[ticketmaster] HTTP 429 (rate limit) for "${city}" — retrying in ${TICKETMASTER_429_RETRY_DELAY_MS}ms (attempt ${
          attempt + 1
        }/${TICKETMASTER_429_MAX_RETRIES})`
      );
      await sleep(TICKETMASTER_429_RETRY_DELAY_MS);
      continue;
    }

    if (status !== 200) {
      const body = data as unknown as { fault?: { faultstring?: string }; errors?: Array<{ detail?: string }> };
      const errMsg = body?.fault?.faultstring || body?.errors?.[0]?.detail || `HTTP ${status}`;
      throw new Error(`Ticketmaster HTTP ${status}: ${errMsg}`);
    }

    return data._embedded?.events || [];
  }
}

/**
 * Fetches events via Ticketmaster's Discovery API for Phoenix-area cities and upserts `event` documents in Sanity.
 * One document per normalized title (recurring dates deduped). HappyTimesAZ category + audience filters apply.
 */
const ERROR_SAMPLE_MAX = 5;

export async function syncSerpApiEventsToSanity(): Promise<{
  synced: number;
  skipped: number;
  errors: number;
  /** A few example error messages from this run, capped — not every failure. Purely additive observability; does not change what gets fetched/synced. */
  errorSample: string[];
}> {
  if (!config.ticketmaster.apiKey) {
    throw new Error('TICKETMASTER_API_KEY is not set');
  }

  const client = getSanityClient();
  const existingTitles = await client.fetch<string[]>(
    `*[_type == "event" && defined(title)].title`
  );
  const claimedTitles = new Set(
    (existingTitles || []).map((t) => normalizeTitle(t))
  );

  let skipped = 0;
  let errors = 0;
  let synced = 0;
  const errorSample: string[] = [];
  const pushErrorSample = (msg: string) => {
    if (errorSample.length < ERROR_SAMPLE_MAX) errorSample.push(msg);
  };

  cityLoop: for (const [cityIdx, city] of TARGET_CITIES.entries()) {
    if (synced >= MAX_EVENTS_PER_SYNC) break;

    if (cityIdx > 0) {
      await sleep(TICKETMASTER_CITY_STAGGER_MS);
    }

    console.log(`[ticketmaster] Fetching events for ${city}...`);
    let batch: TicketmasterEvent[];
    try {
      batch = await fetchTicketmasterEventsForCity(city);
      console.log(`[ticketmaster] ${city}: ${batch.length} raw results`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ticketmaster] City "${city}" fetch failed:`, msg);
      errors++;
      pushErrorSample(`${city}: ${msg}`);
      continue;
    }

    const syncedBefore = synced;
    for (const ev of batch) {
      if (synced >= MAX_EVENTS_PER_SYNC) break cityLoop;

      const title = (ev.name || '').trim();
      if (!title) {
        skipped++;
        continue;
      }

      const normTitle = normalizeTitle(title);
      if (claimedTitles.has(normTitle)) {
        skipped++;
        continue;
      }

      const { venue: venueName, address: addressLine, city: cityParsed } = extractTicketmasterVenueFields(ev);
      const description = buildTicketmasterClassificationSummary(ev);

      /**
       * Unclassified Ticketmaster events (empty classification summary —
       * segment "Undefined" or missing entirely) pass through the
       * include-keyword gate rather than getting dropped. Reasoning
       * (confirmed against a live pull of every unclassified event across
       * all 19 cities before this was implemented — 13 distinct real
       * events, all legitimate live-music/theater/EDM shows at named
       * venues, none junk-looking): Ticketmaster is a curated ticketing
       * platform, not a raw web scrape, so the keyword gate's original
       * purpose — filtering genuine junk out of an open web index —
       * doesn't apply the same way to an event Ticketmaster itself has
       * already vetted onto its platform, just without a classification
       * tag. matchesHappyTimesCategories() is unchanged and still fully
       * applies to every event that DOES have real classification data.
       *
       * The audience exclusion (isExcludedAudience — kids/family-only)
       * is a separate concern from the topical keyword gate and still
       * applies here regardless of classification status: a curated
       * source doesn't make an event any more or less kid-oriented.
       */
      const isUnclassified = description === '';
      if (isUnclassified) {
        if (isExcludedAudience(`${title}\n${venueName}`.toLowerCase())) {
          skipped++;
          continue;
        }
      } else if (!matchesHappyTimesCategories(title, description, venueName)) {
        skipped++;
        continue;
      }

      const startIso = parseTicketmasterStartIso(ev);
      if (!startIso) {
        skipped++;
        continue;
      }

      const imageUrl = pickTicketmasterImageUrl(ev.images);
      const tKey = titleKeyHex(title).slice(0, 16);
      let imageAssetId: string | undefined;
      if (imageUrl) {
        try {
          imageAssetId = await uploadImageToSanity(
            imageUrl,
            `ticketmaster-${tKey}.jpg`
          );
        } catch (e) {
          console.warn(
            `[ticketmaster] Image upload failed for "${title}":`,
            e instanceof Error ? e.message : e
          );
        }
      }

      const ticketUrl = ev.url || '';
      const price = pickTicketmasterPrice(ev);
      const cityOut = cityParsed || city;

      const doc: Record<string, unknown> = {
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
        categories: ['ticketmaster', 'Events'],
        isActive: true,
        source: 'ticketmaster',
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
        await client.createOrReplace(
          doc as Parameters<typeof client.createOrReplace>[0]
        );
        synced++;
        claimedTitles.add(normTitle);
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[ticketmaster] Failed to upsert event "${title}":`, msg);
        pushErrorSample(`upsert "${title}": ${msg}`);
      }
    }
    console.log(`[ticketmaster] ${city}: ${synced - syncedBefore} passed filter`);
  }

  console.log(`[ticketmaster] Done — synced: ${synced}, skipped: ${skipped}, errors: ${errors}`);
  if (errors > 0 && errors === TARGET_CITIES.length) {
    console.warn(
      `[ticketmaster] WARNING: every city fetch errored this run (${errors}/${TARGET_CITIES.length}) — likely an engine/account-level issue, not city-specific. Sample: ${errorSample.join(' | ')}`
    );
  }
  return { synced, skipped, errors, errorSample };
}

import crypto from 'crypto';

import axios from 'axios';

import { config } from '../config';
import { getSanityClient, uploadImageToSanity } from './sanityPublisher';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

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
] as const;

type SerpDateBlock = {
  start_date?: string;
  when?: string;
};

export type SerpGoogleEvent = {
  title?: string;
  date?: SerpDateBlock;
  address?: string[];
  link?: string;
  description?: string;
  ticket_info?: Array<{ source?: string; link?: string; link_type?: string }>;
  venue?: { name?: string };
  thumbnail?: string;
  image?: string;
  /** Set when merging multi-city results — which query produced this row */
  _searchCity?: string;
};

type SerpApiResponse = {
  search_metadata?: { status?: string };
  error?: string;
  events_results?: SerpGoogleEvent[];
};

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable ISO start time for dedupe; prefers `when`, falls back to start_date + year. */
function parseStartIso(dateBlock: SerpDateBlock | undefined): string | null {
  if (!dateBlock) return null;
  const when = dateBlock.when?.trim();
  if (when) {
    const parsed = Date.parse(when);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  const sd = dateBlock.start_date?.trim();
  if (!sd) return null;
  const y = new Date().getFullYear();
  let d = new Date(`${sd}, ${y}`);
  if (Number.isNaN(d.getTime())) {
    d = new Date(`${sd} ${y}`);
  }
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  if (d < now) {
    d = new Date(`${sd}, ${y + 1}`);
  }
  return d.toISOString();
}

function dedupeKey(title: string, startIso: string): string {
  return crypto
    .createHash('sha256')
    .update(`${normalizeTitle(title)}|${startIso}`)
    .digest('hex');
}

function documentIdFromDedupe(key: string): string {
  return `event-ge-${key.slice(0, 32)}`;
}

function slugFromDedupe(key: string): string {
  return `ge-${key.slice(0, 24)}`;
}

function parseAddressLines(address: string[] | undefined): {
  venue: string;
  addressLine: string;
  city: string;
} {
  if (!address?.length) {
    return { venue: '', addressLine: '', city: '' };
  }
  const first = address[0] || '';
  const last = address[address.length - 1] || '';
  let city = '';
  const m = last.match(/^([^,]+),\s*([A-Z]{2})\b/i);
  if (m) {
    city = m[1].trim();
  } else {
    city = last.split(',')[0]?.trim() || '';
  }
  const venueFromLine = first.split(',')[0]?.trim() || '';
  return {
    venue: venueFromLine,
    addressLine: address.join(', '),
    city,
  };
}

function pickTicketUrl(ev: SerpGoogleEvent): string {
  const tickets = ev.ticket_info?.find((t) => t.link_type === 'tickets' && t.link);
  if (tickets?.link) return tickets.link;
  return ev.link || '';
}

function pickPrice(ev: SerpGoogleEvent): string {
  const ti = ev.ticket_info;
  if (!ti?.length) return '';
  const t = ti.find((x) => x.link_type === 'tickets');
  return t?.source ? `See ${t.source}` : '';
}

async function fetchEventsForCity(city: string): Promise<SerpGoogleEvent[]> {
  const apiKey = config.serpApi.apiKey;
  if (!apiKey) throw new Error('SERPAPI_API_KEY is not set');

  const out: SerpGoogleEvent[] = [];
  let start = 0;

  for (let page = 0; page < 8; page++) {
    const { status, data } = await axios.get<SerpApiResponse>(SERPAPI_SEARCH, {
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
      throw new Error(
        `SerpApi HTTP ${status}: ${typeof data === 'object' && data && 'error' in data ? String((data as SerpApiResponse).error) : 'request failed'}`
      );
    }

    if (data.error) {
      throw new Error(data.error);
    }

    const results = data.events_results || [];
    if (results.length === 0) break;
    out.push(...results);
    start += 10;
    if (results.length < 10) break;
  }

  return out;
}

/**
 * Fetches Google Events via SerpApi for Phoenix-area cities and upserts `event` documents in Sanity.
 * Deduplicates by normalized title + start datetime (stable hash → deterministic `_id`).
 */
export async function syncSerpApiEventsToSanity(): Promise<{
  synced: number;
  skipped: number;
  errors: number;
}> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  const client = getSanityClient();
  const seenKeys = new Set<string>();
  let skipped = 0;
  let errors = 0;
  let synced = 0;

  const allRaw: SerpGoogleEvent[] = [];
  for (const city of TARGET_CITIES) {
    try {
      const batch = await fetchEventsForCity(city);
      allRaw.push(...batch);
    } catch (e) {
      console.error(`[serpapi] City "${city}" fetch failed:`, e);
      errors++;
    }
  }

  for (const ev of allRaw) {
    const title = ev.title?.trim() || '';
    if (!title) {
      skipped++;
      continue;
    }

    const startIso = parseStartIso(ev.date);
    if (!startIso) {
      skipped++;
      continue;
    }

    const key = dedupeKey(title, startIso);
    if (seenKeys.has(key)) {
      skipped++;
      continue;
    }
    seenKeys.add(key);

    const { venue: venueFromAddr, addressLine, city: cityParsed } = parseAddressLines(
      ev.address
    );
    const cityOut = cityParsed || ev._searchCity || '';
    const venueName = ev.venue?.name?.trim() || venueFromAddr;

    const imageUrl = ev.image || ev.thumbnail;
    let imageAssetId: string | undefined;
    if (imageUrl) {
      try {
        imageAssetId = await uploadImageToSanity(
          imageUrl,
          `google-events-${key.slice(0, 16)}.jpg`
        );
      } catch (e) {
        console.warn(
          `[serpapi] Image upload failed for "${title}":`,
          e instanceof Error ? e.message : e
        );
      }
    }

    const ticketUrl = pickTicketUrl(ev);
    const price = pickPrice(ev);
    const description = stripHtml(ev.description || '').slice(0, 30000);

    const doc: Record<string, unknown> = {
      _type: 'event',
      _id: documentIdFromDedupe(key),
      title,
      slug: {
        _type: 'slug',
        current: slugFromDedupe(key),
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
      await client.createOrReplace(
        doc as Parameters<typeof client.createOrReplace>[0]
      );
      synced++;
    } catch (e) {
      errors++;
      console.error(
        `[serpapi] Failed to upsert event "${title}":`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return { synced, skipped, errors };
}

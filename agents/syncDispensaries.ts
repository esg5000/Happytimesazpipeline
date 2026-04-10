import crypto from 'crypto';

import axios from 'axios';

import { config } from '../config';
import { getSanityClient, uploadImageToSanity } from './sanityPublisher';
import { generateSlug } from '../utils/slug';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

/**
 * Arizona statewide + Phoenix metro — city label and Google Maps search origin (`ll`).
 * Order: greater Phoenix area first, then other AZ cities. One `seen` dedupe set covers all
 * searches (place_id, else normalized name + address).
 */
const ARIZONA_SEARCH_LOCATIONS: readonly { name: string; ll: string }[] = [
  // Phoenix metro
  { name: 'Phoenix', ll: '@33.4484,-112.0740,12z' },
  { name: 'Scottsdale', ll: '@33.4942,-111.9261,12z' },
  { name: 'Tempe', ll: '@33.4255,-111.9400,12z' },
  { name: 'Mesa', ll: '@33.4155,-111.8315,12z' },
  { name: 'Glendale', ll: '@33.5387,-112.1860,12z' },
  { name: 'Peoria', ll: '@33.5806,-112.2374,12z' },
  { name: 'Chandler', ll: '@33.3062,-111.8413,12z' },
  { name: 'Gilbert', ll: '@33.3528,-111.7890,12z' },
  { name: 'Surprise', ll: '@33.6292,-112.3679,12z' },
  { name: 'Goodyear', ll: '@33.4353,-112.3579,12z' },
  { name: 'Sun City', ll: '@33.5979,-112.2719,12z' },
  { name: 'Fountain Hills', ll: '@33.6117,-111.7167,12z' },
  { name: 'Cave Creek', ll: '@33.8333,-111.9507,12z' },
  { name: 'Paradise Valley', ll: '@33.5312,-111.9426,12z' },
  // Rest of Arizona
  { name: 'Tucson', ll: '@32.2226,-110.9747,12z' },
  { name: 'Flagstaff', ll: '@35.1983,-111.6513,12z' },
  { name: 'Sedona', ll: '@34.8697,-111.7610,12z' },
  { name: 'Prescott', ll: '@34.5400,-112.4685,12z' },
  { name: 'Yuma', ll: '@32.6927,-114.6277,12z' },
  { name: 'Sierra Vista', ll: '@31.5545,-110.3037,12z' },
  { name: 'Kingman', ll: '@35.1894,-114.0530,12z' },
  { name: 'Safford', ll: '@32.8330,-109.7076,12z' },
  { name: 'Show Low', ll: '@34.2542,-110.0298,12z' },
  { name: 'Globe', ll: '@33.3942,-110.7865,12z' },
  { name: 'Casa Grande', ll: '@32.8795,-111.7574,12z' },
  { name: 'Bullhead City', ll: '@35.1478,-114.5683,12z' },
  { name: 'Lake Havasu City', ll: '@34.4839,-114.3225,12z' },
  { name: 'Cottonwood', ll: '@34.7392,-112.0099,12z' },
  { name: 'Payson', ll: '@34.2309,-111.3281,12z' },
  { name: 'Nogales', ll: '@31.3404,-110.9342,12z' },
  { name: 'Douglas', ll: '@31.3445,-109.5467,12z' },
  { name: 'Bisbee', ll: '@31.4481,-109.9284,12z' },
  { name: 'Winslow', ll: '@35.0242,-110.6974,12z' },
  { name: 'Williams', ll: '@35.2496,-112.1910,12z' },
];

type SerpLocalResult = {
  title?: string;
  address?: string;
  phone?: string;
  website?: string;
  hours?: string;
  open_state?: string;
  operating_hours?: Record<string, string>;
  thumbnail?: string;
  serpapi_thumbnail?: string;
  place_id?: string;
  types?: string[];
  type?: string;
  description?: string;
};

type SerpMapsResponse = {
  search_metadata?: { status?: string };
  error?: string;
  local_results?: SerpLocalResult[];
};

function normalizeKeyPart(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeKey(r: SerpLocalResult): string {
  if (r.place_id) return `pid:${r.place_id}`;
  const name = normalizeKeyPart(r.title || '');
  const addr = normalizeKeyPart(r.address || '');
  return `na:${name}|${addr}`;
}

function documentIdFromKey(dedupe: string): string {
  const hex = crypto.createHash('sha256').update(dedupe).digest('hex').slice(0, 32);
  return `dispensary-${hex}`;
}

function looksLikeCannabisDispensary(r: SerpLocalResult): boolean {
  const blob = [
    r.title || '',
    (r.types || []).join(' '),
    r.type || '',
    r.description || '',
  ]
    .join(' ')
    .toLowerCase();
  return /dispensary|cannabis|marijuana|weed|mmj|cbd|thc|recreational|medical/.test(blob);
}

function inferCategories(r: SerpLocalResult): string[] {
  const blob = [
    r.title,
    (r.types || []).join(' '),
    r.description || '',
    r.type || '',
  ]
    .join(' ')
    .toLowerCase();
  const out: string[] = [];
  if (/\bmedical\b|mmj|medicinal|\bmed\s+marijuana/.test(blob)) out.push('medical');
  if (/\brecreational\b|\badult[- ]?use|21\s*\+|rec\s+only/.test(blob)) out.push('recreational');
  if (out.length === 0) out.push('medical', 'recreational');
  return [...new Set(out)];
}

function formatHours(r: SerpLocalResult): string {
  if (r.operating_hours && typeof r.operating_hours === 'object') {
    const lines = Object.entries(r.operating_hours).map(([k, v]) => `${k}: ${v}`);
    if (lines.length > 0) return lines.join('\n');
  }
  if (typeof r.hours === 'string' && r.hours.trim()) return r.hours.trim();
  if (typeof r.open_state === 'string' && r.open_state.trim()) return r.open_state.trim();
  return '';
}

function parseCityFromAddress(address: string | undefined, fallbackCity: string): string {
  if (!address) return fallbackCity;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/\bAZ\b|Arizona/i.test(p) && i > 0) return parts[i - 1] || fallbackCity;
  }
  if (parts.length >= 2) return parts[parts.length - 2] || fallbackCity;
  return fallbackCity;
}

/** Max SerpApi `start` offset (Google Maps ~20 results per page; cap per SerpApi docs). */
function maxStartOffset(): number {
  const raw = process.env.DISPENSARY_SERP_MAX_START;
  const n = raw ? parseInt(raw, 10) : 100;
  if (!Number.isFinite(n) || n < 0) return 100;
  return Math.min(100, n);
}

type SyncDispensariesResult = {
  /** Unique dispensaries seen after dedupe (SerpApi + cross-city). */
  uniqueFound: number;
  /** Successfully written to Sanity. */
  saved: number;
  errors: number;
};

/**
 * SerpApi Google Maps (`engine=google_maps`, `type=search`) per Arizona search location, then upsert `dispensary` docs.
 * Deduplicates across **all** cities in one pass: `place_id` when present, else normalized name + address.
 */
export async function syncDispensariesToSanity(): Promise<SyncDispensariesResult> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  const client = getSanityClient();
  /** Global dedupe across every city query (same shop appearing in Phoenix + Mesa appears once). */
  const seen = new Set<string>();
  const maxStart = maxStartOffset();

  let uniqueFound = 0;
  let saved = 0;
  let errors = 0;

  console.log('[dispensaries] ========== syncDispensariesToSanity (SerpApi Google Maps) start ==========');
  console.log(
    `[dispensaries] ${ARIZONA_SEARCH_LOCATIONS.length} Arizona search locations (Phoenix metro + statewide); global dedupe by place_id or name+address`
  );

  for (const { name: cityName, ll } of ARIZONA_SEARCH_LOCATIONS) {
    const q = `cannabis dispensary ${cityName} Arizona`;
    console.log(`[dispensaries] City="${cityName}" q="${q}" ll=${ll}`);

    for (let start = 0; start <= maxStart; start += 20) {
      let data: SerpMapsResponse;
      let status: number;
      try {
        const res = await axios.get<SerpMapsResponse>(SERPAPI_SEARCH, {
          params: {
            engine: 'google_maps',
            type: 'search',
            q,
            ll,
            start,
            hl: 'en',
            gl: 'us',
            google_domain: 'google.com',
            api_key: config.serpApi.apiKey,
          },
          validateStatus: () => true,
        });
        data = res.data;
        status = res.status;
      } catch (e) {
        errors++;
        console.error(
          `[dispensaries] HTTP error city=${cityName} start=${start}:`,
          e instanceof Error ? e.message : e
        );
        break;
      }

      if (status !== 200 || data.error) {
        console.warn(
          `[dispensaries] city=${cityName} start=${start} http=${status} err=${data.error || 'n/a'}`
        );
        if (start === 0) break;
        break;
      }

      const locals = data.local_results || [];
      if (locals.length === 0) {
        console.log(`[dispensaries] city=${cityName} start=${start}: no local_results — end pagination`);
        break;
      }

      for (const raw of locals) {
        if (!looksLikeCannabisDispensary(raw)) continue;

        const title = raw.title?.trim() || '';
        if (!title) continue;

        const key = dedupeKey(raw);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueFound++;

        const _id = documentIdFromKey(key);
        const address = raw.address?.trim() || '';
        const city = parseCityFromAddress(raw.address, cityName);
        const phone = raw.phone?.trim() || '';
        const website = raw.website?.trim() || '';
        const hours = formatHours(raw);
        const categories = inferCategories(raw);
        const thumb = raw.thumbnail || raw.serpapi_thumbnail;

        let imageRef: { _type: 'image'; asset: { _type: 'reference'; _ref: string } } | undefined;
        if (thumb) {
          try {
            const assetId = await uploadImageToSanity(thumb, `dispensary-${_id.slice(0, 24)}.jpg`);
            imageRef = {
              _type: 'image',
              asset: { _type: 'reference', _ref: assetId },
            };
          } catch (e) {
            console.warn(
              `[dispensaries] Image upload failed "${title}":`,
              e instanceof Error ? e.message : e
            );
          }
        }

        const slugTail = _id.replace(/^dispensary-/, '').slice(0, 10);
        const slugCurrent = `${generateSlug(`${title} ${city}`)}-${slugTail}`.slice(0, 96);
        const doc: Record<string, unknown> = {
          _type: 'dispensary',
          _id,
          name: title,
          slug: { _type: 'slug', current: slugCurrent },
          address: address || undefined,
          city,
          phone: phone || undefined,
          website: website || undefined,
          hours: hours || undefined,
          categories,
          isActive: true,
          source: 'google_maps_serpapi',
        };

        if (raw.place_id) doc.googlePlaceId = raw.place_id;
        if (imageRef) doc.image = imageRef;

        try {
          await client.createOrReplace(doc as Parameters<typeof client.createOrReplace>[0]);
          saved++;
          console.log(`[dispensaries] Saved: "${title}" — ${city} [${_id}]`);
        } catch (e) {
          errors++;
          console.error(
            `[dispensaries] Sanity upsert failed "${title}":`,
            e instanceof Error ? e.message : e
          );
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    }
  }

  console.log(
    `[dispensaries] ========== end: uniqueFound=${uniqueFound}, saved=${saved}, errors=${errors} ==========`
  );
  return { uniqueFound, saved, errors };
}

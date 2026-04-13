/**
 * SerpAPI Google Maps → top 25 restaurants per Arizona city → Sanity `restaurant` documents.
 * Run: npx ts-node scripts/fetchRestaurants.ts   or   node scripts/fetchRestaurants.js
 */
import crypto from 'crypto';

import axios from 'axios';

import { config } from '../config';
import { getSanityClient, uploadImageToSanity } from '../agents/sanityPublisher';
import { generateSlug } from '../utils/slug';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

/** Cities requested: query + Maps origin `ll`. */
const CITIES: readonly { name: string; ll: string }[] = [
  { name: 'Phoenix', ll: '@33.4484,-112.0740,12z' },
  { name: 'Scottsdale', ll: '@33.4942,-111.9261,12z' },
  { name: 'Tempe', ll: '@33.4255,-111.9400,12z' },
  { name: 'Mesa', ll: '@33.4155,-111.8315,12z' },
  { name: 'Glendale', ll: '@33.5387,-112.1860,12z' },
  { name: 'Chandler', ll: '@33.3062,-111.8413,12z' },
  { name: 'Surprise', ll: '@33.6292,-112.3679,12z' },
];

const TARGET_TOP = 25;
const MAX_PAGES = 4;

type SerpMapsLocal = {
  title?: string;
  address?: string;
  phone?: string;
  website?: string;
  thumbnail?: string;
  serpapi_thumbnail?: string;
  place_id?: string;
  types?: string[];
  type?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  gps_coordinates?: { latitude?: number; longitude?: number };
};

type SerpMapsResponse = {
  search_metadata?: { status?: string };
  error?: string;
  local_results?: SerpMapsLocal[];
};

function validateEnv(): void {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is required');
  }
  if (!config.sanity.projectId || !config.sanity.apiToken) {
    throw new Error('SANITY_PROJECT_ID and SANITY_API_TOKEN are required');
  }
}

/** Rating × √(1 + reviews) — favors strong ratings with meaningful volume. */
function rankingScore(r: SerpMapsLocal): number {
  const rating = typeof r.rating === 'number' && Number.isFinite(r.rating) ? r.rating : 0;
  const reviews = typeof r.reviews === 'number' && Number.isFinite(r.reviews) ? r.reviews : 0;
  return rating * Math.sqrt(1 + reviews);
}

const GENERIC_TYPES = new Set(
  [
    'restaurant',
    'food',
    'point of interest',
    'establishment',
    'meal delivery',
    'meal takeaway',
  ].map((s) => s.toLowerCase())
);

function inferCuisine(type: string | undefined, types: string[] | undefined): string {
  const candidates = [...(types || [])];
  if (type?.trim()) candidates.unshift(type);
  for (const c of candidates) {
    const t = c.trim();
    if (!t) continue;
    if (GENERIC_TYPES.has(t.toLowerCase())) continue;
    return t;
  }
  return type?.trim() || 'Restaurant';
}

function priceToLevel(price: string | undefined): number | undefined {
  if (!price || typeof price !== 'string') return undefined;
  const p = price.trim();
  if (p.length >= 1 && /^[\$€£]+$/u.test(p)) {
    return Math.min(4, Math.max(1, p.length));
  }
  return undefined;
}

function isRestaurantLike(r: SerpMapsLocal): boolean {
  const types = (r.types || []).map((t) => t.toLowerCase());
  const primary = (r.type || '').toLowerCase();
  if (types.some((t) => t.includes('restaurant') || t.includes('cafe') || t.includes('diner'))) {
    return true;
  }
  if (types.some((t) => t.includes('bar ') || t.includes('grill') || t.includes('kitchen'))) {
    return true;
  }
  if (
    primary.includes('restaurant') ||
    primary.includes('cafe') ||
    primary.includes('diner') ||
    primary.includes('grill') ||
    primary.includes('bistro') ||
    primary.includes('steakhouse') ||
    primary.includes('pizzeria')
  ) {
    return true;
  }
  return false;
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

/** Stable _id per (searchCity, place) so each metro query keeps its own top-25 rows without cross-city overwrites. */
function stableDocumentId(r: SerpMapsLocal, searchCity: string): string {
  if (r.place_id && r.place_id.trim()) {
    const hex = crypto
      .createHash('sha256')
      .update(`pid:${searchCity}:${r.place_id.trim()}`)
      .digest('hex')
      .slice(0, 32);
    return `restaurant-${hex}`;
  }
  const name = (r.title || '').trim().toLowerCase();
  const addr = (r.address || '').trim().toLowerCase();
  const key = `na:${searchCity}|${name}|${addr}`;
  const hex = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `restaurant-${hex}`;
}

async function fetchMapsPage(
  q: string,
  ll: string,
  start: number
): Promise<{ ok: boolean; results: SerpMapsLocal[]; error?: string }> {
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
  if (res.status !== 200) {
    return { ok: false, results: [], error: `HTTP ${res.status}` };
  }
  const data = res.data;
  if (data.error) {
    return { ok: false, results: [], error: data.error };
  }
  return { ok: true, results: data.local_results || [] };
}

export async function runFetchRestaurants(): Promise<void> {
  validateEnv();
  const client = getSanityClient();

  console.log('[restaurants] SerpAPI Google Maps → Sanity `restaurant` (top 25 per city by rating × √(1+reviews))\n');

  for (const { name: searchCity, ll } of CITIES) {
    const q = `best restaurants ${searchCity} AZ`;
    const merged = new Map<string, SerpMapsLocal>();

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * 20;
      const { ok, results, error } = await fetchMapsPage(q, ll, start);
      if (!ok) {
        console.warn(`[restaurants] ${searchCity}: page start=${start} failed: ${error || 'unknown'}`);
        break;
      }
      if (results.length === 0) break;

      for (const r of results) {
        if (!isRestaurantLike(r)) continue;
        const title = r.title?.trim();
        if (!title) continue;
        const pid = r.place_id?.trim() || `fallback:${title}:${r.address || ''}`;
        const existing = merged.get(pid);
        if (!existing || rankingScore(r) > rankingScore(existing)) {
          merged.set(pid, r);
        }
      }

      if (merged.size >= TARGET_TOP * 2) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const ranked = [...merged.values()]
      .filter((r) => r.title?.trim())
      .sort((a, b) => rankingScore(b) - rankingScore(a))
      .slice(0, TARGET_TOP);

    let created = 0;
    let updated = 0;

    for (const r of ranked) {
      const title = r.title!.trim();
      const _id = stableDocumentId(r, searchCity);
      const address = r.address?.trim() || '';
      const city = parseCityFromAddress(r.address, searchCity);
      const phone = r.phone?.trim() || '';
      const website = r.website?.trim() || '';
      const cuisineType = inferCuisine(r.type, r.types);
      const rating = typeof r.rating === 'number' ? r.rating : undefined;
      const reviewCount = typeof r.reviews === 'number' ? r.reviews : undefined;
      const priceLevel = priceToLevel(r.price);
      const thumbUrl = r.thumbnail || r.serpapi_thumbnail;
      const lat = r.gps_coordinates?.latitude;
      const lng = r.gps_coordinates?.longitude;

      let thumbnail:
        | { _type: 'image'; asset: { _type: 'reference'; _ref: string } }
        | undefined;
      if (thumbUrl) {
        try {
          const assetId = await uploadImageToSanity(
            thumbUrl,
            `restaurant-${_id.replace(/^restaurant-/, '').slice(0, 20)}.jpg`
          );
          thumbnail = {
            _type: 'image',
            asset: { _type: 'reference', _ref: assetId },
          };
        } catch (e) {
          console.warn(
            `[restaurants] Thumbnail upload failed "${title}":`,
            e instanceof Error ? e.message : e
          );
        }
      }

      const slugTail = _id.replace(/^restaurant-/, '').slice(0, 10);
      const slugCurrent = `${generateSlug(`${title} ${searchCity}`)}-${slugTail}`.slice(0, 96);

      const doc: Record<string, unknown> = {
        _type: 'restaurant',
        _id,
        name: title,
        slug: { _type: 'slug', current: slugCurrent },
        searchCity,
        address: address || undefined,
        city,
        cuisineType,
        rating,
        reviewCount,
        phone: phone || undefined,
        website: website || undefined,
        source: 'google_maps_serpapi',
      };

      if (priceLevel !== undefined) doc.priceLevel = priceLevel;
      if (r.place_id) doc.googlePlaceId = r.place_id;
      if (thumbnail) doc.thumbnail = thumbnail;
      if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
        doc.location = { _type: 'geopoint', lat, lng };
      }

      try {
        const before = await client.getDocument(_id);
        await client.createOrReplace(doc as Parameters<typeof client.createOrReplace>[0]);
        if (before) updated++;
        else created++;
      } catch (e) {
        console.error(
          `[restaurants] Sanity upsert failed "${title}" (${searchCity}):`,
          e instanceof Error ? e.message : e
        );
      }

      await new Promise((r) => setTimeout(r, 150));
    }

    console.log(
      `[restaurants] ${searchCity}: done — created=${created}, updated=${updated}, candidates=${ranked.length}`
    );
  }

  console.log('\n[restaurants] All cities finished.');
}

if (require.main === module) {
  runFetchRestaurants().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

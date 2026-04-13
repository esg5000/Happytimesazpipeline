/**
 * SerpAPI Google Maps → top 25 restaurants per Arizona city → Sanity `restaurant` documents.
 * Run: npx ts-node scripts/fetchRestaurants.ts   or   node scripts/fetchRestaurants.js
 */
import crypto from 'crypto';

import axios from 'axios';
import type { SanityClient } from '@sanity/client';

import { config } from '../config';
import { getSanityClient } from '../agents/sanityPublisher';
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

/** Local result shape from SerpAPI (fields may be absent or wrong type at runtime). */
type SerpMapsLocal = {
  title?: unknown;
  address?: unknown;
  phone?: unknown;
  website?: unknown;
  thumbnail?: unknown;
  serpapi_thumbnail?: unknown;
  place_id?: unknown;
  types?: unknown;
  type?: unknown;
  rating?: unknown;
  reviews?: unknown;
  price?: unknown;
  gps_coordinates?: unknown;
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

/** Only accept real strings — never persist objects as Sanity string fields. */
function asNonEmptyString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readGpsCoordinates(raw: unknown): { lat: number; lng: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const lat = asFiniteNumber(o.latitude);
  const lng = asFiniteNumber(o.longitude);
  if (lat === undefined || lng === undefined) return undefined;
  return { lat, lng };
}

/** Rating × √(1 + reviews) — favors strong ratings with meaningful volume. */
function rankingScore(r: SerpMapsLocal): number {
  const rating = asFiniteNumber(r.rating) ?? 0;
  const reviews = asFiniteNumber(r.reviews) ?? 0;
  return rating * Math.sqrt(1 + reviews);
}

/** If SerpAPI ever wraps a URL in an object, extract a string; prefer plain `thumbnail` string. */
function extractSerpApiImageUrl(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const direct = asNonEmptyString(raw);
  if (direct) return direct;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['url', 'link', 'src', 'href', 'thumbnail', 'image']) {
      const inner = asNonEmptyString(o[k]);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** Store `thumbnail` as the SerpAPI URL string (primary field `thumbnail`). */
function resolveThumbnailUrlString(r: SerpMapsLocal): string | undefined {
  return (
    asNonEmptyString(r.thumbnail) ??
    asNonEmptyString(r.serpapi_thumbnail) ??
    extractSerpApiImageUrl(r.thumbnail) ??
    extractSerpApiImageUrl(r.serpapi_thumbnail)
  );
}

function priceToLevel(price: unknown): number | undefined {
  const priceStr = asNonEmptyString(price);
  if (!priceStr) return undefined;
  const p = priceStr;
  if (p.length >= 1 && /^[\$€£]+$/u.test(p)) {
    return Math.min(4, Math.max(1, p.length));
  }
  return undefined;
}

function isRestaurantLike(r: SerpMapsLocal): boolean {
  const types = asStringArray(r.types).map((t) => t.toLowerCase());
  const primary = (asNonEmptyString(r.type) ?? '').toLowerCase();
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
  const pid = asNonEmptyString(r.place_id);
  if (pid) {
    const hex = crypto
      .createHash('sha256')
      .update(`pid:${searchCity}:${pid}`)
      .digest('hex')
      .slice(0, 32);
    return `restaurant-${hex}`;
  }
  const name = (asNonEmptyString(r.title) ?? '').toLowerCase();
  const addr = (asNonEmptyString(r.address) ?? '').toLowerCase();
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

export type RestaurantCitySyncResult = {
  city: string;
  created: number;
  updated: number;
  candidates: number;
};

export type RunFetchRestaurantsOptions = {
  /** Called after each metro finishes (same seven cities as the CLI script). */
  onCityComplete?: (result: RestaurantCitySyncResult) => void;
};

async function syncRestaurantsForCity(
  client: SanityClient,
  searchCity: string,
  ll: string
): Promise<RestaurantCitySyncResult> {
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
      const title = asNonEmptyString(r.title);
      if (!title) continue;
      const addrKey = asNonEmptyString(r.address) ?? '';
      const pid =
        asNonEmptyString(r.place_id) || `fallback:${title}:${addrKey}`;
      const existing = merged.get(pid);
      if (!existing || rankingScore(r) > rankingScore(existing)) {
        merged.set(pid, r);
      }
    }

    if (merged.size >= TARGET_TOP * 2) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  const ranked = [...merged.values()]
    .filter((r) => asNonEmptyString(r.title))
    .sort((a, b) => rankingScore(b) - rankingScore(a))
    .slice(0, TARGET_TOP);

  let created = 0;
  let updated = 0;

  for (const r of ranked) {
    const title = asNonEmptyString(r.title)!;
    const _id = stableDocumentId(r, searchCity);
    const address = asNonEmptyString(r.address) ?? '';
    const city = parseCityFromAddress(asNonEmptyString(r.address), searchCity);
    const phone = asNonEmptyString(r.phone) ?? '';
    const website = asNonEmptyString(r.website) ?? '';
    /** SerpAPI `type` string only — never an object. */
    const cuisineType = asNonEmptyString(r.type);
    const rating = asFiniteNumber(r.rating);
    const reviewCount = asFiniteNumber(r.reviews);
    const priceLevel = priceToLevel(r.price);
    const thumbnailUrl = resolveThumbnailUrlString(r);
    const gps = readGpsCoordinates(r.gps_coordinates);
    const lat = gps?.lat;
    const lng = gps?.lng;

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
      ...(cuisineType !== undefined ? { cuisineType } : {}),
      rating,
      reviewCount,
      phone: phone || undefined,
      website: website || undefined,
      /** SerpAPI `engine` for this integration (`google_maps`). */
      source: 'google_maps',
    };

    if (priceLevel !== undefined) doc.priceLevel = priceLevel;
    const placeId = asNonEmptyString(r.place_id);
    if (placeId) doc.googlePlaceId = placeId;
    if (thumbnailUrl) doc.thumbnail = thumbnailUrl;
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

  return { city: searchCity, created, updated, candidates: ranked.length };
}

/**
 * Fetches top restaurants for Phoenix, Scottsdale, Tempe, Mesa, Glendale, Chandler, and Surprise, AZ.
 */
export async function runFetchRestaurants(
  options?: RunFetchRestaurantsOptions
): Promise<RestaurantCitySyncResult[]> {
  validateEnv();
  const client = getSanityClient();

  console.log('[restaurants] SerpAPI Google Maps → Sanity `restaurant` (top 25 per city by rating × √(1+reviews))\n');

  const results: RestaurantCitySyncResult[] = [];
  for (const { name: searchCity, ll } of CITIES) {
    const row = await syncRestaurantsForCity(client, searchCity, ll);
    results.push(row);
    options?.onCityComplete?.(row);
  }

  console.log('\n[restaurants] All cities finished.');
  return results;
}

if (require.main === module) {
  runFetchRestaurants().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

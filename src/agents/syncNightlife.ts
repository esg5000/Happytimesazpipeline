/**
 * SerpAPI Google Maps → top 25 bars/nightclubs (greater Phoenix metro) → Sanity `nightlife` documents.
 * Run: npm run sync-nightlife   or   npx ts-node src/agents/syncNightlife.ts
 *
 * Modeled after scripts/fetchRestaurants.ts: same SerpAPI Maps flow, helpers, and Sanity upsert pattern.
 */
import crypto from 'crypto';

import axios from 'axios';

import { config } from '../../config';
import { getSanityClient, uploadImageToSanity } from '../../agents/sanityPublisher';
import { generateSlug } from '../../utils/slug';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

/** SerpAPI `ll` (lat,lng,zoom) — Phoenix and Scottsdale anchors for metro queries. */
const PHOENIX_LL = '@33.4484,-112.0740,12z';
const SCOTTSDALE_LL = '@33.4942,-111.9261,12z';

const NIGHTLIFE_QUERIES: readonly { q: string; ll: string }[] = [
  { q: 'best bars Phoenix AZ', ll: PHOENIX_LL },
  { q: 'best nightclubs Phoenix AZ', ll: PHOENIX_LL },
  { q: 'best bars Scottsdale AZ', ll: SCOTTSDALE_LL },
  { q: 'best nightclubs Scottsdale AZ', ll: SCOTTSDALE_LL },
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

/** Rating × √(1 + reviews) — favors strong ratings with meaningful volume. */
function rankingScore(r: SerpMapsLocal): number {
  const rating = asFiniteNumber(r.rating) ?? 0;
  const reviews = asFiniteNumber(r.reviews) ?? 0;
  return rating * Math.sqrt(1 + reviews);
}

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

function resolveImageUrlString(r: SerpMapsLocal): string | undefined {
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

/** Keep Maps rows that look like bars, nightclubs, lounges, pubs, etc. */
function isNightlifeLike(r: SerpMapsLocal): boolean {
  const types = asStringArray(r.types).map((t) => t.toLowerCase());
  const primary = (asNonEmptyString(r.type) ?? '').toLowerCase();
  const typeHit = types.some((t) =>
    /\b(bar|night_club|pub|lounge|brewpub|wine_bar|cocktail|dive_bar|sports_bar|karaoke|disco|adult_entertainment)\b/.test(
      t
    )
  );
  const primaryHit = /\b(bar|night club|pub|lounge|nightclub|disco|karaoke|cocktail|club)\b/i.test(primary);
  return typeHit || primaryHit;
}

function parseCityFromAddress(address: string | undefined, fallbackCity: string): string {
  if (!address) return fallbackCity;
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/\bAZ\b|Arizona/i.test(p) && i > 0) return parts[i - 1] || fallbackCity;
  }
  if (parts.length >= 2) return parts[parts.length - 2] || fallbackCity;
  return fallbackCity;
}

/** Stable _id from Google `place_id` (global dedupe across all metro queries). */
function stableNightlifeDocumentId(r: SerpMapsLocal): string {
  const pid = asNonEmptyString(r.place_id);
  if (pid) {
    const hex = crypto.createHash('sha256').update(`nightlife:pid:${pid}`).digest('hex').slice(0, 32);
    return `nightlife-${hex}`;
  }
  const name = (asNonEmptyString(r.title) ?? '').toLowerCase();
  const addr = (asNonEmptyString(r.address) ?? '').toLowerCase();
  const key = `nightlife:na|${name}|${addr}`;
  const hex = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `nightlife-${hex}`;
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

export type SyncNightlifeResult = {
  created: number;
  updated: number;
  candidates: number;
};

/**
 * Fetches Google Maps local results for fixed Phoenix/Scottsdale bar & nightclub queries,
 * deduplicates by **Google Place ID** (fallback key when missing), ranks by rating × √(1+reviews),
 * and upserts the top **25** into Sanity as `nightlife` documents.
 */
export async function syncNightlifeToSanity(): Promise<SyncNightlifeResult> {
  validateEnv();
  const client = getSanityClient();

  console.log(
    '[nightlife] SerpAPI Google Maps → Sanity `nightlife` (top 25 metro-wide, dedupe by place_id)\n'
  );

  const mergedByPlaceId = new Map<string, SerpMapsLocal>();

  for (const { q, ll } of NIGHTLIFE_QUERIES) {
    console.log(`[nightlife] Query: "${q}" ll=${ll}`);
    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * 20;
      const { ok, results, error } = await fetchMapsPage(q, ll, start);
      if (!ok) {
        console.warn(`[nightlife] page start=${start} failed: ${error || 'unknown'}`);
        break;
      }
      if (results.length === 0) break;

      for (const r of results) {
        if (!isNightlifeLike(r)) continue;
        const title = asNonEmptyString(r.title);
        if (!title) continue;
        const addrKey = asNonEmptyString(r.address) ?? '';
        const placeKey = asNonEmptyString(r.place_id) || `fallback:${title}:${addrKey}`;
        const existing = mergedByPlaceId.get(placeKey);
        if (!existing || rankingScore(r) > rankingScore(existing)) {
          mergedByPlaceId.set(placeKey, r);
        }
      }

      if (mergedByPlaceId.size >= TARGET_TOP * 4) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const ranked = [...mergedByPlaceId.values()]
    .filter((r) => asNonEmptyString(r.title))
    .sort((a, b) => rankingScore(b) - rankingScore(a))
    .slice(0, TARGET_TOP);

  let created = 0;
  let updated = 0;

  for (const r of ranked) {
    const title = asNonEmptyString(r.title)!;
    const _id = stableNightlifeDocumentId(r);
    const address = asNonEmptyString(r.address) ?? '';
    const city = parseCityFromAddress(asNonEmptyString(r.address), 'Phoenix');
    const phone = asNonEmptyString(r.phone) ?? '';
    const website = asNonEmptyString(r.website) ?? '';
    const rating = asFiniteNumber(r.rating);
    const priceLevel = priceToLevel(r.price);
    const imageUrl = resolveImageUrlString(r);

    let imageRef: { _type: 'image'; asset: { _type: 'reference'; _ref: string } } | undefined;
    if (imageUrl) {
      try {
        const assetId = await uploadImageToSanity(imageUrl, `nightlife-${_id.slice(0, 24)}.jpg`);
        imageRef = {
          _type: 'image',
          asset: { _type: 'reference', _ref: assetId },
        };
      } catch (e) {
        console.warn(
          `[nightlife] Image upload failed "${title}":`,
          e instanceof Error ? e.message : e
        );
      }
    }

    const slugTail = _id.replace(/^nightlife-/, '').slice(0, 10);
    const slugCurrent = `${generateSlug(`${title} ${city}`)}-${slugTail}`.slice(0, 96);

    const doc: Record<string, unknown> = {
      _type: 'nightlife',
      _id,
      name: title,
      slug: { _type: 'slug', current: slugCurrent },
      address: address || undefined,
      city,
      phone: phone || undefined,
      website: website || undefined,
      rating,
      isActive: true,
    };

    if (priceLevel !== undefined) doc.priceLevel = priceLevel;
    const placeId = asNonEmptyString(r.place_id);
    if (placeId) doc.googlePlaceId = placeId;
    if (imageRef) doc.image = imageRef;

    try {
      const before = await client.getDocument(_id);
      await client.createOrReplace(doc as Parameters<typeof client.createOrReplace>[0]);
      if (before) updated++;
      else created++;
    } catch (e) {
      console.error(
        `[nightlife] Sanity upsert failed "${title}":`,
        e instanceof Error ? e.message : e
      );
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(
    `\n[nightlife] Done — created=${created}, updated=${updated}, candidates=${ranked.length}`
  );

  return { created, updated, candidates: ranked.length };
}

if (require.main === module) {
  syncNightlifeToSanity().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

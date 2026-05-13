import crypto from 'crypto';

import axios from 'axios';

import { config } from '../config';
import { getSanityClient, uploadImageToSanity } from './sanityPublisher';
import { generateSlug } from '../utils/slug';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

const STATEWIDE_QUERIES = ['cannabis dispensary Arizona', 'marijuana dispensary Arizona'];
const MAX_PAGES = 5;

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

type SyncDispensariesResult = {
  /** Unique dispensaries seen after dedupe (SerpApi + cross-city). */
  uniqueFound: number;
  /** Successfully patched in Sanity (existing records only). */
  saved: number;
  /** Skipped because no matching record exists in Sanity. */
  skipped: number;
  errors: number;
  serpApiCalls: number;
};

/**
 * SerpApi Google Maps (`engine=google_maps`, `type=search`) — two statewide Arizona queries,
 * 5 pages each (100 results per query, 200 total). Patch-only: never creates new Sanity records.
 * Deduplicates across both queries: `place_id` when present, else normalized name + address.
 */
export async function syncDispensariesToSanity(): Promise<SyncDispensariesResult> {
  if (!config.serpApi.apiKey) {
    throw new Error('SERPAPI_API_KEY is not set');
  }

  const client = getSanityClient();
  const seen = new Set<string>();

  // Pre-load all existing dispensary _ids so we never create new records.
  const existingIds = await client.fetch<string[]>(`*[_type == "dispensary"]._id`);
  const existingIdSet = new Set<string>(Array.isArray(existingIds) ? existingIds : []);
  console.log(`[dispensaries] ${existingIdSet.size} existing dispensary record(s) loaded — patch-only mode`);

  let uniqueFound = 0;
  let saved = 0;
  let skipped = 0;
  let errors = 0;
  let serpApiCalls = 0;

  console.log('[dispensaries] ========== syncDispensariesToSanity (SerpApi Google Maps) start ==========');
  console.log(`[dispensaries] ${STATEWIDE_QUERIES.length} statewide queries × ${MAX_PAGES} pages each; global dedupe by place_id or name+address`);

  for (const q of STATEWIDE_QUERIES) {
    console.log(`[dispensaries] Query="${q}"`);

    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * 20;
      let data: SerpMapsResponse;
      let status: number;
      try {
        serpApiCalls++;
        const res = await axios.get<SerpMapsResponse>(SERPAPI_SEARCH, {
          params: {
            engine: 'google_maps',
            type: 'search',
            q,
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
          `[dispensaries] HTTP error q="${q}" start=${start}:`,
          e instanceof Error ? e.message : e
        );
        break;
      }

      if (status !== 200 || data.error) {
        console.warn(
          `[dispensaries] q="${q}" start=${start} http=${status} err=${data.error || 'n/a'}`
        );
        break;
      }

      const locals = data.local_results || [];
      if (locals.length === 0) {
        console.log(`[dispensaries] q="${q}" start=${start}: no local_results — end pagination`);
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
        const city = parseCityFromAddress(raw.address, 'Arizona');
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

        if (!existingIdSet.has(_id)) {
          skipped++;
          console.log(`[dispensaries] SKIP (no existing record): "${title}" — ${city} [${_id}]`);
          continue;
        }

        // Build patch payload — only fields that have values.
        const patch: Record<string, unknown> = { source: doc.source };
        if (doc.address) patch.address = doc.address;
        if (doc.city) patch.city = doc.city;
        if (doc.phone) patch.phone = doc.phone;
        if (doc.website) patch.website = doc.website;
        if (doc.hours) patch.hours = doc.hours;
        if (doc.categories) patch.categories = doc.categories;
        if (doc.googlePlaceId) patch.googlePlaceId = doc.googlePlaceId;
        if (imageRef) patch.image = imageRef;

        try {
          await client.patch(_id).set(patch).commit();
          saved++;
          console.log(`[dispensaries] Patched: "${title}" — ${city} [${_id}]`);
        } catch (e) {
          errors++;
          console.error(
            `[dispensaries] Sanity patch failed "${title}":`,
            e instanceof Error ? e.message : e
          );
        }
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `[dispensaries] ========== end: uniqueFound=${uniqueFound}, saved=${saved}, skipped=${skipped}, errors=${errors} ==========`
  );
  return { uniqueFound, saved, skipped, errors, serpApiCalls };
}

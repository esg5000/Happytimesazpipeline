import axios from 'axios';

import { validateConfig } from '../config';
import { getSanityClient } from '../agents/sanityPublisher';

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';

/**
 * Nominatim usage policy (operations.osmfoundation.org/policies/nominatim):
 * max 1 req/sec for a one-off run (the stricter 4 req/min cap only applies to
 * scripts that run for >1 day or on a recurring schedule — this isn't one).
 * A descriptive User-Agent is required in place of an API key.
 */
const REQUEST_INTERVAL_MS = 1100;
const USER_AGENT = 'HappyTimesAZ-VenueGeocodeBackfill/1.0 (one-time internal backfill; contact via happytimesaz.com)';

/**
 * Generalized version of backfillDispensaryCoordinatesNominatim.ts (which stays as-is,
 * already run against production) — same approach, parameterized by Sanity doc type so
 * it covers restaurant and nightlife too. Set BACKFILL_TYPE=restaurant|nightlife|dispensary.
 */
const TYPE_CONFIG: Record<string, { hasIsActive: boolean }> = {
  restaurant: { hasIsActive: false },
  nightlife: { hasIsActive: true },
  dispensary: { hasIsActive: true },
};

type VenueRow = {
  _id: string;
  name: string;
  address: string;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
  importance?: number;
};

/**
 * Nominatim's free-text matcher frequently fails on suite/unit/apt designators mixed
 * into a street address. Two distinct patterns, both handled here:
 *
 * 1. Keyword-led ("Suite #1", "Suite A&B", "Suite C 3-4", "Ste #119") — everything from
 *    the keyword to the end of the street segment is dropped as one unit. (The original
 *    version of this function stripped "#1" and the "Suite" keyword as two separate
 *    passes — for "Suite #1" that left a dangling "Suite " that still failed to geocode,
 *    confirmed against real retry failures before this fix.)
 * 2. Bare suffix, no keyword ("B3", "E-100", "f104", trailing lone "b") — a trailing
 *    token that's letter(s)+digits (with an optional hyphen) or a single bare letter.
 *    Restricted to tokens containing a digit, or exactly one letter, so real street-type
 *    abbreviations (St, Ave, Rd, Blvd, Dr, Ln, Way, Pl, Ct, Cir, Pkwy, Hwy) are never
 *    mistaken for a unit — none of those contain a digit or are a single letter.
 */
function stripUnitDesignator(address: string): string {
  const commaIdx = address.indexOf(',');
  const street = commaIdx >= 0 ? address.slice(0, commaIdx) : address;
  const rest = commaIdx >= 0 ? address.slice(commaIdx) : '';

  let cleaned = street
    .replace(/\b(?:suite|ste\.?|unit|apt\.?|building|bldg\.?)\b.*$/i, '')
    .replace(/#\s*\S+/g, '')
    .trim();

  cleaned = cleaned.replace(/\s+(?:[A-Za-z]{1,3}-?\d{1,5}|[A-Za-z])$/, '').trim();

  return (cleaned + rest).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

/** Some addresses abbreviate "Route" as "Rte", which Nominatim's matcher sometimes chokes on. */
function expandRte(address: string): string {
  return address.replace(/\bRte\b\.?/gi, 'Route');
}

async function fetchVenuesMissingCoordinates(type: string, limit?: number, ids?: string[]): Promise<VenueRow[]> {
  const { hasIsActive } = TYPE_CONFIG[type];
  const sanityClient = getSanityClient();
  const query = `*[
    _type == "${type}" &&
    ${hasIsActive ? 'isActive == true &&' : ''}
    !defined(latitude) &&
    defined(address)
    ${ids && ids.length > 0 ? '&& _id in $ids' : ''}
  ] | order(_id asc)${limit ? `[0...${limit}]` : ''}{
    _id,
    name,
    address
  }`;
  const rows = await sanityClient.fetch<VenueRow[]>(query, ids && ids.length > 0 ? { ids } : {});
  return rows || [];
}

async function geocodeAddress(
  address: string
): Promise<{ ok: true; lat: number; lng: number; matchedName: string } | { ok: false; reason: string }> {
  let res;
  try {
    res = await axios.get<NominatimResult[]>(NOMINATIM_SEARCH, {
      params: { q: address, format: 'json', limit: 1, countrycodes: 'us' },
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
  } catch (err: unknown) {
    return { ok: false, reason: `HTTP error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status !== 200) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  const results = Array.isArray(res.data) ? res.data : [];
  if (results.length === 0) {
    return { ok: false, reason: 'No results' };
  }

  const top = results[0];
  const lat = top.lat !== undefined ? Number.parseFloat(top.lat) : NaN;
  const lng = top.lon !== undefined ? Number.parseFloat(top.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: 'Malformed lat/lon in response' };
  }

  return { ok: true, lat, lng, matchedName: top.display_name || '' };
}

async function patchCoordinates(id: string, lat: number, lng: number): Promise<void> {
  const sanityClient = getSanityClient();
  await sanityClient
    .patch(id)
    .set({
      latitude: lat,
      longitude: lng,
      location: { _type: 'geopoint', lat, lng },
    })
    .commit();
}

async function run(): Promise<void> {
  validateConfig();

  const type = process.env.BACKFILL_TYPE;
  if (!type || !(type in TYPE_CONFIG)) {
    console.error(`Set BACKFILL_TYPE to one of: ${Object.keys(TYPE_CONFIG).join(', ')}`);
    process.exit(1);
  }

  const limitEnv = process.env.BACKFILL_LIMIT;
  const limit = limitEnv ? Number.parseInt(limitEnv, 10) : undefined;
  if (limitEnv && (!limit || limit <= 0)) {
    console.error(`Invalid BACKFILL_LIMIT="${limitEnv}"`);
    process.exit(1);
  }

  const idsEnv = process.env.BACKFILL_IDS;
  const ids = idsEnv ? idsEnv.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  console.log(`Fetching ${type} documents missing latitude/longitude from Sanity${ids ? ` (scoped to ${ids.length} explicit id(s))` : ''}…`);
  const rows = await fetchVenuesMissingCoordinates(type, limit, ids);
  console.log(`Found ${rows.length} ${type}(s) to process${limit ? ` (limit=${limit})` : ''}.\n`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  const failures: { id: string; name: string; address: string; reason: string }[] = [];

  for (const row of rows) {
    console.log(`[${row._id}] "${row.name}" — ${row.address}`);

    let result = await geocodeAddress(row.address);
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));

    let candidate = row.address;
    if (!result.ok) {
      const stripped = stripUnitDesignator(row.address);
      if (stripped && stripped !== row.address) {
        console.log(`  retrying without unit/suite designator: "${stripped}"`);
        result = await geocodeAddress(stripped);
        candidate = stripped;
        await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));
      }
    }

    if (!result.ok) {
      const expanded = expandRte(candidate);
      if (expanded !== candidate) {
        console.log(`  retrying with "Rte" expanded to "Route": "${expanded}"`);
        result = await geocodeAddress(expanded);
        await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));
      }
    }

    if (!result.ok) {
      console.log(`  FAIL — ${result.reason}`);
      failed++;
      failures.push({ id: row._id, name: row.name, address: row.address, reason: result.reason });
      continue;
    }

    try {
      await patchCoordinates(row._id, result.lat, result.lng);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Sanity patch threw: ${msg}`);
      failed++;
      failures.push({ id: row._id, name: row.name, address: row.address, reason: `Sanity patch threw: ${msg}` });
      continue;
    }

    console.log(`  OK — lat=${result.lat}, lng=${result.lng}`);
    console.log(`  matched: ${result.matchedName}`);
    succeeded++;
  }

  console.log(`\n--- ${type} backfill complete ---`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${rows.length}`);
  if (failures.length > 0) {
    console.log('\nFailures (needs manual review):');
    for (const f of failures) {
      console.log(`  [${f.id}] "${f.name}" — "${f.address}" — ${f.reason}`);
    }
  }
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

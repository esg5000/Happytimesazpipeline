import axios from 'axios';

import { config, validateConfig } from '../config';
import { getSanityClient } from '../agents/sanityPublisher';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';

type DispensaryRow = {
  _id: string;
  name: string;
  googlePlaceId: string;
  address?: string;
};

type SerpPlaceResponse = {
  search_metadata?: { status?: string };
  error?: string;
  place_results?: {
    gps_coordinates?: { latitude?: number; longitude?: number };
  };
};

async function fetchDispensariesMissingCoordinates(limit?: number): Promise<DispensaryRow[]> {
  const sanityClient = getSanityClient();
  const query = `*[
    _type == "dispensary" &&
    isActive == true &&
    !defined(latitude) &&
    defined(googlePlaceId)
  ] | order(_id asc)${limit ? `[0...${limit}]` : ''}{
    _id,
    name,
    googlePlaceId,
    address
  }`;
  const rows = await sanityClient.fetch<DispensaryRow[]>(query);
  return rows || [];
}

/** One SerpApi Google Maps "place details" lookup by place_id — exact match, no name/address ambiguity. */
async function lookupCoordinates(
  placeId: string
): Promise<{ ok: true; lat: number; lng: number } | { ok: false; reason: string }> {
  let res;
  try {
    res = await axios.get<SerpPlaceResponse>(SERPAPI_SEARCH, {
      params: {
        engine: 'google_maps',
        place_id: placeId,
        hl: 'en',
        gl: 'us',
        api_key: config.serpApi.apiKey,
      },
      validateStatus: () => true,
    });
  } catch (err: unknown) {
    return { ok: false, reason: `HTTP error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (res.status !== 200) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }
  if (res.data.error) {
    return { ok: false, reason: `SerpApi error: ${res.data.error}` };
  }

  const coords = res.data.place_results?.gps_coordinates;
  const lat = coords?.latitude;
  const lng = coords?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: 'No gps_coordinates in place_results' };
  }

  return { ok: true, lat, lng };
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

  if (!config.serpApi.apiKey) {
    console.error('SERPAPI_API_KEY is not set — cannot run backfill.');
    process.exit(1);
  }

  const limitEnv = process.env.BACKFILL_LIMIT;
  const limit = limitEnv ? Number.parseInt(limitEnv, 10) : undefined;
  if (limitEnv && (!limit || limit <= 0)) {
    console.error(`Invalid BACKFILL_LIMIT="${limitEnv}"`);
    process.exit(1);
  }

  console.log('Fetching active dispensaries missing latitude/longitude from Sanity…');
  const rows = await fetchDispensariesMissingCoordinates(limit);
  console.log(`Found ${rows.length} dispensary(ies) to process${limit ? ` (limit=${limit})` : ''}.\n`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  const failures: { id: string; name: string; reason: string }[] = [];

  for (const row of rows) {
    console.log(`[${row._id}] "${row.name}" (place_id=${row.googlePlaceId})`);

    const result = await lookupCoordinates(row.googlePlaceId);
    if (!result.ok) {
      console.log(`  FAIL — ${result.reason}`);
      failed++;
      failures.push({ id: row._id, name: row.name, reason: result.reason });
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }

    try {
      await patchCoordinates(row._id, result.lat, result.lng);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL — Sanity patch threw: ${msg}`);
      failed++;
      failures.push({ id: row._id, name: row.name, reason: `Sanity patch threw: ${msg}` });
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }

    console.log(`  OK — lat=${result.lat}, lng=${result.lng}`);
    succeeded++;

    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\n--- Backfill complete ---');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${rows.length}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  [${f.id}] "${f.name}" — ${f.reason}`);
    }
  }
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

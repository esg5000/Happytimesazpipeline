import { getSanityClient } from '../agents/sanityPublisher';

/**
 * Read-only sanity audit for the Nominatim-backfilled restaurant/dispensary/nightlife
 * coordinates. Flags gross geocoding misses (a wrong match many miles away — the
 * AZ88 class of error) by checking each document's lat/lng against a real-world
 * center point + radius for its stated city. Does NOT auto-correct anything.
 *
 * This intentionally will not catch a wrong match a mile or two away within the same
 * city — only outliers clearly outside where that city plausibly is.
 */
const EARTH_RADIUS_MILES = 3958.8;

function distanceMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h));
}

/** Real-world city center + a generous radius (miles) covering that city's full metro footprint. */
const CITY_BOUNDS: Record<string, { lat: number; lng: number; radiusMiles: number }> = {
  'Apache Junction': { lat: 33.4151, lng: -111.5495, radiusMiles: 8 },
  Avondale: { lat: 33.4356, lng: -112.3496, radiusMiles: 8 },
  Bisbee: { lat: 31.4482, lng: -109.9284, radiusMiles: 6 },
  Buckeye: { lat: 33.3703, lng: -112.5838, radiusMiles: 12 },
  'Bullhead City': { lat: 35.1478, lng: -114.5683, radiusMiles: 10 },
  'Cave Creek': { lat: 33.8331, lng: -111.9509, radiusMiles: 8 },
  Chandler: { lat: 33.3062, lng: -111.8413, radiusMiles: 10 },
  'El Mirage': { lat: 33.6131, lng: -112.3238, radiusMiles: 6 },
  Flagstaff: { lat: 35.1983, lng: -111.6513, radiusMiles: 10 },
  'Fountain Hills': { lat: 33.6117, lng: -111.7176, radiusMiles: 6 },
  Gilbert: { lat: 33.3528, lng: -111.789, radiusMiles: 10 },
  Glendale: { lat: 33.5387, lng: -112.186, radiusMiles: 10 },
  Goodyear: { lat: 33.4353, lng: -112.3576, radiusMiles: 8 },
  Guadalupe: { lat: 33.3651, lng: -111.9646, radiusMiles: 4 },
  Kingman: { lat: 35.1894, lng: -114.053, radiusMiles: 8 },
  'Lake Havasu City': { lat: 34.4839, lng: -114.3226, radiusMiles: 8 },
  'Litchfield Park': { lat: 33.4931, lng: -112.3576, radiusMiles: 5 },
  Mesa: { lat: 33.4152, lng: -111.8315, radiusMiles: 12 },
  'New River': { lat: 33.8792, lng: -112.1329, radiusMiles: 6 },
  Payson: { lat: 34.2311, lng: -111.3229, radiusMiles: 6 },
  Peoria: { lat: 33.5806, lng: -112.2374, radiusMiles: 10 },
  Phoenix: { lat: 33.4484, lng: -112.074, radiusMiles: 18 },
  Prescott: { lat: 34.54, lng: -112.4685, radiusMiles: 8 },
  'Prescott Valley': { lat: 34.61, lng: -112.3157, radiusMiles: 6 },
  'Queen Creek': { lat: 33.2487, lng: -111.6343, radiusMiles: 6 },
  Safford: { lat: 32.834, lng: -109.7076, radiusMiles: 6 },
  Scottsdale: { lat: 33.4942, lng: -111.9261, radiusMiles: 14 },
  'Show Low': { lat: 34.2542, lng: -110.0298, radiusMiles: 6 },
  'Sierra Vista': { lat: 31.5545, lng: -110.3037, radiusMiles: 6 },
  Somerton: { lat: 32.5964, lng: -114.7086, radiusMiles: 6 },
  Sonoita: { lat: 31.6759, lng: -110.6321, radiusMiles: 6 },
  'Sun City': { lat: 33.5983, lng: -112.2716, radiusMiles: 6 },
  Surprise: { lat: 33.6292, lng: -112.3679, radiusMiles: 10 },
  Tempe: { lat: 33.4255, lng: -111.94, radiusMiles: 8 },
  Tolleson: { lat: 33.45, lng: -112.2585, radiusMiles: 5 },
  Tucson: { lat: 32.2226, lng: -110.9747, radiusMiles: 15 },
  Youngtown: { lat: 33.6017, lng: -112.3007, radiusMiles: 4 },
};

type VenueRow = {
  _id: string;
  _type: string;
  name: string;
  city?: string;
  latitude: number;
  longitude: number;
};

async function fetchBackfilledVenues(): Promise<VenueRow[]> {
  const sanityClient = getSanityClient();
  const query = `*[
    (_type == "dispensary" && isActive == true) ||
    _type == "restaurant" ||
    (_type == "nightlife" && isActive == true)
  ] | order(_type asc, _id asc) [defined(latitude) && defined(longitude)] {
    _id,
    _type,
    name,
    city,
    latitude,
    longitude
  }`;
  const rows = await sanityClient.fetch<VenueRow[]>(query);
  return rows || [];
}

async function run(): Promise<void> {
  const rows = await fetchBackfilledVenues();
  console.log(`Auditing ${rows.length} backfilled coordinate(s)…\n`);

  let ok = 0;
  const flagged: { row: VenueRow; distance: number; reason: string }[] = [];
  const unknownCity: VenueRow[] = [];

  for (const row of rows) {
    const city = row.city;
    const bounds = city ? CITY_BOUNDS[city] : undefined;
    if (!bounds) {
      unknownCity.push(row);
      continue;
    }
    const distance = distanceMiles(bounds.lat, bounds.lng, row.latitude, row.longitude);
    if (distance > bounds.radiusMiles) {
      flagged.push({
        row,
        distance,
        reason: `${distance.toFixed(1)} mi from ${city} center (expected within ${bounds.radiusMiles} mi)`,
      });
    } else {
      ok++;
    }
  }

  console.log('--- Audit complete ---');
  console.log(`  Within expected range: ${ok}`);
  console.log(`  Flagged as likely bad: ${flagged.length}`);
  console.log(`  Unrecognized city (skipped): ${unknownCity.length}`);
  console.log(`  Total audited:          ${rows.length}`);

  if (flagged.length > 0) {
    console.log('\nFlagged for manual review (NOT auto-corrected):');
    for (const f of flagged) {
      console.log(`  [${f.row._type}/${f.row._id}] "${f.row.name}" (${f.row.city}) — ${f.reason}`);
    }
  }
  if (unknownCity.length > 0) {
    console.log('\nUnrecognized city values (add to CITY_BOUNDS to audit these):');
    for (const u of unknownCity) {
      console.log(`  [${u._type}/${u._id}] "${u.name}" — city="${u.city}"`);
    }
  }
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

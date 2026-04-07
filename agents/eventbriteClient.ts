import axios from 'axios';

import { config } from '../config';

const EVENTBRITE_API = 'https://www.eventbriteapi.com/v3';

export type EventbriteVenue = {
  name?: string;
  address?: {
    address_1?: string;
    address_2?: string;
    city?: string;
    region?: string;
    postal_code?: string;
    localized_address_display?: string;
  };
};

export type EventbriteEventSummary = {
  id: string;
  name?: { text?: string };
  description?: { text?: string };
  start?: { utc?: string; timezone?: string };
  end?: { utc?: string };
  url?: string;
  logo?: { original?: { url?: string } };
  venue?: EventbriteVenue;
  venue_id?: string;
  is_free?: boolean;
  category_id?: string;
  subcategory_id?: string;
  ticket_availability?: {
    minimum_ticket_price?: { major_value?: string; currency?: string };
    is_free?: boolean;
  };
};

type SearchResponse = {
  events?: EventbriteEventSummary[];
  pagination?: {
    page_number?: number;
    page_count?: number;
    has_more_items?: boolean;
  };
};

function authHeaders() {
  return {
    Authorization: `Bearer ${config.eventbrite.apiToken}`,
    Accept: 'application/json',
  };
}

/**
 * Phoenix / Scottsdale AZ only — venue city or address text must match.
 */
export function isPhoenixScottsdaleVenue(venue: EventbriteVenue | undefined): boolean {
  if (!venue?.address) return false;
  const a = venue.address;
  const city = (a.city || '').toLowerCase().trim();
  const region = (a.region || '').toUpperCase();
  const blob = [
    city,
    a.address_1 || '',
    a.address_2 || '',
    a.localized_address_display || '',
  ]
    .join(' ')
    .toLowerCase();

  if (region && region !== 'AZ') {
    return blob.includes('phoenix') || blob.includes('scottsdale');
  }
  return city === 'phoenix' || city === 'scottsdale' || /phoenix|scottsdale/i.test(blob);
}

/**
 * Fetches upcoming Eventbrite events near Phoenix, AZ for the next `days` days.
 * Uses GET /v3/events/search/ (requires a valid private token; availability may depend on Eventbrite account access).
 */
export async function fetchPhoenixAreaEvents(days: number): Promise<EventbriteEventSummary[]> {
  if (!config.eventbrite.apiToken) {
    throw new Error('EVENTBRITE_API_TOKEN is not set');
  }

  const rangeStart = new Date();
  rangeStart.setMilliseconds(0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + days);

  const all: EventbriteEventSummary[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const http = await axios.get<SearchResponse | { error?: string; error_description?: string }>(
      `${EVENTBRITE_API}/events/search/`,
      {
        headers: authHeaders(),
        params: {
          'location.address': 'Phoenix, AZ',
          'location.within': '25mi',
          'start_date.range_start': rangeStart.toISOString().split('.')[0] + 'Z',
          'start_date.range_end': rangeEnd.toISOString().split('.')[0] + 'Z',
          expand: 'venue,logo,ticket_availability',
          page,
        },
        validateStatus: () => true,
      }
    );

    const data = http.data;
    if (http.status >= 400) {
      const err = data as { error_description?: string; error?: string };
      throw new Error(
        `Eventbrite HTTP ${http.status}: ${err.error_description || err.error || 'request failed'}`
      );
    }

    if (data && typeof data === 'object' && 'error' in data && !('events' in data)) {
      const err = data as { error?: string; error_description?: string };
      throw new Error(
        err.error_description || err.error || 'Eventbrite search error'
      );
    }

    const res = data as SearchResponse;
    const events = res.events || [];
    for (const ev of events) {
      if (!ev.id) continue;
      if (!isPhoenixScottsdaleVenue(ev.venue)) continue;
      all.push(ev);
    }

    const pag = res.pagination;
    hasMore = Boolean(pag?.has_more_items);
    page += 1;
    if (!pag?.has_more_items) break;
    if (page > 50) break;
  }

  return all;
}

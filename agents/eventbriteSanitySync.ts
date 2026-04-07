import { getSanityClient, uploadImageToSanity } from './sanityPublisher';
import {
  fetchPhoenixAreaEvents,
  type EventbriteEventSummary,
} from './eventbriteClient';

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatPrice(ev: EventbriteEventSummary): string {
  const ta = ev.ticket_availability;
  if (ta?.is_free || ev.is_free) return 'Free';
  const major = ta?.minimum_ticket_price?.major_value;
  const cur = ta?.minimum_ticket_price?.currency || 'USD';
  if (major) return `${cur === 'USD' ? '$' : cur + ' '}${major}`;
  return '';
}

function venueLine(ev: EventbriteEventSummary): string {
  const v = ev.venue;
  if (!v) return '';
  const parts = [
    v.address?.address_1,
    v.address?.address_2,
  ].filter(Boolean);
  return parts.join(', ');
}

function cityField(ev: EventbriteEventSummary): string {
  return (ev.venue?.address?.city || '').trim();
}

function categoriesFor(ev: EventbriteEventSummary): string[] {
  const out: string[] = [];
  if (ev.category_id) out.push(ev.category_id);
  if (ev.subcategory_id) out.push(ev.subcategory_id);
  if (out.length === 0) out.push('events');
  return out;
}

/**
 * Creates new `event` documents in Sanity for Eventbrite events not yet synced.
 * Deduplicates by `eventbriteEventId`.
 */
export async function syncEventbriteEventsToSanity(): Promise<{
  created: number;
  skipped: number;
  errors: number;
}> {
  const client = getSanityClient();
  const existingIds = await client.fetch<string[]>(
    `*[_type == "event" && defined(eventbriteEventId)].eventbriteEventId`
  );
  const seen = new Set(existingIds || []);

  const events = await fetchPhoenixAreaEvents(30);
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const ev of events) {
    if (!ev.id || seen.has(ev.id)) {
      skipped++;
      continue;
    }

    const title = ev.name?.text?.trim() || 'Untitled event';
    const startRaw = ev.start?.utc;
    const endRaw = ev.end?.utc;
    if (!startRaw) {
      skipped++;
      continue;
    }

    const description = ev.description?.text
      ? stripHtml(ev.description.text).slice(0, 30000)
      : '';

    let imageAssetId: string | undefined;
    const logoUrl = ev.logo?.original?.url;
    if (logoUrl) {
      try {
        imageAssetId = await uploadImageToSanity(
          logoUrl,
          `eventbrite-${ev.id}-logo.jpg`
        );
      } catch (e) {
        console.warn(
          `[eventbrite] Could not upload logo for ${ev.id}:`,
          e instanceof Error ? e.message : e
        );
      }
    }

    const slugCurrent = `eventbrite-${ev.id}`;

    const doc: Record<string, unknown> = {
      _type: 'event',
      _id: `event-eb-${ev.id}`,
      title,
      slug: {
        _type: 'slug',
        current: slugCurrent,
      },
      date: startRaw,
      endDate: endRaw || startRaw,
      venue: ev.venue?.name || '',
      address: venueLine(ev),
      city: cityField(ev),
      description,
      price: formatPrice(ev),
      categories: categoriesFor(ev),
      isActive: true,
      source: 'eventbrite',
      eventbriteEventId: ev.id,
    };

    if (ev.url) {
      doc.ticketUrl = ev.url;
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
      await client.createOrReplace(doc as Parameters<typeof client.createOrReplace>[0]);
      seen.add(ev.id);
      created++;
    } catch (e) {
      errors++;
      console.error(
        `[eventbrite] Failed to create event for ${ev.id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return { created, skipped, errors };
}

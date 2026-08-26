/**
 * Events Roundup — standalone, content-assembly-from-owned-data script.
 *
 * Explicitly separate from syncNewsV2/orchestratorV2: this does not discover
 * or search anything. It queries event documents already synced into Sanity
 * (by agents/serpApiEventsSync.ts's Ticketmaster/Google Events sync, which
 * this file never imports or touches) and writes a narrative roundup article
 * around a handful of them.
 *
 * Scope decision (see investigation this session): the `event` schema has no
 * genre field — `categories` is hardcoded to the sync source name, not a
 * genre. The real genre signal lives in Ticketmaster-sourced events'
 * `description` field ("Music — Rock — Alternative Rock"). A live count of
 * the next 7 days' events showed ~20/32 (62.5%) tagged "Music", with zero
 * nightlife/bar or family-event content in this data at all (this feed is a
 * ticketed-events sync, not a community calendar) — so this script covers
 * ONE roundup type (concerts), not the "2-3 types/week" originally
 * considered; there isn't enough distinct real content for the others yet.
 *
 * Reuses the existing writer/publish stack wholesale — no new writing or
 * publish path: agents/writerAgent.ts's `sourceNotes` mechanism (the same
 * one Dig & Write uses for editor-supplied notes) is exactly built for
 * "here is trusted material, write prose around it, don't invent or
 * search for anything else" — a perfect fit since this data is Sanity's own
 * already-trusted structured data, not something needing fact-verification
 * against external sources. Hero image sourcing (Unsplash first, gpt-image-1
 * fallback) and the publish call mirror orchestrator.ts's existing pattern
 * exactly. Publishes as a DRAFT (publishedAt: null via
 * publishArticleToSanity), same as every other writer-path article — a
 * human reviews before it goes live, this script does not auto-publish live.
 */
import { getSanityClient, uploadImageBufferToSanity, publishArticleToSanity, getExistingSlugs } from './sanityPublisher';
import { writeArticle, HAPPYTIMESAZ_EDITORIAL_AUTHOR } from './writerAgent';
import { generateImagePrompt, generateImage } from './imageAgent';
import { fetchUnsplashHeroImageBuffer } from './unsplashHero';
import { scoreArticleQuality } from './editorAgent';
import { ensureUniqueSlug } from '../utils/slug';
import type { Topic } from '../utils/validator';

const LOOKAHEAD_DAYS = 7;
/** Below this many real candidates, skip the run rather than publish a thin/padded roundup. */
const MIN_EVENTS_REQUIRED = 4;
/** Upper bound on how many events one roundup features. */
const MAX_EVENTS_FEATURED = 6;

type RoundupEvent = {
  _id: string;
  title: string;
  date: string;
  venue?: string;
  city?: string;
  description?: string;
  price?: string;
  ticketUrl?: string;
};

async function fetchUpcomingMusicEvents(): Promise<RoundupEvent[]> {
  const client = getSanityClient();
  const now = new Date();
  const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  return client.fetch<RoundupEvent[]>(
    `*[_type == "event" && isActive == true && date >= $now && date <= $end && string::startsWith(description, "Music")] | order(date asc) {
      _id, title, date, venue, city, description, price, ticketUrl
    }`,
    { now: now.toISOString(), end: end.toISOString() }
  );
}

/**
 * Picks up to `max` events favoring venue variety — real events are heavily
 * clustered at a handful of touring venues/amphitheaters, and a roundup
 * that's 4 of 6 picks from the same venue reads as lazy, not curated.
 * Backfills from repeat venues only if there aren't enough distinct-venue
 * events to reach `max`. Re-sorted by date at the end so the roundup still
 * reads chronologically regardless of selection order.
 */
function selectFeaturedEvents(events: RoundupEvent[], max: number): RoundupEvent[] {
  const seenVenues = new Set<string>();
  const primary: RoundupEvent[] = [];
  const overflow: RoundupEvent[] = [];
  for (const e of events) {
    const venueKey = (e.venue || '').toLowerCase().trim();
    if (venueKey && seenVenues.has(venueKey)) {
      overflow.push(e);
    } else {
      if (venueKey) seenVenues.add(venueKey);
      primary.push(e);
    }
  }
  return [...primary, ...overflow]
    .slice(0, max)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Drops the leading "Music" segment from a Ticketmaster genre string, e.g. "Music — Rock — Alternative Rock" -> "Rock / Alternative Rock". */
function parseGenre(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const parts = description.split('—').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(' / ') : undefined;
}

function formatEventDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Phoenix',
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Phoenix',
  });
}

/**
 * Formatted as `writeArticle`'s `sourceNotes` — the PRIMARY SOURCE MATERIAL
 * block the model is instructed to write around, not invent beyond. See
 * prompts/sections/events.prompt.txt's explicit rule: only real dates/venues
 * from source material, never fabricated.
 */
function buildSourceNotes(events: RoundupEvent[]): string {
  return events
    .map((e, i) => {
      const genre = parseGenre(e.description);
      const lines = [
        `${i + 1}. "${e.title}"`,
        `   Venue: ${e.venue || 'TBD'}${e.city ? `, ${e.city}, AZ` : ''}`,
        `   When: ${formatEventDateTime(e.date)}`,
      ];
      if (genre) lines.push(`   Genre: ${genre}`);
      if (e.price) lines.push(`   Price: ${e.price}`);
      if (e.ticketUrl) lines.push(`   Tickets: ${e.ticketUrl}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

export type EventsRoundupResult =
  | { status: 'skipped'; reason: string; eventCount: number }
  | { status: 'published'; sanityId: string; title: string; featuredEventIds: string[] }
  | { status: 'failed'; reason: string };

export async function runEventsRoundup(): Promise<EventsRoundupResult> {
  console.log('[events-roundup] Querying upcoming music-genre events...');
  const events = await fetchUpcomingMusicEvents();
  console.log(
    `[events-roundup] Found ${events.length} upcoming music-genre event(s) in the next ${LOOKAHEAD_DAYS} days.`
  );

  if (events.length < MIN_EVENTS_REQUIRED) {
    const reason = `Only ${events.length} upcoming music event(s) found (need at least ${MIN_EVENTS_REQUIRED}) — skipping this run rather than publishing a thin roundup.`;
    console.warn(`[events-roundup] SKIP: ${reason}`);
    return { status: 'skipped', reason, eventCount: events.length };
  }

  const featured = selectFeaturedEvents(events, MAX_EVENTS_FEATURED);
  console.log(
    `[events-roundup] Featuring ${featured.length} event(s): ${featured.map((e) => `"${e.title}"`).join(', ')}`
  );

  const dateRangeLabel = `${formatShortDate(featured[0].date)}–${formatShortDate(featured[featured.length - 1].date)}`;

  const topic: Topic = {
    title: `Weekly concert roundup: live music in the Valley (${dateRangeLabel})`,
    section: 'events',
    description: `A roundup previewing ${featured.length} concerts happening around the Phoenix metro area over the next week, spanning a range of venues and genres.`,
    keywords: ['concerts', 'live music', 'Phoenix', 'Valley events', 'things to do', 'this week'],
  };

  const sourceNotes = buildSourceNotes(featured);

  console.log('[events-roundup] Writing article (writeArticle + sourceNotes, no search/discovery)...');
  const article = await writeArticle(topic, { sourceNotes });

  console.log('[events-roundup] Editor quality check...');
  let editorScore: number | null = null;
  let editorReason = '';
  try {
    const editorResult = await scoreArticleQuality(article);
    editorScore = editorResult.score;
    editorReason = editorResult.reason;
  } catch (e) {
    console.warn(
      `[events-roundup] Editor check failed (publishing anyway): ${e instanceof Error ? e.message : e}`
    );
  }
  if (editorScore !== null && editorScore < 6) {
    const reason = `Editor SKIP: scored ${editorScore}/10 — ${editorReason}`;
    console.warn(`[events-roundup] ${reason}`);
    return { status: 'failed', reason };
  }

  const existingSlugs = await getExistingSlugs();
  const finalArticle = { ...article, slug: ensureUniqueSlug(article.slug, existingSlugs) };

  console.log('[events-roundup] Sourcing hero image (Unsplash first, gpt-image-1 fallback)...');
  let imageBuf: Buffer | null = await fetchUnsplashHeroImageBuffer(finalArticle.title, topic.section);
  if (imageBuf) {
    console.log('[events-roundup] Hero image from Unsplash.');
  } else {
    console.log('[events-roundup] Unsplash returned nothing; falling back to gpt-image-1...');
    const enhancedPrompt = await generateImagePrompt(finalArticle.heroImagePrompt, finalArticle.visualStyle);
    imageBuf = await generateImage(enhancedPrompt);
    if (imageBuf) {
      console.log('[events-roundup] Hero image from gpt-image-1.');
    } else {
      console.warn('[events-roundup] Both Unsplash and gpt-image-1 failed; publishing without a hero image.');
    }
  }

  let imageAssetId: string | undefined;
  if (imageBuf) {
    console.log('[events-roundup] Uploading hero image to Sanity...');
    imageAssetId = await uploadImageBufferToSanity(imageBuf, `${finalArticle.slug}-hero.jpg`);
  }

  console.log('[events-roundup] Publishing to Sanity as a draft (same as every other writer-path article)...');
  const sanityId = await publishArticleToSanity(finalArticle, imageAssetId, 'events', undefined, {
    authorName: HAPPYTIMESAZ_EDITORIAL_AUTHOR,
  });
  console.log(`[events-roundup] Published draft: ${sanityId} — "${finalArticle.title}"`);

  return {
    status: 'published',
    sanityId,
    title: finalArticle.title,
    featuredEventIds: featured.map((e) => e._id),
  };
}

if (require.main === module) {
  runEventsRoundup()
    .then((result) => {
      console.log('\n[events-roundup] RESULT:', JSON.stringify(result, null, 2));
      process.exit(result.status === 'failed' ? 1 : 0);
    })
    .catch((err) => {
      console.error('[events-roundup] Fatal:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

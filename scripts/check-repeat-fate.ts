import { getSanityClient } from '../agents/sanityPublisher';

async function main() {
  const client = getSanityClient();
  const rows = await client.fetch<any[]>(
    `*[_type == "topicCandidate"]{ _id, title, sourceUrl, section, status, discoveredAt, processingNote } | order(discoveredAt asc)`
  );

  const repeatUrls = [
    'https://www.independent.co.uk/news/world/americas/marijuana-cannabis-kiosk-arizona-retirement-community-b3025872.html',
    'https://www.arizonafoothillsmagazine.com/taste/phoenix-food-and-restaurant-news/vecina-opens-new-location-in-mccormick-ranch',
    'https://www.phoenixmag.com/2026/09/02/august-2026-openings-closings/',
    'https://www.phoenixnewtimes.com/arts-culture/best-labor-day-weekend-parties-phoenix-2026-40694993/',
    'https://mouthbysouthwest.com/2026/09/02/justin-piazzas-new-concept-grandioso-soft-opens-on-grand-avenue/',
    'https://mouthbysouthwest.com/2026/09/03/restaurants-bars-opening-soon-in-phoenix/',
    'https://www.phoenixnewtimes.com/arts-culture/420-in-phoenix-your-guide-to-the-best-parties-and-weed-deals-in-2026-40660041/',
  ];

  for (const url of repeatUrls) {
    const copies = rows.filter((r) => r.sourceUrl === url);
    console.log(`\n"${copies[0].title}"`);
    for (const c of copies) {
      console.log(`  [${c.discoveredAt}] status=${c.status}${c.processingNote ? ` note="${c.processingNote}"` : ''} _id=${c._id}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

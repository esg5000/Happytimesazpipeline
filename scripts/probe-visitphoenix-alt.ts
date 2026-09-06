import axios from 'axios';
import { config } from '../config';

const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';

const QUERIES = [
  'VisitPhoenix.com events Phoenix',
  '"Visit Phoenix" Arizona event',
  'Phoenix visitor bureau event calendar',
];

function buildUrl(q: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=nws&gl=us&hl=en`;
}

async function resolveGoogleRedirectLink(link: string) {
  if (link.startsWith('http')) return link;
  if (!link.startsWith('/')) return undefined;
  try {
    const res = await axios.get(`https://www.google.com${link}`, {
      maxRedirects: 0, validateStatus: () => true, timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const loc = res.headers.location;
    return res.status >= 300 && res.status < 400 && typeof loc === 'string' && loc.startsWith('http') ? loc : undefined;
  } catch { return undefined; }
}

async function main() {
  for (const q of QUERIES) {
    console.log(`\n=== "${q}" ===`);
    const start = Date.now();
    const { data, status } = await axios.post(BRIGHTDATA_REQUEST_URL,
      { zone: config.brightData.zone, url: buildUrl(q), format: 'json' },
      { headers: { Authorization: `Bearer ${config.brightData.apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true });
    console.log(`  ${Date.now()-start}ms status=${status}`);
    if (status !== 200 || typeof data.body !== 'string') { console.log('  no body'); continue; }
    const parsed = JSON.parse(data.body);
    const raw = (parsed.news || []).filter((e: any) => e && e.title && e.link);
    console.log(`  ${raw.length} raw results`);
    const resolved = await Promise.all(raw.map((r: any) => resolveGoogleRedirectLink(r.link)));
    raw.forEach((r: any, i: number) => {
      if (!resolved[i]) return;
      console.log(`    - "${r.title}" [${r.source}] ${r.date}`);
      console.log(`      ${resolved[i]}`);
    });
  }
}
main().catch(e => { console.error(e); process.exit(1); });

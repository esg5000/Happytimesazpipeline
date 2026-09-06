/**
 * Diagnostic for candidate new lifestyle-az Stage 0 queries (VisitPhoenix,
 * ExperienceScottsdale, WestWorld of Scottsdale, Visit Mesa/Tempe) — run each
 * candidate query directly against Bright Data (primary) with a SerpAPI
 * fallback on error/timeout/non-200/empty, mirroring fetchStage0NewsForQuery
 * in src/agents/topicDiscovery.ts, WITHOUT running the full 40-query
 * STAGE0_QUERIES set. Same diagnostic pattern used to catch the
 * site:mouthbysouthwest.com timeout previously. Not wired into any pipeline
 * entry point — throwaway script, prints raw results for manual review.
 */
import axios from 'axios';

import { config } from '../config';

const SERPAPI_SEARCH = 'https://serpapi.com/search.json';
const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';
const BRIGHTDATA_TIMEOUT_MS = 30_000;

const CANDIDATE_QUERIES: { label: string; query: string }[] = [
  { label: 'VisitPhoenix.com', query: '"VisitPhoenix" event OR festival' },
  { label: 'ExperienceScottsdale.com', query: '"Experience Scottsdale" event OR festival' },
  { label: 'WestWorldAZ.com', query: '"WestWorld of Scottsdale" event' },
  { label: 'VisitMesa.com / VisitTempe.com', query: '"Visit Mesa" event OR "Visit Tempe" event' },
];

function buildGoogleNewsSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=nws&gl=us&hl=en`;
}

async function resolveGoogleRedirectLink(link: string): Promise<string | undefined> {
  if (link.startsWith('http')) return link;
  if (!link.startsWith('/')) return undefined;
  try {
    const res = await axios.get(`https://www.google.com${link}`, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 8_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const location = res.headers.location;
    return res.status >= 300 && res.status < 400 && typeof location === 'string' && location.startsWith('http')
      ? location
      : undefined;
  } catch {
    return undefined;
  }
}

type ProbeItem = { title: string; link: string; snippet?: string; source?: string; date?: string };

async function probeBrightData(query: string): Promise<{ items: ProbeItem[]; error?: string }> {
  if (!config.brightData.apiKey) return { items: [], error: 'BRIGHTDATA_API_KEY not set' };

  const start = Date.now();
  try {
    const { data, status } = await axios.post<{ body?: unknown }>(
      BRIGHTDATA_REQUEST_URL,
      { zone: config.brightData.zone, url: buildGoogleNewsSearchUrl(query), format: 'json' },
      {
        headers: { Authorization: `Bearer ${config.brightData.apiKey}`, 'Content-Type': 'application/json' },
        timeout: BRIGHTDATA_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );
    const elapsed = Date.now() - start;

    if (status !== 200) return { items: [], error: `HTTP ${status} (${elapsed}ms)` };
    if (typeof data.body !== 'string') return { items: [], error: `missing string body field (${elapsed}ms)` };

    let parsed: { news?: unknown[] };
    try {
      parsed = JSON.parse(data.body) as { news?: unknown[] };
    } catch (e) {
      return { items: [], error: `body JSON.parse failed: ${e instanceof Error ? e.message : String(e)} (${elapsed}ms)` };
    }

    const raw = parsed.news || [];
    const candidates = raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .filter((e) => typeof e.title === 'string' && typeof e.link === 'string');

    const resolvedLinks = await Promise.all(candidates.map((c) => resolveGoogleRedirectLink(c.link as string)));

    const items: ProbeItem[] = [];
    candidates.forEach((c, i) => {
      const link = resolvedLinks[i];
      if (!link) return;
      items.push({
        title: c.title as string,
        link,
        snippet: typeof c.description === 'string' ? c.description : undefined,
        source: typeof c.source === 'string' ? c.source : undefined,
        date: typeof c.date === 'string' ? c.date : undefined,
      });
    });

    console.log(`  [bright data] ${elapsed}ms, ${raw.length} raw → ${items.length} resolved`);
    return { items };
  } catch (e) {
    const elapsed = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    return { items: [], error: `${msg} (${elapsed}ms)` };
  }
}

async function probeSerpApi(query: string): Promise<{ items: ProbeItem[]; error?: string }> {
  if (!config.serpApi.apiKey) return { items: [], error: 'SERPAPI_API_KEY not set' };

  const start = Date.now();
  try {
    const { data, status } = await axios.get<{ error?: string; news_results?: unknown[] }>(SERPAPI_SEARCH, {
      params: { engine: 'google_news', api_key: config.serpApi.apiKey, q: query, gl: 'us', hl: 'en', num: 20 },
      validateStatus: () => true,
    });
    const elapsed = Date.now() - start;

    if (status !== 200) return { items: [], error: `HTTP ${status}: ${data.error || 'request failed'} (${elapsed}ms)` };
    if (data.error) return { items: [], error: `${data.error} (${elapsed}ms)` };

    const items: ProbeItem[] = [];
    for (const entry of data.news_results || []) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const h = (e.highlight && typeof e.highlight === 'object' ? e.highlight : e) as Record<string, unknown>;
      if (typeof h.title === 'string' && typeof h.link === 'string') {
        items.push({
          title: h.title,
          link: h.link,
          snippet: typeof h.snippet === 'string' ? h.snippet : undefined,
          source: typeof h.source === 'string' ? h.source : undefined,
          date: typeof h.date === 'string' ? h.date : undefined,
        });
      }
      if (Array.isArray(e.stories)) {
        for (const st of e.stories) {
          if (st && typeof st === 'object') {
            const s = st as Record<string, unknown>;
            if (typeof s.title === 'string' && typeof s.link === 'string') {
              items.push({
                title: s.title,
                link: s.link,
                snippet: typeof s.snippet === 'string' ? s.snippet : undefined,
                source: typeof s.source === 'string' ? s.source : undefined,
                date: typeof s.date === 'string' ? s.date : undefined,
              });
            }
          }
        }
      }
    }
    console.log(`  [serpapi]     ${elapsed}ms, ${items.length} items`);
    return { items };
  } catch (e) {
    const elapsed = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    return { items: [], error: `${msg} (${elapsed}ms)` };
  }
}

async function main() {
  for (const c of CANDIDATE_QUERIES) {
    console.log(`\n=== ${c.label} — query: "${c.query}" ===`);

    const bd = await probeBrightData(c.query);
    if (bd.error) console.log(`  [bright data] ERROR: ${bd.error}`);

    const sp = await probeSerpApi(c.query);
    if (sp.error) console.log(`  [serpapi]     ERROR: ${sp.error}`);

    const items = bd.items.length > 0 ? bd.items : sp.items;
    const servedBy = bd.items.length > 0 ? 'bright data' : sp.items.length > 0 ? 'serpapi (fallback)' : 'NONE';
    console.log(`  served by: ${servedBy}, ${items.length} item(s)`);
    for (const it of items.slice(0, 8)) {
      console.log(`    - "${it.title}" [${it.source || 'unknown source'}] ${it.date || ''}`);
      console.log(`      ${it.link}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Dispensary website scraper: Playwright loads each dispensary site, scores deal-like page text,
 * optionally captures a homepage screenshot into `scrapedImage` (never `image` or manual `logo`),
 * uploads to Sanity assets, and patches the dispensary doc.
 *
 * Redirects: an axios preflight (maxRedirects: 10) resolves the final base URL after 301/302/307/308
 * chains; `page.goto` also follows HTTP redirects by default in Chromium.
 *
 * Requires: `playwright` (see package.json). First run on a machine: `npx playwright install chromium`
 */
import axios, { type AxiosResponse } from 'axios';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { getSanityClient, uploadImageBufferToSanity } from '../../agents/sanityPublisher';

const AXIOS_REDIRECT_OPTS = {
  maxRedirects: 10,
  timeout: 20_000,
  validateStatus: () => true,
} as const;

const DEAL_PATHS = [
  '',
  '/deals',
  '/specials',
  '/menu',
  '/promotions',
  '/daily-deals',
  '/shop/deals',
  '/special-deals',
  '/cannabis-deals',
];

/** Keyword hits for scoring which page is most deal/special-rich */
const DEAL_HINT_RE =
  /\b(deal|deals|special|specials|%\s*off|\d+%\s*off|bogo|discount|promo|promotion|sale|bundle)\b/gi;

const LOGO_SELECTORS = [
  'header img[src*="logo" i]',
  'img[alt*="logo" i]',
  '[class*="logo" i] img',
  'a[class*="logo" i] img',
  '.navbar-brand img',
  'header img',
  'nav img',
];

export type ScrapeDispensariesResult = {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
};

type DispensaryRow = {
  _id: string;
  name: string | null;
  slug: string | null;
  website: string | null;
  /** True when manual `logo` image is set — scraper must not capture or patch scraped image. */
  hasManualLogo: boolean;
};

function normalizeWebsiteUrl(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && raw !== null && 'url' in raw) {
    const u = (raw as { url?: unknown }).url;
    if (typeof u === 'string') return normalizeWebsiteUrl(u);
  }
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 4) return null;
  let href = t;
  if (!/^https?:\/\//i.test(href)) {
    href = `https://${href}`;
  }
  try {
    const u = new URL(href);
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/** Final URL after axios follows redirects (Node `responseUrl` when available). */
function getFinalUrlFromAxiosResponse(res: AxiosResponse, fallback: string): string {
  const req = res.request as { res?: { responseUrl?: string } } | undefined;
  const ru = req?.res?.responseUrl;
  if (typeof ru === 'string' && ru.length > 0) return ru;
  const u = res.config?.url;
  if (typeof u === 'string' && u.length > 0) return u;
  return fallback;
}

/**
 * Follow redirect chains (301/302/307/308, etc.) up to 10 hops so Playwright uses the live base URL.
 */
async function resolveDispensaryBaseUrlAfterRedirects(url: string): Promise<string> {
  try {
    const res = await axios.head(url, { ...AXIOS_REDIRECT_OPTS });
    const finalUrl = getFinalUrlFromAxiosResponse(res, url);
    if (res.status >= 200 && res.status < 400 && finalUrl) return finalUrl;
  } catch {
    // HEAD unsupported or blocked — try GET
  }
  try {
    const res = await axios.get(url, {
      ...AXIOS_REDIRECT_OPTS,
      responseType: 'stream',
    });
    const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void };
    if (typeof stream?.destroy === 'function') {
      stream.destroy();
    }
    const finalUrl = getFinalUrlFromAxiosResponse(res, url);
    if (res.status >= 200 && res.status < 400 && finalUrl) return finalUrl;
  } catch {
    // keep original
  }
  return url;
}

function scoreDealText(text: string): number {
  const hits = text.match(DEAL_HINT_RE);
  const n = hits ? hits.length : 0;
  return n + Math.min(text.length / 800, 6);
}

async function loadPage(page: Page, url: string): Promise<boolean> {
  try {
    // Chromium follows HTTP redirects (301/302/307/308, …) automatically on navigation.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    return true;
  } catch {
    return false;
  }
}

async function extractBodyText(page: Page): Promise<string> {
  try {
    const text = await page.$eval('body', (el) => {
      const inner = (el as { innerText?: string }).innerText;
      return typeof inner === 'string' ? inner : '';
    });
    return text.replace(/\s+\n/g, '\n').trim();
  } catch {
    return '';
  }
}

async function scrapeBestDealsText(page: Page, baseUrl: string): Promise<string> {
  let best = '';
  let bestScore = -1;

  for (const path of DEAL_PATHS) {
    const url = joinUrl(baseUrl, path);
    const ok = await loadPage(page, url);
    if (!ok) continue;
    const text = await extractBodyText(page);
    if (text.length < 30) continue;
    const s = scoreDealText(text);
    if (s > bestScore) {
      bestScore = s;
      best = text;
    }
  }

  return best.slice(0, 60_000);
}

async function screenshotHomepageLogo(page: Page, baseUrl: string): Promise<Buffer | null> {
  const ok = await loadPage(page, baseUrl);
  if (!ok) return null;

  for (const sel of LOGO_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      const visible = await loc.isVisible().catch(() => false);
      if (!visible) continue;
      const buf = await loc.screenshot({ type: 'png' }).catch(() => null);
      if (buf && buf.length > 200) return buf;
    } catch {
      // next selector
    }
  }
  return null;
}

async function scrapeOneDispensary(
  context: BrowserContext,
  row: DispensaryRow
): Promise<'ok' | 'fail' | 'skip'> {
  const label = row.name?.trim() || row._id;
  const slug = row.slug?.trim() || '(no-slug)';
  const rawBase = normalizeWebsiteUrl(row.website);

  if (!rawBase) {
    console.log(`[dispensaryScraper] SKIP "${label}" [${slug}] — missing or invalid website`);
    return 'skip';
  }

  const baseUrl = await resolveDispensaryBaseUrlAfterRedirects(rawBase);
  if (baseUrl !== rawBase) {
    console.log(`[dispensaryScraper]   resolved redirects: ${rawBase} → ${baseUrl}`);
  }

  const page = await context.newPage();
  page.setDefaultTimeout(35_000);

  try {
    console.log(`[dispensaryScraper] START "${label}" [${slug}] — ${baseUrl}`);

    const dealsText = await scrapeBestDealsText(page, baseUrl);

    let scrapedImageAssetId: string | undefined;
    if (row.hasManualLogo) {
      const nameForLog = row.name?.trim() || slug;
      console.log(`[dispensaryScraper] logo already set for ${nameForLog} — skipping image scrape`);
    } else {
      const logoBuf = await screenshotHomepageLogo(page, baseUrl);
      if (logoBuf) {
        try {
          const safe = (row.slug || row._id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
          scrapedImageAssetId = await uploadImageBufferToSanity(
            logoBuf,
            `dispensary-scraped-${safe}.png`
          );
          console.log(`[dispensaryScraper]   uploaded scrapedImage asset: ${scrapedImageAssetId}`);
        } catch (e) {
          console.warn(
            `[dispensaryScraper]   scrapedImage upload failed:`,
            e instanceof Error ? e.message : e
          );
        }
      } else {
        console.log(`[dispensaryScraper]   no homepage screenshot captured for scrapedImage`);
      }
    }

    const client = getSanityClient();
    const fields: Record<string, unknown> = {
      scrapedDealsText: dealsText || '',
      dealsScrapedAt: new Date().toISOString(),
    };
    if (scrapedImageAssetId) {
      fields.scrapedImage = {
        _type: 'image',
        asset: { _type: 'reference', _ref: scrapedImageAssetId },
      };
    }
    await client.patch(row._id).set(fields).commit();

    console.log(
      `[dispensaryScraper] OK "${label}" [${slug}] — dealsChars=${(dealsText || '').length}, scrapedImagePatched=${Boolean(scrapedImageAssetId)}`
    );
    return 'ok';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[dispensaryScraper] FAIL "${label}" [${slug}] — ${msg}`);
    return 'fail';
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Fetches all dispensaries with a website, scrapes deal/special text and optional homepage capture per row,
 * patches `scrapedDealsText`, `dealsScrapedAt`, and `scrapedImage` (never `image` or `logo`).
 * Rows with a manual `logo` skip image capture; only text fields are updated.
 * One failure does not stop the batch.
 */
export async function scrapeDispensaries(): Promise<ScrapeDispensariesResult> {
  const client = getSanityClient();
  const rows = await client.fetch<DispensaryRow[]>(
    `*[_type == "dispensary" && defined(website)] | order(name asc) {
      _id,
      name,
      "slug": slug.current,
      website,
      "hasManualLogo": defined(logo.asset._ref)
    }`
  );

  const list = Array.isArray(rows) ? rows : [];
  console.log(`[dispensaryScraper] ========== start: ${list.length} dispensary row(s) ==========`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  // Chromium follows redirects on navigation by default; shared context per run.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    for (const row of list) {
      try {
        const r = await scrapeOneDispensary(context, row);
        if (r === 'ok') ok++;
        else if (r === 'skip') skipped++;
        else failed++;
      } catch (e) {
        failed++;
        console.error(
          `[dispensaryScraper] FAIL outer ${row._id}:`,
          e instanceof Error ? e.message : e
        );
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  console.log(
    `[dispensaryScraper] ========== end: ok=${ok}, skipped=${skipped}, failed=${failed}, total=${list.length} ==========`
  );

  return { total: list.length, ok, failed, skipped };
}

if (require.main === module) {
  scrapeDispensaries()
    .then((r) => {
      console.log('[dispensaryScraper] summary', r);
      process.exit(r.failed > 0 ? 1 : 0);
    })
    .catch((err: unknown) => {
      console.error('[dispensaryScraper] fatal:', err);
      process.exit(1);
    });
}

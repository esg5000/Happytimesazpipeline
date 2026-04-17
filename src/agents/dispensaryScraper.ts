/**
 * Dispensary website scraper: Playwright loads each dispensary site, scores deal-like page text,
 * optionally captures a homepage logo screenshot, uploads to Sanity assets, and patches the dispensary doc.
 *
 * Requires: `playwright` (see package.json). First run on a machine: `npx playwright install chromium`
 */
import { chromium, type Browser, type Page } from 'playwright';

import { getSanityClient, uploadImageBufferToSanity } from '../../agents/sanityPublisher';

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

function scoreDealText(text: string): number {
  const hits = text.match(DEAL_HINT_RE);
  const n = hits ? hits.length : 0;
  return n + Math.min(text.length / 800, 6);
}

async function loadPage(page: Page, url: string): Promise<boolean> {
  try {
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

async function scrapeOneDispensary(browser: Browser, row: DispensaryRow): Promise<'ok' | 'fail' | 'skip'> {
  const label = row.name?.trim() || row._id;
  const slug = row.slug?.trim() || '(no-slug)';
  const baseUrl = normalizeWebsiteUrl(row.website);

  if (!baseUrl) {
    console.log(`[dispensaryScraper] SKIP "${label}" [${slug}] — missing or invalid website`);
    return 'skip';
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(35_000);

  try {
    console.log(`[dispensaryScraper] START "${label}" [${slug}] — ${baseUrl}`);

    const dealsText = await scrapeBestDealsText(page, baseUrl);

    let imageAssetId: string | undefined;
    const logoBuf = await screenshotHomepageLogo(page, baseUrl);
    if (logoBuf) {
      try {
        const safe = (row.slug || row._id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
        imageAssetId = await uploadImageBufferToSanity(logoBuf, `dispensary-logo-${safe}.png`);
        console.log(`[dispensaryScraper]   uploaded logo asset: ${imageAssetId}`);
      } catch (e) {
        console.warn(
          `[dispensaryScraper]   logo upload failed:`,
          e instanceof Error ? e.message : e
        );
      }
    } else {
      console.log(`[dispensaryScraper]   no homepage logo screenshot captured`);
    }

    const client = getSanityClient();
    const fields: Record<string, unknown> = {
      scrapedDealsText: dealsText || '',
      dealsScrapedAt: new Date().toISOString(),
    };
    if (imageAssetId) {
      fields.image = {
        _type: 'image',
        asset: { _type: 'reference', _ref: imageAssetId },
      };
    }
    await client.patch(row._id).set(fields).commit();

    console.log(
      `[dispensaryScraper] OK "${label}" [${slug}] — dealsChars=${(dealsText || '').length}, imagePatched=${Boolean(imageAssetId)}`
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
 * Fetches all dispensaries with a website, scrapes deal/special text and optional homepage logo per row,
 * patches `scrapedDealsText`, `dealsScrapedAt`, and `image` (when a new logo asset was uploaded).
 * One failure does not stop the batch.
 */
export async function scrapeDispensaries(): Promise<ScrapeDispensariesResult> {
  const client = getSanityClient();
  const rows = await client.fetch<DispensaryRow[]>(
    `*[_type == "dispensary" && defined(website)] | order(name asc) {
      _id,
      name,
      "slug": slug.current,
      website
    }`
  );

  const list = Array.isArray(rows) ? rows : [];
  console.log(`[dispensaryScraper] ========== start: ${list.length} dispensary row(s) ==========`);

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const row of list) {
      try {
        const r = await scrapeOneDispensary(browser, row);
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

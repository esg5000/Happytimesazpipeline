/**
 * Dispensary website scraper: resolves and stores a deals page URL (`dealsUrl`) and optionally
 * captures a homepage logo screenshot into `scrapedImage` (never `image` or manual `logo`),
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

/**
 * Domain → deals URL overrides.
 * If a dispensary's deals page is known and does not live at a common path, add it here.
 *
 * Keys are domains (no protocol). Values may be:
 * - absolute URLs (https://…)
 * - or pathnames (/deals, /specials, /promotions, …) which will be resolved against the base origin.
 */
const DEALS_URL_MAP: Record<string, string> = {
  // Example:
  // 'exampledispensary.com': '/daily-deals',
};

const COMMON_DEALS_PATHS = ['/deals', '/specials', '/promotions'] as const;

const LOGO_SELECTORS = [
  // Prefer explicit header/nav branding locations first
  'header img',
  'nav img',
  // Then common logo/brand class patterns
  '[class*="site-logo" i] img',
  '[class*="logo" i] img',
  '[class*="brand" i] img',
  // Fallbacks
  'img[alt*="logo" i]',
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

function stripQueryAndHash(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    // Best-effort fallback: drop anything after ? or #
    return url.split('?')[0]!.split('#')[0]!;
  }
}

/**
 * Join a base URL with a path safely.
 * Important: the base URL is first sanitized to remove any query/UTM parameters so we never append
 * `/deals` after `?utm_source=...`.
 */
function joinUrl(base: string, path: string): string {
  const cleaned = stripQueryAndHash(base);
  try {
    const u = new URL(cleaned);
    u.search = '';
    u.hash = '';
    // Remove trailing slashes from pathname so `/foo/` + `/deals` doesn't become `/foo//deals`
    u.pathname = (u.pathname || '/').replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return new URL(p, u.toString() + '/').toString();
  } catch {
    const b = cleaned.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${b}${p}`;
  }
}

function matchDealsUrlOverride(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  for (const [domain, raw] of Object.entries(DEALS_URL_MAP)) {
    const d = domain.toLowerCase();
    if (host === d || host.endsWith(`.${d}`)) {
      const v = raw.trim();
      if (!v) return null;
      if (/^https?:\/\//i.test(v)) return v;
      try {
        return new URL(v.startsWith('/') ? v : `/${v}`, u.origin).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
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

async function loadPage(page: Page, url: string): Promise<boolean> {
  try {
    // Chromium follows HTTP redirects (301/302/307/308, …) automatically on navigation.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    return true;
  } catch {
    return false;
  }
}

async function urlReturns200(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { ...AXIOS_REDIRECT_OPTS });
    return res.status === 200;
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
    return res.status === 200;
  } catch {
    return false;
  }
}

async function findDealsUrl(baseUrl: string): Promise<string | null> {
  const override = matchDealsUrlOverride(baseUrl);
  if (override) {
    const ok = await urlReturns200(override);
    if (ok) return override;
  }

  for (const p of COMMON_DEALS_PATHS) {
    const candidate = joinUrl(baseUrl, p);
    const ok = await urlReturns200(candidate);
    if (ok) return candidate;
  }
  return null;
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

const MULTIPART_TLDS = new Set(['co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'com.br', 'co.nz']);

function rootDomainFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host;
    const last2 = parts.slice(-2).join('.');
    const last3 = parts.slice(-3).join('.');
    if (MULTIPART_TLDS.has(last2) && parts.length >= 3) {
      return last3;
    }
    if (MULTIPART_TLDS.has(last3) && parts.length >= 4) {
      return parts.slice(-4).join('.');
    }
    return last2;
  } catch {
    return null;
  }
}

async function scrapeDomainOnce(
  context: BrowserContext,
  domain: string,
  representative: DispensaryRow,
  anyNeedsScrapedImage: boolean,
  groupSize: number
): Promise<{ dealsUrl: string | null; scrapedImageAssetId?: string }> {
  const rawBase = normalizeWebsiteUrl(representative.website);
  if (!rawBase) {
    throw new Error(`invalid representative website for domain ${domain}`);
  }

  const baseUrl = await resolveDispensaryBaseUrlAfterRedirects(rawBase);
  if (baseUrl !== rawBase) {
    console.log(`[dispensaryScraper]   resolved redirects: ${rawBase} → ${baseUrl}`);
  }

  console.log(`[dispensaryScraper] domain ${domain} — scraping once for ${groupSize} locations`);

  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  try {
    let dealsUrl: string | null = null;
    if (/age[-_]?gate/i.test(baseUrl)) {
      const nameForLog =
        representative.name?.trim() || representative.slug || representative._id;
      console.log(
        `[dispensaryScraper] age gate detected for ${nameForLog} — skipping deals URL`
      );
    } else {
      dealsUrl = await findDealsUrl(baseUrl);
      if (dealsUrl) {
        console.log(`[dispensaryScraper]   deals URL found: ${dealsUrl}`);
      } else {
        console.log(`[dispensaryScraper]   deals URL not found`);
      }
    }

    let scrapedImageAssetId: string | undefined;
    if (!anyNeedsScrapedImage) {
      console.log(
        `[dispensaryScraper] logo already set for ${representative.name?.trim() || representative.slug || representative._id} — skipping image scrape`
      );
    } else {
      const logoBuf = await screenshotHomepageLogo(page, baseUrl);
      if (logoBuf) {
        try {
          const safe = domain.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
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
        console.log(`[dispensaryScraper]   logo not captured`);
      }
    }

    return { dealsUrl, ...(scrapedImageAssetId ? { scrapedImageAssetId } : {}) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Fetches all dispensaries with a website, finds a deals page URL and optionally captures a homepage logo
 * into `scrapedImage`, patches `dealsUrl`, `dealsScrapedAt`, and `scrapedImage` (never `image` or `logo`).
 * Rows with a manual `logo` skip image capture.
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
    const byDomain = new Map<string, DispensaryRow[]>();
    for (const row of list) {
      const label = row.name?.trim() || row._id;
      const slug = row.slug?.trim() || '(no-slug)';
      const href = normalizeWebsiteUrl(row.website);
      if (!href) {
        skipped += 1;
        console.log(`[dispensaryScraper] SKIP "${label}" [${slug}] — missing or invalid website`);
        continue;
      }
      const domain = rootDomainFromUrl(href);
      if (!domain) {
        skipped += 1;
        console.log(`[dispensaryScraper] SKIP "${label}" [${slug}] — could not parse domain`);
        continue;
      }
      const prev = byDomain.get(domain) ?? [];
      prev.push(row);
      byDomain.set(domain, prev);
    }

    for (const [domain, group] of byDomain.entries()) {
      const groupSize = group.length;
      // Prefer a representative row without manual logo so we can capture a scrapedImage for the group.
      const rep =
        group.find((r) => r.hasManualLogo === false) ??
        group[0];
      if (!rep) continue;
      const anyNeedsScrapedImage = group.some((r) => r.hasManualLogo === false);

      try {
        const { dealsUrl, scrapedImageAssetId } = await scrapeDomainOnce(
          context,
          domain,
          rep,
          anyNeedsScrapedImage,
          groupSize
        );

        const fields: Record<string, unknown> = {
          dealsScrapedAt: new Date().toISOString(),
        };
        if (dealsUrl) fields.dealsUrl = dealsUrl;
        if (scrapedImageAssetId) {
          fields.scrapedImage = {
            _type: 'image',
            asset: { _type: 'reference', _ref: scrapedImageAssetId },
          };
        }

        for (const row of group) {
          await client.patch(row._id).set(fields).commit();
          ok += 1;
        }
        console.log(`[dispensaryScraper] applied results to ${groupSize} records`);
      } catch (e) {
        failed += groupSize;
        console.error(
          `[dispensaryScraper] FAIL domain ${domain}:`,
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

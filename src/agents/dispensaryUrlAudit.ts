/**
 * HTTP health check for dispensary `website` URLs stored in Sanity.
 *
 * Run: `npm run audit-dispensaries`
 * Requires: SANITY_* env (same as pipeline) — see `config.ts`.
 */
import axios from 'axios';

import { getSanityClient } from '../../agents/sanityPublisher';

type AuditCategory = 'OK' | 'REDIRECT' | 'NOT_FOUND' | 'ERROR';

type DispensaryRow = {
  _id: string;
  name: string | null;
  slug: string | null;
  website: unknown;
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

function classifyHttpStatus(status: number): AuditCategory {
  if (status === 200) return 'OK';
  if (status === 301 || status === 302) return 'REDIRECT';
  if (status === 404) return 'NOT_FOUND';
  return 'ERROR';
}

async function checkUrlOnce(url: string): Promise<{ category: AuditCategory; status: number | null }> {
  try {
    const res = await axios.get(url, {
      timeout: 20_000,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; HappyTimesAZ-DispensaryAudit/1.0; +https://happytimesaz.com)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    return { category: classifyHttpStatus(res.status), status: res.status };
  } catch {
    return { category: 'ERROR', status: null };
  }
}

export async function auditDispensaryWebsiteUrls(): Promise<Record<AuditCategory, number>> {
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
  const counts: Record<AuditCategory, number> = {
    OK: 0,
    REDIRECT: 0,
    NOT_FOUND: 0,
    ERROR: 0,
  };

  console.log(`[dispensaryUrlAudit] ========== start: ${list.length} dispensary row(s) with website ==========`);

  for (const row of list) {
    const label = row.name?.trim() || row._id;
    const slug = row.slug?.trim() || '(no-slug)';
    const href = normalizeWebsiteUrl(row.website);

    if (!href) {
      counts.ERROR += 1;
      console.log(
        `[dispensaryUrlAudit] "${label}" [${slug}] — ERROR — invalid or missing website field`
      );
      continue;
    }

    const { category, status } = await checkUrlOnce(href);
    counts[category] += 1;

    const statusPart = status === null ? 'no status' : String(status);
    console.log(
      `[dispensaryUrlAudit] "${label}" [${slug}] — ${category} (${statusPart}) — ${href}`
    );
  }

  console.log('[dispensaryUrlAudit] ========== summary ==========');
  console.log(`[dispensaryUrlAudit] OK (200):        ${counts.OK}`);
  console.log(`[dispensaryUrlAudit] REDIRECT (301/302): ${counts.REDIRECT}`);
  console.log(`[dispensaryUrlAudit] NOT FOUND (404): ${counts.NOT_FOUND}`);
  console.log(`[dispensaryUrlAudit] ERROR:          ${counts.ERROR}`);
  console.log(`[dispensaryUrlAudit] Total:          ${list.length}`);

  return counts;
}

async function main(): Promise<void> {
  await auditDispensaryWebsiteUrls();
}

void main().catch((err: unknown) => {
  console.error('[dispensaryUrlAudit] fatal:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

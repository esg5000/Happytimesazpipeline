import axios from 'axios';

import { config } from '../config';

const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';

type UnsplashPhotoRow = {
  id?: string;
  width?: number;
  height?: number;
  urls?: { raw?: string; full?: string; regular?: string };
  links?: { download_location?: string };
};

type UnsplashSearchResponse = {
  results?: UnsplashPhotoRow[];
  total?: number;
};

/** Build a short search query from headline + note keywords (Unsplash search). */
export function buildUnsplashSearchQuery(title: string, notes: string): string {
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'are',
    'was',
    'has',
    'have',
    'will',
    'been',
    'about',
    'into',
    'your',
    'their',
  ]);
  const words = `${title}\n${notes}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  const unique: string[] = [];
  for (const w of words) {
    if (!unique.includes(w)) unique.push(w);
    if (unique.length >= 10) break;
  }
  const q = [title.slice(0, 60).trim(), ...unique.slice(0, 6)].filter(Boolean).join(' ');
  return q.slice(0, 100).trim() || title.slice(0, 80).trim() || 'editorial';
}

async function triggerUnsplashDownload(downloadLocation: string): Promise<void> {
  const key = config.unsplash.accessKey;
  if (!key || !downloadLocation.startsWith('http')) return;
  try {
    await axios.get(downloadLocation, {
      headers: { Authorization: `Client-ID ${key}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
  } catch {
    /* best-effort for Unsplash download guidelines */
  }
}

function pickHighestResolutionPhoto(results: UnsplashPhotoRow[]): UnsplashPhotoRow | null {
  if (!results.length) return null;
  let best = results[0]!;
  let bestPx = (best.width || 0) * (best.height || 0);
  for (const p of results) {
    const px = (p.width || 0) * (p.height || 0);
    if (px > bestPx) {
      bestPx = px;
      best = p;
    }
  }
  return best;
}

/**
 * Search Unsplash, trigger attribution download, fetch best-resolution bytes.
 * Returns null if no key, no results, or download fails.
 */
export async function fetchUnsplashHeroImageBuffer(
  title: string,
  notes: string
): Promise<Buffer | null> {
  const key = config.unsplash.accessKey;
  if (!key) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — UNSPLASH_ACCESS_KEY not set');
    return null;
  }

  const query = buildUnsplashSearchQuery(title, notes);
  console.log('[unsplash] fetchUnsplashHeroImageBuffer: start', {
    titlePreview: title.slice(0, 80),
    query,
  });

  const { data, status } = await axios.get<UnsplashSearchResponse>(UNSPLASH_SEARCH, {
    params: {
      query,
      per_page: 15,
      orientation: 'landscape',
    },
    headers: { Authorization: `Client-ID ${key}` },
    timeout: 20_000,
    validateStatus: () => true,
  });

  const resultCount = data?.results?.length ?? 0;
  if (status !== 200 || !data?.results?.length) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — search failed or no results', {
      httpStatus: status,
      resultCount,
      queryPreview: query.slice(0, 80),
    });
    return null;
  }

  console.log('[unsplash] Unsplash search response', {
    httpStatus: status,
    resultCount,
    totalReported: typeof data.total === 'number' ? data.total : undefined,
  });

  const photo = pickHighestResolutionPhoto(data.results);
  if (!photo?.urls) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — picked photo has no urls', {
      photoId: photo?.id,
    });
    return null;
  }

  const downloadLoc = photo.links?.download_location;
  if (downloadLoc) {
    await triggerUnsplashDownload(downloadLoc);
  }

  const imageUrl = photo.urls.raw || photo.urls.full || photo.urls.regular;
  if (!imageUrl?.startsWith('http')) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — no usable image URL on selected photo', {
      photoId: photo.id,
      hadRaw: Boolean(photo.urls.raw),
      hadFull: Boolean(photo.urls.full),
      hadRegular: Boolean(photo.urls.regular),
    });
    return null;
  }

  console.log('[unsplash] selected hero image URL', {
    photoId: photo.id,
    imageUrl,
    width: photo.width,
    height: photo.height,
  });

  try {
    const img = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      validateStatus: () => true,
    });
    if (img.status !== 200 || !img.data || img.data.byteLength < 500) {
      console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — image bytes fetch failed or too small', {
        httpStatus: img.status,
        byteLength: img.data?.byteLength ?? 0,
        imageUrl,
      });
      return null;
    }
    console.log('[unsplash] fetchUnsplashHeroImageBuffer: success', {
      byteLength: img.data.byteLength,
      photoId: photo.id,
    });
    return Buffer.from(img.data);
  } catch (e) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — image fetch threw', {
      message: e instanceof Error ? e.message : String(e),
      imageUrl,
    });
    return null;
  }
}

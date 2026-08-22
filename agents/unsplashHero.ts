import axios from 'axios';

import { config } from '../config';

const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';
const QUERY_MAX_CHARS = 100;

type UnsplashPhotoRow = {
  id?: string;
  width?: number;
  height?: number;
  urls?: { raw?: string; full?: string; regular?: string };
  links?: { download_location?: string };
  alt_description?: string | null;
  description?: string | null;
};

type UnsplashSearchResponse = {
  results?: UnsplashPhotoRow[];
  total?: number;
};

/** Shared stop-word set — used both to build the search query and to filter relevance-check terms. */
const STOP_WORDS = new Set([
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

/**
 * Disambiguation for search terms that resolve differently depending on
 * context — same term/whenSection/append shape as
 * src/agents/imageSourcing.ts's AMBIGUOUS_TERM_RULES, ported here for the
 * first time (this file had no disambiguation logic before this rule).
 * Minimal port, not the full pattern: imageSourcing.ts's
 * applyDisambiguation() operates on structured query "parts" against a
 * real `section` field; this file only ever has a flat word list and no
 * structured section — callers pass the article's section into `notes`
 * (see orchestrator.ts's fetchUnsplashHeroImageBuffer(article.title,
 * topic.section) and backfillHeroImages.ts's post.section fallback), so
 * `whenSection` is matched against `notes` instead. `append` adds an
 * extra term rather than replacing the original, same as
 * imageSourcing.ts. Deliberately just the one rule this fix needs — a
 * fuller port (structured section input, a real applyDisambiguation
 * helper) is worth doing later if more rules accumulate, not now.
 */
const AMBIGUOUS_TERM_RULES: { term: string; whenSection: string; append: string }[] = [
  {
    term: 'turkey',
    whenSection: 'health-wellness',
    append: 'turkey tail mushroom',
  },
];

/**
 * Build a short search query from headline + note keywords (Unsplash search).
 *
 * Confirmed production bug (Test A, tonight): stripping ALL non-alphanumeric
 * characters (including apostrophes) split "lion's" into "lion" + an
 * orphaned "s" that then failed the length filter — permanently reducing
 * the compound term "lion's mane" down to the bare, ambiguous word "lion".
 * A hard 6-word cap then silently dropped later significant words (e.g.
 * "tail") entirely, and a raw, mid-word-truncated title.slice(0, 60) prefix
 * duplicated content without adding signal. Fixed by preserving
 * apostrophes/hyphens as word-internal characters (so compound terms stay
 * intact) and replacing the word-count cap with a character-budget
 * accumulation that includes every significant word, in order, until
 * QUERY_MAX_CHARS is reached.
 */
type QueryBuildResult = {
  query: string;
  /**
   * Tokens from a fired disambiguation rule's `append` phrase, EXCLUDING
   * the ambiguous `term` itself (e.g. "turkey tail mushroom" minus
   * "turkey" → ["tail", "mushroom"]). When non-empty, the picker should
   * require one of these specifically, instead of accepting a match on
   * any word from the full query — otherwise the bare ambiguous term
   * (still present in `query` for Unsplash's own search ranking) remains
   * sufficient on its own, defeating the disambiguation rule.
   */
  requiredTerms: string[];
};

function buildUnsplashSearchQueryInternal(title: string, notes: string): QueryBuildResult {
  const words = `${title}\n${notes}`
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const unique: string[] = [];
  for (const w of words) {
    if (!unique.includes(w)) unique.push(w);
  }

  const requiredTerms: string[] = [];
  const notesLower = notes.toLowerCase();
  for (const rule of AMBIGUOUS_TERM_RULES) {
    if (notesLower.includes(rule.whenSection) && unique.includes(rule.term) && !unique.includes(rule.append)) {
      unique.push(rule.append);
      const disambiguatingTokens = rule.append
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== rule.term.toLowerCase() && w.length >= 3);
      for (const t of disambiguatingTokens) {
        if (!requiredTerms.includes(t)) requiredTerms.push(t);
      }
    }
  }

  let query = '';
  for (const w of unique) {
    const candidate = query ? `${query} ${w}` : w;
    if (candidate.length > QUERY_MAX_CHARS) break;
    query = candidate;
  }

  return { query: query.trim() || title.slice(0, 80).trim() || 'editorial', requiredTerms };
}

export function buildUnsplashSearchQuery(title: string, notes: string): string {
  return buildUnsplashSearchQueryInternal(title, notes).query;
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
 * Confirmed production bug: pickHighestResolutionPhoto() ranked ALL 15
 * search results by resolution alone, with no check that the photo has
 * anything to do with the query — an unrelated highest-resolution photo
 * (e.g. a bird photo for a "medicinal mushrooms" query) would win outright.
 * This filters to results whose alt_description/description actually
 * mentions one of the query's significant terms (stop-words and terms
 * under 3 chars excluded) BEFORE ranking by resolution. Falls back to
 * resolution-only ranking over the full unfiltered result set when zero
 * results match — logged via matchedRelevanceFilter so callers can tell
 * when that fallback fired.
 *
 * Confirmed follow-on bug (Test A, tonight, 3rd re-run): appending a
 * disambiguation term (e.g. "turkey" -> "turkey tail mushroom") changes
 * what Unsplash returns, but NOT what this filter accepts — the bare
 * ambiguous term ("turkey") stayed in queryTerms and any-match logic
 * let a literal turkey photo through anyway. When the caller has a fired
 * rule's disambiguating tokens (requiredTerms — the append phrase minus
 * the ambiguous term itself), those replace queryTerms as the match set
 * entirely, so the ambiguous term alone is no longer sufficient. Empty
 * requiredTerms (no rule fired) keeps the original any-term behavior.
 */
function pickRelevantHighestResolutionPhoto(
  results: UnsplashPhotoRow[],
  query: string,
  requiredTerms: string[] = []
): { photo: UnsplashPhotoRow | null; matchedRelevanceFilter: boolean } {
  const queryTerms = query
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  const matchTerms = requiredTerms.length > 0 ? requiredTerms : queryTerms;

  const relevant = results.filter((p) => {
    const text = `${p.alt_description || ''} ${p.description || ''}`.toLowerCase();
    return matchTerms.some((term) => text.includes(term));
  });

  const matchedRelevanceFilter = relevant.length > 0;
  const pool = matchedRelevanceFilter ? relevant : results;
  return { photo: pickHighestResolutionPhoto(pool), matchedRelevanceFilter };
}

export type UnsplashHeroImageResult = {
  buffer: Buffer;
  /**
   * False when no rung/query actually passed the relevance filter and
   * this is the resolution-only fallback pick (see
   * pickRelevantHighestResolutionPhoto). Exposed so callers (e.g.
   * newsApiSync.ts's generateAndUploadHeroForGoogleNews) can choose to
   * try gpt-image-1 instead of silently accepting a mismatched photo —
   * same shape as src/agents/imageSourcing.ts's ImageSourcingResult.
   */
  matchedRelevanceFilter: boolean;
};

/**
 * Search Unsplash, trigger attribution download, fetch best-resolution
 * bytes. Returns null if no key, no results, or download fails. Internal —
 * fetchUnsplashHeroImageBuffer (below) is the original Buffer-only wrapper
 * kept for existing callers; fetchUnsplashHeroImageResult (further below)
 * is the same call exposing matchedRelevanceFilter for callers that need
 * to react to it.
 */
async function fetchUnsplashHeroImageResultInternal(
  title: string,
  notes: string
): Promise<UnsplashHeroImageResult | null> {
  const key = config.unsplash.accessKey;
  if (!key) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — UNSPLASH_ACCESS_KEY not set');
    return null;
  }

  const { query, requiredTerms } = buildUnsplashSearchQueryInternal(title, notes);
  console.log('[unsplash] fetchUnsplashHeroImageBuffer: start', {
    titlePreview: title.slice(0, 80),
    query,
    requiredTerms,
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

  const { photo, matchedRelevanceFilter } = pickRelevantHighestResolutionPhoto(data.results, query, requiredTerms);
  if (!matchedRelevanceFilter) {
    console.warn('[unsplash] pickRelevantHighestResolutionPhoto: no result matched the relevance filter — falling back to resolution-only ranking over all results', {
      queryPreview: query.slice(0, 80),
    });
  }
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
    matchedRelevanceFilter,
    altDescription: photo.alt_description || photo.description || null,
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
      matchedRelevanceFilter,
    });
    return { buffer: Buffer.from(img.data), matchedRelevanceFilter };
  } catch (e) {
    console.warn('[unsplash] fetchUnsplashHeroImageBuffer: returning null — image fetch threw', {
      message: e instanceof Error ? e.message : String(e),
      imageUrl,
    });
    return null;
  }
}

/**
 * Same Unsplash search/fetch as fetchUnsplashHeroImageBuffer, but exposes
 * matchedRelevanceFilter so a caller can react when the result is only a
 * resolution-only fallback pick rather than a real relevance match.
 */
export async function fetchUnsplashHeroImageResult(
  title: string,
  notes: string
): Promise<UnsplashHeroImageResult | null> {
  return fetchUnsplashHeroImageResultInternal(title, notes);
}

/**
 * Original Buffer-only shape, unchanged for existing callers
 * (orchestrator.ts, researchAndWritePipeline.ts, backfillHeroImages.ts) —
 * still returns null exactly when it did before, including the
 * matchedRelevanceFilter=false case (that decision now lives with callers
 * that use fetchUnsplashHeroImageResult instead).
 */
export async function fetchUnsplashHeroImageBuffer(title: string, notes: string): Promise<Buffer | null> {
  const result = await fetchUnsplashHeroImageResultInternal(title, notes);
  return result ? result.buffer : null;
}

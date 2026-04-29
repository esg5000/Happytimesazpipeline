/**
 * Research agent: expands editor notes with OpenAI Responses API + hosted `web_search`,
 * parallel per-query research passes, and structured sources + enriched notes.
 *
 * Requires `OPENAI_API_KEY` (same as the rest of the pipeline). Model: `gpt-5.4-mini`.
 */
import axios from 'axios';

import { config } from '../../config';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
/** Cost-conscious model; web search is enabled only on research turns that need it. */
const RESEARCH_OPENAI_MODEL = 'gpt-5.4-mini';

export type Source = {
  title: string;
  url: string;
  summary: string;
  /** 1–10 */
  relevanceScore: number;
};

export type ResearchTopicResult = {
  sources: Source[];
  enrichedNotes: string;
};

async function openaiResponses(
  params: {
    instructions?: string;
    /** String or Responses API message array. */
    input: string | unknown[];
    tools?: unknown[];
    max_output_tokens?: number;
    temperature?: number;
  },
  timeoutMs = 180_000
): Promise<unknown> {
  const key = config.openai.apiKey;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set (required for researchTopic)');
  }

  const body: Record<string, unknown> = {
    model: RESEARCH_OPENAI_MODEL,
    input: params.input,
    max_output_tokens: params.max_output_tokens ?? 8192,
  };
  if (params.instructions) {
    body.instructions = params.instructions;
  }
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }
  if (typeof params.temperature === 'number') {
    body.temperature = params.temperature;
  }

  const res = await axios.post(OPENAI_RESPONSES_URL, body, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  const data = res.data;
  if (res.status >= 400) {
    const msg =
      typeof data === 'object' && data && 'error' in (data as object)
        ? JSON.stringify((data as { error?: unknown }).error)
        : res.statusText || String(res.status);
    throw new Error(`OpenAI Responses API HTTP ${res.status}: ${msg}`);
  }
  return data;
}

function extractOutputTextFromResponse(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  if (typeof d.output_text === 'string' && d.output_text.trim()) {
    return d.output_text.trim();
  }
  const output = d.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (o.type === 'message' && Array.isArray(o.content)) {
      for (const c of o.content as unknown[]) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        if (block.type === 'output_text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  const end = cleaned.lastIndexOf('}');
  if (end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function tryParseJsonArray(text: string): unknown[] | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('[');
  if (start === -1) return null;
  const end = cleaned.lastIndexOf(']');
  if (end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    u.pathname = path;
    return u.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function normalizeSourceRow(raw: unknown): Source | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const relevanceScore = clampScore(
    typeof o.relevanceScore === 'number'
      ? o.relevanceScore
      : parseInt(String(o.relevanceScore ?? ''), 10)
  );
  if (!title || !url || !summary) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { title, url, summary, relevanceScore };
}

function mergeSourcesByUrl(rows: Source[]): Source[] {
  const map = new Map<string, Source>();
  for (const s of rows) {
    const key = normalizeUrl(s.url);
    const prev = map.get(key);
    if (!prev || s.relevanceScore > prev.relevanceScore) {
      map.set(key, { ...s, url: key });
    }
  }
  return [...map.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Detects editor phrasing like "search [source] for …" or "find info on …" and returns
 * high-priority web-search angles that run before generic query extraction.
 */
function extractTargetedResearchAngles(notes: string): string[] {
  type Entry = { key: string; angle: string };
  const found: Entry[] = [];
  const seen = new Set<string>();

  const push = (key: string, angle: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ key, angle });
  };

  let m: RegExpExecArray | null;

  const reSearchFor = /\bsearch\s+([^\n]+?)\s+for\s+([^\n]+)/gi;
  while ((m = reSearchFor.exec(notes)) !== null) {
    const sourceHint = m[1]!.trim().replace(/\s+/g, ' ');
    const infoHint = m[2]!.trim().replace(/\s+/g, ' ');
    if (sourceHint.length < 2 || infoHint.length < 2) continue;
    push(`search-for:${sourceHint.toLowerCase()}|${infoHint.toLowerCase()}`, [
      'EDITOR PRIORITY — The editor explicitly asked to search this source/site/publication first:',
      `"${sourceHint}"`,
      'for:',
      `"${infoHint}".`,
      'Use web_search to locate the best canonical or official pages from that named source (prefer matching domain or byline).',
      'Return real URLs and summaries grounded in what you find there; treat this as the primary angle before broader web context.',
    ].join(' '));
  }

  const reFindInfoOn = /\bfind\s+(?:info|information)\s+on\s+([^\n,;.]+)/gi;
  while ((m = reFindInfoOn.exec(notes)) !== null) {
    const siteHint = m[1]!.trim().replace(/\s+/g, ' ');
    if (siteHint.length < 2) continue;
    push(
      `find-on:${siteHint.toLowerCase()}`,
      [
        'EDITOR PRIORITY — The editor asked to find information on:',
        `"${siteHint}"`,
        'in the context of the full editor notes.',
        'Use web_search to find authoritative pages from that site, outlet, or named source (prefer URLs clearly belonging to it).',
        'Summarize what is most relevant to the notes.',
      ].join(' ')
    );
  }

  return found.slice(0, 5).map((e) => e.angle);
}

function htmlToPlainText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (match, n: string) => {
      const code = parseInt(n, 10);
      if (!Number.isFinite(code) || code < 32) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, h: string) => {
      const code = parseInt(h, 16);
      if (!Number.isFinite(code) || code < 32) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    });
  t = t.replace(/\s+/g, ' ').trim();
  const max = 14_000;
  if (t.length > max) {
    t = `${t.slice(0, max)}… [truncated]`;
  }
  return t;
}

async function fetchPagePlainText(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  try {
    const res = await axios.get<string>(parsed.toString(), {
      timeout: 25_000,
      maxContentLength: 2_000_000,
      maxBodyLength: 2_000_000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; HappyTimesAZ-ResearchBot/1.0; +https://happytimesaz.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const text = htmlToPlainText(html);
    return text.length > 40 ? text : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[researchAgent] fetchPagePlainText failed:', url, msg);
    return null;
  }
}

/** For the top N sources by score after merge, attach full-page text from HTTP GET when possible. */
async function enrichTopSourcesWithFetchedPageText(
  sources: Source[],
  topN: number
): Promise<Source[]> {
  if (sources.length === 0) return sources;
  const n = Math.min(topN, sources.length);
  const copy = sources.map((s) => ({ ...s }));
  const tasks = Array.from({ length: n }, (_, i) => i).map(async (i) => {
    const s = copy[i]!;
    const pageText = await fetchPagePlainText(s.url);
    if (pageText && pageText.length > 80) {
      copy[i] = {
        ...s,
        summary: `Detailed page content (HTTP fetch):\n${pageText}\n\n--- Web search summary ---\n${s.summary}`,
      };
    }
  });
  await Promise.all(tasks);
  return mergeSourcesByUrl(copy);
}

function fallbackQueries(notes: string): string[] {
  const t = notes.trim().replace(/\s+/g, ' ');
  const head = t.slice(0, 100).trim() || 'topic research';
  return [
    `${head} overview`,
    `${head} recent news`,
    `${head} background facts`,
  ];
}

async function extractSearchQueries(notes: string): Promise<string[]> {
  const instructions = `You output only valid JSON, no markdown fences, no commentary.`;
  const user = `Read the editor notes below and propose between 3 and 5 short, distinct web search queries (each suitable for a news/web search engine) that would best surface facts and reputable sources for an article based on these notes. Prefer specific entities, places, dates, or bill names if present.

Return exactly this JSON shape: {"queries":["query1","query2",...]}

EDITOR NOTES:
---
${notes.slice(0, 12000)}
---`;

  const runExtract = async (): Promise<string | null> => {
    const raw = await openaiResponses({
      instructions,
      input: user,
      max_output_tokens: 600,
      temperature: 0.2,
    });
    return extractOutputTextFromResponse(raw);
  };

  let text = await runExtract();
  if (!text) {
    return fallbackQueries(notes);
  }

  let obj = tryParseJsonObject(text);
  let q = obj?.queries;
  if (!Array.isArray(q) || q.length === 0) {
    return fallbackQueries(notes);
  }
  const out = q
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 2)
    .map((x) => x.trim())
    .slice(0, 5);
  if (out.length >= 3) return out;
  if (out.length > 0 && out.length < 3) return out;
  return fallbackQueries(notes);
}

async function runWebResearchForQuery(notes: string, query: string): Promise<Source[]> {
  const instructions = `You are a careful research assistant. You MUST use the web_search tool to find current, credible sources before answering. After you finish searching, reply with ONLY a JSON array (no markdown code fences, no prose before or after) of 0 to 6 objects, each:
{"title":"string","url":"string starting with http","summary":"2-4 sentences of what matters for the editor","relevanceScore":integer 1-10}
Use real URLs from search results. relevanceScore reflects usefulness for the editor's notes.`;

  const user = `EDITOR NOTES (full context):
---
${notes.slice(0, 10000)}
---

SEARCH ANGLE (run web search focused on this):
${query}

Return only the JSON array as specified.`;

  const raw = await openaiResponses({
    instructions,
    input: user,
    tools: [{ type: 'web_search' }],
    max_output_tokens: 8192,
    temperature: 0.3,
  });

  const text = extractOutputTextFromResponse(raw);
  const arr = tryParseJsonArray(text);
  if (!arr) return [];
  const sources: Source[] = [];
  for (const row of arr) {
    const s = normalizeSourceRow(row);
    if (s) sources.push(s);
  }
  return sources;
}

function buildEnrichedNotes(notes: string, sources: Source[]): string {
  const base = notes.trim();
  if (sources.length === 0) {
    return `${base}\n\nRESEARCH FINDINGS:\n(No external sources were returned. Try broader notes or check API access.)`;
  }
  const lines = sources.map(
    (s) =>
      `- [${s.relevanceScore}/10] ${s.title} (${s.url})\n  ${s.summary}`
  );
  return `${base}\n\nRESEARCH FINDINGS:\n${lines.join('\n')}`;
}

/**
 * Same as {@link researchTopic}, but emits merged sources whenever a parallel search angle completes
 * (order depends on which query finishes first).
 */
export async function researchTopicWithProgress(
  notes: string,
  onProgress?: (payload: { sources: Source[] }) => void
): Promise<ResearchTopicResult> {
  const trimmed = typeof notes === 'string' ? notes.trim() : '';
  if (!trimmed) {
    throw new Error('researchTopicWithProgress: notes must be a non-empty string');
  }

  const accumulated: Source[] = [];

  const targetedAngles = extractTargetedResearchAngles(trimmed);
  if (targetedAngles.length > 0) {
    console.log(
      `[researchAgent] Running ${targetedAngles.length} targeted source search(es) before generic queries.`
    );
    await Promise.all(
      targetedAngles.map(async (angle) => {
        const batch = await runWebResearchForQuery(trimmed, angle);
        accumulated.push(...batch);
        if (onProgress) {
          onProgress({ sources: mergeSourcesByUrl(accumulated) });
        }
      })
    );
  }

  const queries = await extractSearchQueries(trimmed);
  await Promise.all(
    queries.map(async (q) => {
      const batch = await runWebResearchForQuery(trimmed, q);
      accumulated.push(...batch);
      if (onProgress) {
        onProgress({ sources: mergeSourcesByUrl(accumulated) });
      }
    })
  );

  let sources = mergeSourcesByUrl(accumulated);
  sources = await enrichTopSourcesWithFetchedPageText(sources, 2);
  if (onProgress) {
    onProgress({ sources });
  }

  const enrichedNotes = buildEnrichedNotes(trimmed, sources);
  return { sources, enrichedNotes };
}

/**
 * Runs optional targeted source angles from editor phrasing → keyword extraction → parallel
 * OpenAI web-search passes (`web_search` hosted tool), merges deduplicated sources, fetches full
 * HTML text for the top two scored URLs when possible, and appends a RESEARCH FINDINGS section.
 */
export async function researchTopic(notes: string): Promise<ResearchTopicResult> {
  return researchTopicWithProgress(notes, undefined);
}

type FactCheckWarning = { verbatim: string; reason?: string };

/**
 * Uses OpenAI (Responses API, no web search) to find article substrings not adequately supported by `sources`,
 * and inserts a **⚠️** marker immediately before each flagged verbatim substring (first occurrence only).
 */
export async function factCheckArticleMarkdownAnthropic(
  bodyMarkdown: string,
  sources: Source[]
): Promise<string> {
  const trimmed = bodyMarkdown.trim();
  if (!trimmed) return bodyMarkdown;
  if (sources.length === 0) return bodyMarkdown;

  const instructions = `You output only valid JSON, no markdown fences, no commentary.`;
  const user = `You are a fact-checking editor. Given research SOURCES and an ARTICLE in Markdown, list phrases or short sentences in the article that make specific factual claims (numbers, dates, legal outcomes, quotes, medical claims, etc.) that are NOT clearly supported by the source summaries/URLs.

SOURCES (JSON, up to 25):
${JSON.stringify(sources.slice(0, 25)).slice(0, 60_000)}

ARTICLE (markdown):
${trimmed.slice(0, 45_000)}

Return JSON only:
{"warnings":[{"verbatim":"copy an EXACT contiguous substring from ARTICLE (30–220 chars) to flag","reason":"one short sentence why it is not verified by sources"}]}

Rules:
- Max 12 warnings. Use [] if nothing is unsupported.
- "verbatim" MUST be copied exactly from ARTICLE (including punctuation and spaces) so we can search/replace.
- Prefer the shortest distinctive substring that contains the unsupported claim.
- Do not repeat overlapping strings; longer substrings preferred over many tiny ones.`;

  const raw = await openaiResponses({
    instructions,
    input: user,
    max_output_tokens: 4096,
    temperature: 0.1,
  });

  const text = extractOutputTextFromResponse(raw);
  const obj = tryParseJsonObject(text);
  const rawWarnings = obj?.warnings;
  if (!Array.isArray(rawWarnings) || rawWarnings.length === 0) return bodyMarkdown;

  const warnings: FactCheckWarning[] = [];
  for (const row of rawWarnings) {
    if (!row || typeof row !== 'object') continue;
    const w = row as Record<string, unknown>;
    const verbatim = typeof w.verbatim === 'string' ? w.verbatim : '';
    if (verbatim.length < 12 || verbatim.length > 400) continue;
    if (!trimmed.includes(verbatim)) continue;
    warnings.push({
      verbatim,
      reason: typeof w.reason === 'string' ? w.reason : undefined,
    });
  }
  if (warnings.length === 0) return bodyMarkdown;

  warnings.sort((a, b) => b.verbatim.length - a.verbatim.length);
  let out = bodyMarkdown;
  for (const { verbatim } of warnings) {
    const idx = out.indexOf(verbatim);
    if (idx >= 0) {
      out = out.slice(0, idx) + '⚠️' + out.slice(idx);
    }
  }
  return out;
}

/** Appends a Markdown "## Sources" section with title + URL list. */
export function appendSourcesSectionMarkdown(
  bodyMarkdown: string,
  sources: Source[]
): string {
  const base = bodyMarkdown.trimEnd();
  if (sources.length === 0) {
    return `${base}\n\n## Sources\n\n_No external sources._\n`;
  }
  const lines = sources.map((s) => `- [${s.title.replace(/\]/g, '')}](${s.url})`);
  return `${base}\n\n## Sources\n\n${lines.join('\n')}\n`;
}

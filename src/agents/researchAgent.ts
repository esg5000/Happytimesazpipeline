/**
 * Research agent: expands editor notes with Anthropic web search (`web_search_20250305`),
 * parallel per-query research passes, and structured sources + enriched notes.
 *
 * Requires `ANTHROPIC_API_KEY`. Optional: `ANTHROPIC_RESEARCH_MODEL`, `ANTHROPIC_EXTRACT_MODEL`.
 */
import axios from 'axios';

import { config } from '../../config';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

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

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicMessageResponse = {
  content?: AnthropicContentBlock[];
  error?: { type?: string; message?: string };
};

async function anthropicMessages(
  body: Record<string, unknown>,
  timeoutMs = 180_000
): Promise<AnthropicMessageResponse> {
  const key = config.anthropic.apiKey;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set (required for researchTopic)');
  }
  const res = await axios.post<AnthropicMessageResponse>(ANTHROPIC_MESSAGES_URL, body, {
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  const data = res.data;
  if (res.status >= 400) {
    const msg =
      typeof data === 'object' && data && 'error' in data && data.error
        ? typeof data.error === 'object' && data.error && 'message' in data.error
          ? String((data.error as { message?: string }).message)
          : JSON.stringify(data.error)
        : res.statusText || String(res.status);
    throw new Error(`Anthropic API HTTP ${res.status}: ${msg}`);
  }
  if (typeof data === 'object' && data && 'error' in data && data.error) {
    const msg =
      typeof data.error === 'object' && data.error && 'message' in data.error
        ? String((data.error as { message?: string }).message)
        : JSON.stringify(data.error);
    throw new Error(`Anthropic API error: ${msg}`);
  }
  return data;
}

function collectAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      const block = b as AnthropicContentBlock;
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n');
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
  const system = `You output only valid JSON, no markdown fences, no commentary.`;
  const user = `Read the editor notes below and propose between 3 and 5 short, distinct web search queries (each suitable for a news/web search engine) that would best surface facts and reputable sources for an article based on these notes. Prefer specific entities, places, dates, or bill names if present.

Return exactly this JSON shape: {"queries":["query1","query2",...]}

EDITOR NOTES:
---
${notes.slice(0, 12000)}
---`;

  const tryModel = async (model: string) => {
    const res = await anthropicMessages({
      model,
      max_tokens: 600,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = collectAssistantText(res.content).trim();
    const obj = tryParseJsonObject(text);
    const q = obj?.queries;
    if (!Array.isArray(q)) return null;
    const out = q
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 2)
      .map((x) => x.trim())
      .slice(0, 5);
    return out.length >= 3 ? out : out.length > 0 ? out : null;
  };

  let queries =
    (await tryModel(config.anthropic.extractModel)) ??
    (config.anthropic.extractModel === config.anthropic.researchModel
      ? null
      : await tryModel(config.anthropic.researchModel));

  if (!queries || queries.length < 3) {
    queries = fallbackQueries(notes);
  }
  if (queries.length > 5) queries = queries.slice(0, 5);
  return queries;
}

async function runWebResearchForQuery(
  notes: string,
  query: string
): Promise<Source[]> {
  const system = `You are a careful research assistant. Use the web_search tool to find current, credible sources. After you finish searching, reply with ONLY a JSON array (no markdown code fences, no prose before or after) of 0 to 6 objects, each:
{"title":"string","url":"string starting with http","summary":"2-4 sentences of what matters for the editor","relevanceScore":integer 1-10}
Use real URLs from search results. relevanceScore reflects usefulness for the editor's notes.`;

  const user = `EDITOR NOTES (full context):
---
${notes.slice(0, 10000)}
---

SEARCH ANGLE (run web search focused on this):
${query}

Return only the JSON array as specified.`;

  const res = await anthropicMessages({
    model: config.anthropic.researchModel,
    max_tokens: 8192,
    temperature: 0.3,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        /** One focused search pass per query; parallel calls cover 3–5 angles total. */
        max_uses: 1,
      },
    ],
  });

  const text = collectAssistantText(res.content);
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

  const queries = await extractSearchQueries(trimmed);
  const accumulated: Source[] = [];
  await Promise.all(
    queries.map(async (q) => {
      const batch = await runWebResearchForQuery(trimmed, q);
      accumulated.push(...batch);
      if (onProgress) {
        onProgress({ sources: mergeSourcesByUrl(accumulated) });
      }
    })
  );
  const sources = mergeSourcesByUrl(accumulated);
  const enrichedNotes = buildEnrichedNotes(trimmed, sources);
  return { sources, enrichedNotes };
}

/**
 * Runs keyword extraction → 3–5 parallel Anthropic web-search passes (each with `web_search_20250305`),
 * merges deduplicated sources, and appends a RESEARCH FINDINGS section to the notes.
 */
export async function researchTopic(notes: string): Promise<ResearchTopicResult> {
  return researchTopicWithProgress(notes, undefined);
}

type FactCheckWarning = { verbatim: string; reason?: string };

/**
 * Uses Claude (Anthropic Messages, no web search) to find article substrings not adequately supported by `sources`,
 * and inserts a **⚠️** marker immediately before each flagged verbatim substring (first occurrence only).
 */
export async function factCheckArticleMarkdownAnthropic(
  bodyMarkdown: string,
  sources: Source[]
): Promise<string> {
  const trimmed = bodyMarkdown.trim();
  if (!trimmed) return bodyMarkdown;
  if (sources.length === 0) return bodyMarkdown;

  const system = `You output only valid JSON, no markdown fences, no commentary.`;
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

  const res = await anthropicMessages({
    model: config.anthropic.researchModel,
    max_tokens: 4096,
    temperature: 0.1,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = collectAssistantText(res.content);
  const obj = tryParseJsonObject(text);
  const raw = obj?.warnings;
  if (!Array.isArray(raw) || raw.length === 0) return bodyMarkdown;

  const warnings: FactCheckWarning[] = [];
  for (const row of raw) {
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

/**
 * Research agent: expands editor notes with OpenAI Responses API + hosted `web_search`,
 * at most three web-search turns (one targeted hint if present, plus two generic angles),
 * merged sources, optional HTTP page text (capped per URL; Playwright fallback if thin), and enriched notes.
 *
 * Requires `OPENAI_API_KEY` (same as the rest of the pipeline). Model: `gpt-5.4-mini`.
 */
import './playwrightBrowsersPath';
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
/**
 * Same as {@link researchTopic}, but emits merged sources whenever a parallel search angle completes
 * (order depends on which query finishes first).
 */
export declare function researchTopicWithProgress(notes: string, onProgress?: (payload: {
    sources: Source[];
}) => void): Promise<ResearchTopicResult>;
/**
 * Runs at most one targeted source angle → query extraction → two generic web-search passes
 * (`web_search`, max three Responses calls with tools), merges deduplicated sources, fetches plain
 * text for the top two scored URLs (≤3000 chars each) when possible, and appends RESEARCH FINDINGS.
 */
export declare function researchTopic(notes: string): Promise<ResearchTopicResult>;
/**
 * Uses OpenAI (Responses API, no web search) to find article substrings not adequately supported by `sources`,
 * and inserts a **⚠️** marker immediately before each flagged verbatim substring (first occurrence only).
 */
export declare function factCheckArticleMarkdownAnthropic(bodyMarkdown: string, sources: Source[]): Promise<string>;
/** Appends a Markdown "## Sources" section with title + URL list. */
export declare function appendSourcesSectionMarkdown(bodyMarkdown: string, sources: Source[]): string;
//# sourceMappingURL=researchAgent.d.ts.map
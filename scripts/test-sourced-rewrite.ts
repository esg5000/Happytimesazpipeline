/**
 * ONE-OFF TEST SCRIPT — not part of the production pipeline.
 *
 * Tests whether giving the rewrite model verified facts (instead of just a
 * headline/snippet) improves editor quality scores, using the EXISTING
 * rewrite prompt template (prompts/googleNewsRewrite.prompt.txt) and the
 * EXISTING editor scoring function (agents/editorAgent.ts) unchanged.
 *
 * rewriteArticle() is copied here (not imported) because it is not exported
 * from agents/newsApiSync.ts and that file is not to be modified. The editor
 * scorer IS exported, so it's imported read-only.
 *
 * Run: npx ts-node scripts/test-sourced-rewrite.ts
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';

import { config } from '../config';
import { Article, validateArticle } from '../utils/validator';
import { generateSlug } from '../utils/slug';
import { scoreArticleQuality } from '../agents/editorAgent';

const REWRITE_PROMPT_PATH = join(process.cwd(), 'prompts', 'googleNewsRewrite.prompt.txt');
const OPENAI_MODEL_GOOGLE_NEWS_REWRITE = 'gpt-5.4-mini';

const OUT_DIR = join(
  process.env.TEMP || process.env.TMPDIR || '/tmp',
  'happytimesaz-test-sourced-rewrite'
);

// ---- copied unchanged from agents/newsApiSync.ts (read-only reproduction, not imported) ----

const SEO_TITLE_MAX = 70;
const BODY_MARKDOWN_SAFETY_MAX = 6800;
const EXCERPT_SAFETY_MAX = 190;
const BODY_MARKDOWN_SCHEMA_MIN = 500;

function truncateSeoTitleIfNeeded(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const o = raw as Record<string, unknown>;
  const s = o.seoTitle;
  if (typeof s !== 'string') return;
  if (s.length <= SEO_TITLE_MAX) return;
  const cut = s.slice(0, SEO_TITLE_MAX).trimEnd();
  o.seoTitle = cut.length >= 10 ? cut : s.slice(0, SEO_TITLE_MAX);
}

function truncateBodyMarkdownAtLastSentence(body: string, maxLen: number): string {
  if (body.length <= maxLen) return body;
  const window = body.slice(0, maxLen);
  let bestCut = -1;
  for (let i = 0; i < window.length; i++) {
    const ch = window[i]!;
    if (
      (ch === '.' || ch === '!' || ch === '?') &&
      (i === window.length - 1 || /\s/.test(window[i + 1]!))
    ) {
      bestCut = i + 1;
    }
  }
  if (bestCut >= BODY_MARKDOWN_SCHEMA_MIN) return window.slice(0, bestCut).trimEnd();
  return window.trimEnd();
}

function truncateExcerptAtLastWord(excerpt: string, maxLen: number): string {
  if (excerpt.length <= maxLen) return excerpt;
  const slice = excerpt.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  let out = lastSpace > 20 ? slice.slice(0, lastSpace).trimEnd() : slice.trimEnd();
  if (out.length < 50 && excerpt.length >= 50) {
    out = excerpt.slice(0, maxLen).trimEnd();
  }
  return out;
}

function truncateRewriteLengthsIfNeeded(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const o = raw as Record<string, unknown>;
  const body = o.bodyMarkdown;
  if (typeof body === 'string' && body.length > BODY_MARKDOWN_SAFETY_MAX) {
    o.bodyMarkdown = truncateBodyMarkdownAtLastSentence(body, BODY_MARKDOWN_SAFETY_MAX);
  }
  const ex = o.excerpt;
  if (typeof ex === 'string' && ex.length > EXCERPT_SAFETY_MAX) {
    o.excerpt = truncateExcerptAtLastWord(ex, EXCERPT_SAFETY_MAX);
  }
}

async function openAiJson<T>(system: string, user: string, model: string): Promise<T> {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned empty content');
  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}

/** Copy of agents/newsApiSync.ts rewriteArticle(), parameterized on a pre-built basis string
 *  instead of a SerpGoogleNewsItem, so this script can inject the "verified facts" block. */
async function rewriteFromBasis(basis: string, label: string): Promise<Article> {
  const systemBase = readFileSync(REWRITE_PROMPT_PATH, 'utf-8');
  const user = `Rewrite this into a full HappyTimesAZ article JSON.\n\n${basis}`;

  const parsed = await openAiJson<Record<string, unknown>>(
    systemBase,
    user,
    OPENAI_MODEL_GOOGLE_NEWS_REWRITE
  );

  truncateSeoTitleIfNeeded(parsed);
  truncateRewriteLengthsIfNeeded(parsed);

  if (parsed && typeof parsed === 'object' && 'title' in parsed) {
    const o = parsed as { title: string; slug?: string };
    if (!o.slug?.trim()) {
      o.slug = generateSlug(o.title);
    }
  }

  const validation = validateArticle(parsed);
  if (!validation.success) {
    throw new Error(`[${label}] Rewrite validation failed: ${validation.errors?.join(', ')}`);
  }

  return validation.data!;
}

// ---- test setup ----

const item = {
  title: "Summer's biggest meteor shower peaks tonight. How to see it in Arizona",
  snippet: '',
  link: 'https://www.phoenixnewtimes.com/arts-culture/perseids-meteor-shower-2026-arizona-40689347/',
};

const basisSnippetOnly = [
  `Title: ${item.title}`,
  item.snippet ? `Snippet: ${item.snippet}` : '',
  `Link: ${item.link}`,
]
  .filter(Boolean)
  .join('\n\n');

const basisWithFacts =
  basisSnippetOnly +
  '\n\n' +
  `Verified facts (use these, do not invent beyond them):
- Peak: night of August 12 into predawn August 13, 2026. Best window is roughly 11 PM to dawn, with the highest rates typically between 1–4 AM.
- Expected rate: 50–75 meteors per hour under dark skies (up to ~100/hr in ideal conditions), per NASA and the American Meteor Society.
- Moon phase: new moon on August 12 — zero moonlight, the best Perseid viewing conditions in years.
- Radiant: constellation Perseus, low in the northeast after midnight — but meteors can appear anywhere in the sky.
- Recommended viewing spot near Phoenix: Fountain Hills, the closest International Dark Sky-certified community to Metro Phoenix, shielded from city light by the McDowell Mountains. Fountain Park and Golden Eagle Park are commonly used viewing spots there.`;

type RunResult = {
  label: string;
  basisCharCount: number;
  article: Article;
  editorScore: number;
  editorReason: string;
};

async function runOnce(label: string, basis: string): Promise<RunResult> {
  console.log(`\n=== [${label}] rewriting (basis: ${basis.length} chars) ===`);
  const article = await rewriteFromBasis(basis, label);

  console.log(`=== [${label}] → editor scoring ===`);
  const editorResult = await scoreArticleQuality(article);

  return {
    label,
    basisCharCount: basis.length,
    article,
    editorScore: editorResult.score,
    editorReason: editorResult.reason,
  };
}

function printResult(r: RunResult): void {
  console.log(`\n\n########## RESULT: ${r.label} ##########`);
  console.log(`Input basis length: ${r.basisCharCount} chars`);
  console.log(`Editor score: ${r.editorScore}/10`);
  console.log(`Editor reason: ${r.editorReason}`);
  console.log(`--- Generated article JSON ---`);
  console.log(JSON.stringify(r.article, null, 2));
}

async function run(): Promise<void> {
  if (!config.openai.apiKey) {
    console.error('OPENAI_API_KEY is not set — cannot run test.');
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const baseline = await runOnce('A_snippet_only (baseline, reproduces failure)', basisSnippetOnly);
  const sourced = await runOnce('B_with_verified_facts', basisWithFacts);

  printResult(baseline);
  printResult(sourced);

  writeFileSync(join(OUT_DIR, 'run-A-snippet-only.json'), JSON.stringify(baseline, null, 2));
  writeFileSync(join(OUT_DIR, 'run-B-with-facts.json'), JSON.stringify(sourced, null, 2));

  console.log(`\n\n########## SUMMARY ##########`);
  console.log(
    `A_snippet_only     : editor score ${baseline.editorScore}/10 — ${baseline.editorReason}`
  );
  console.log(
    `B_with_verified_facts: editor score ${sourced.editorScore}/10 — ${sourced.editorReason}`
  );
  console.log(`\nFull JSON written to:\n  ${join(OUT_DIR, 'run-A-snippet-only.json')}\n  ${join(OUT_DIR, 'run-B-with-facts.json')}`);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

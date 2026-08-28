import axios from 'axios';

import { config } from '../config';
import { Article } from '../utils/validator';
import { geminiChatJson, withGeminiFallback } from './geminiAgent';

/** OpenAI model for post-write editorial quality scoring (local specificity, headline/body match, substance vs. filler). */
const OPENAI_MODEL_EDITOR_SCORE = 'gpt-5.4-mini';

export type EditorScoreResult = {
  score: number;
  reason: string;
};

async function openAiJson<T>(system: string, user: string, model: string): Promise<T> {
  const content = await withGeminiFallback(
    'editorAgent.openAiJson',
    async () => {
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
      const c = response.data.choices[0]?.message?.content;
      if (!c) throw new Error('OpenAI returned empty content');
      return c as string;
    },
    () => geminiChatJson(system, user, { temperature: 0.3 })
  );

  const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned) as T;
}

/**
 * Post-write editorial quality gate. Scores 1-10 on local specificity, headline/body
 * match, and substance vs. filler. Callers should still publish if this call throws —
 * it checks draft quality, not whether the API call itself succeeded.
 */
export async function scoreArticleQuality(article: Article): Promise<EditorScoreResult> {
  console.log(`[editor] "${article.title}" → OpenAI (${OPENAI_MODEL_EDITOR_SCORE}): quality scoring…`);

  const system = `You are a strict editor for HappyTimesAZ, a Phoenix AZ local lifestyle site. Score the following article draft 1-10 on overall publish quality, weighing:

(a) **Local specificity** — does it name real, specific local businesses, venues, or places where the topic calls for it (e.g. a restaurant roundup naming actual restaurants, an event piece naming the actual venue)? If the topic is not inherently local (e.g. a general how-to, a national trend explainer, a recipe), skip this criterion gracefully — do not penalize for it.
(b) **Headline/body match** — does the headline accurately represent what the body actually covers, with no bait-and-switch or overstated claim?
(c) **Substance over filler** — is there real, specific, useful information, or is it generic filler language that could apply to any city or any topic?

Return JSON only: {"score": <1-10 integer>, "reason": "<one or two sentence explanation>"}`;

  const user = `Title: ${article.title}\n\nExcerpt: ${article.excerpt}\n\nBody (Markdown):\n${article.bodyMarkdown}`;

  const raw = await openAiJson<{ score?: unknown; reason?: unknown }>(
    system,
    user,
    OPENAI_MODEL_EDITOR_SCORE
  );
  const score = Math.min(10, Math.max(1, Math.round(Number(raw.score)) || 1));
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : '(no reason given)';

  console.log(`[editor] "${article.title}" → score=${score}, reason="${reason}"`);

  return { score, reason };
}

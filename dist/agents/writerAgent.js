"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EDITOR_SUPPLIED_HERO_IMAGE_PROMPT = exports.HAPPYTIMESAZ_EDITORIAL_AUTHOR = void 0;
exports.writeArticle = writeArticle;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const fs_1 = require("fs");
const path_1 = require("path");
const validator_1 = require("../utils/validator");
const slug_1 = require("../utils/slug");
const articleStyle_1 = require("../utils/articleStyle");
// Resolve prompt path - works in both dev and compiled dist
const WRITER_PROMPT_PATH = (0, path_1.join)(process.cwd(), 'prompts', 'writer.prompt.txt');
/** OpenAI model for Chat Completions article JSON (`writeArticle`). */
const WRITER_OPENAI_MODEL = 'gpt-5.4-mini';
const BODY_MARKDOWN_SAFETY_MAX = 4800;
const EXCERPT_SAFETY_MAX = 190;
const BODY_MARKDOWN_SCHEMA_MIN = 500;
/** Truncate at the last complete sentence ending at or before `maxLen` (., !, ? followed by space/end). */
function truncateBodyMarkdownAtLastSentence(body, maxLen) {
    if (body.length <= maxLen)
        return body;
    const window = body.slice(0, maxLen);
    let bestCut = -1;
    for (let i = 0; i < window.length; i++) {
        const ch = window[i];
        if ((ch === '.' || ch === '!' || ch === '?') &&
            (i === window.length - 1 || /\s/.test(window[i + 1]))) {
            bestCut = i + 1;
        }
    }
    if (bestCut >= BODY_MARKDOWN_SCHEMA_MIN)
        return window.slice(0, bestCut).trimEnd();
    return window.trimEnd();
}
/** Truncate at the last word boundary at or before `maxLen`. */
function truncateExcerptAtLastWord(excerpt, maxLen) {
    if (excerpt.length <= maxLen)
        return excerpt;
    const slice = excerpt.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(' ');
    let out = lastSpace > 20 ? slice.slice(0, lastSpace).trimEnd() : slice.trimEnd();
    if (out.length < 50 && excerpt.length >= 50) {
        out = excerpt.slice(0, maxLen).trimEnd();
    }
    return out;
}
function applyWriterArticleLengthSafetyTruncate(parsed) {
    if (!parsed || typeof parsed !== 'object')
        return;
    const o = parsed;
    const body = o.bodyMarkdown;
    if (typeof body === 'string' && body.length > BODY_MARKDOWN_SAFETY_MAX) {
        const next = truncateBodyMarkdownAtLastSentence(body, BODY_MARKDOWN_SAFETY_MAX);
        console.warn(`[writerAgent] bodyMarkdown safety truncate: ${body.length} → ${next.length} chars (cap ${BODY_MARKDOWN_SAFETY_MAX})`);
        o.bodyMarkdown = next;
    }
    const ex = o.excerpt;
    if (typeof ex === 'string' && ex.length > EXCERPT_SAFETY_MAX) {
        const next = truncateExcerptAtLastWord(ex, EXCERPT_SAFETY_MAX);
        console.warn(`[writerAgent] excerpt safety truncate: ${ex.length} → ${next.length} chars (cap ${EXCERPT_SAFETY_MAX})`);
        o.excerpt = next;
    }
}
/** Byline stored on Sanity for pipeline-written posts (`publishArticleToSanity`). */
exports.HAPPYTIMESAZ_EDITORIAL_AUTHOR = 'HappyTimesAZ Editorial';
/** Stored on article when the editor uploaded real photos; hero is never AI-generated. */
exports.EDITOR_SUPPLIED_HERO_IMAGE_PROMPT = 'Editor-supplied photography only; no AI-generated hero image for this article.';
/**
 * Writes an article based on a topic.
 */
async function writeArticle(topic, options) {
    const basePrompt = (0, fs_1.readFileSync)(WRITER_PROMPT_PATH, 'utf-8');
    const applyStyle = options?.applyDashboardArticleStyle === true;
    const length = options?.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
    const tone = options?.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
    const systemPrompt = applyStyle
        ? `${basePrompt.trim()}${(0, articleStyle_1.buildWriterArticleStyleAppend)(length, tone)}`
        : basePrompt.trim();
    const notesBlock = options?.sourceNotes && options.sourceNotes.trim().length > 0
        ? `PRIMARY SOURCE MATERIAL (editor — the article must follow this substance, facts, and angle; do not pivot to an unrelated topic):\n---\n${options.sourceNotes.trim()}\n---\n\n`
        : '';
    const imageNote = options?.userSuppliedImages
        ? 'Real photography from the editor is already attached (hero + any additional images). No AI-generated hero image will be produced — focus the article on the source material below.\n\n'
        : '';
    const userPrompt = `${notesBlock}${imageNote}Write an article about: ${topic.title}

Section: ${topic.section}
Description: ${topic.description}
Keywords: ${topic.keywords.join(', ')}

Generate a complete article following all guidelines${applyStyle ? ' (including RUN-SPECIFIC length and tone above)' : ''}.
Remember: seoDescription must be at most 155 characters (count spaces).`;
    const response = await axios_1.default.post('https://api.openai.com/v1/chat/completions', {
        model: WRITER_OPENAI_MODEL,
        messages: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: userPrompt,
            },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
    }, {
        headers: {
            'Authorization': `Bearer ${config_1.config.openai.apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    const content = response.data.choices[0].message.content;
    let parsedContent;
    try {
        // Remove markdown code blocks if present
        const cleanedContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsedContent = JSON.parse(cleanedContent);
    }
    catch (parseError) {
        throw new Error(`Failed to parse article JSON: ${parseError}`);
    }
    // Ensure slug is generated if missing or invalid
    if (parsedContent && typeof parsedContent === 'object' && 'title' in parsedContent) {
        const articleObj = parsedContent;
        if (!articleObj.slug || articleObj.slug.trim() === '') {
            articleObj.slug = (0, slug_1.generateSlug)(articleObj.title);
        }
    }
    applyWriterArticleLengthSafetyTruncate(parsedContent);
    const validation = (0, validator_1.validateArticle)(parsedContent);
    if (!validation.success) {
        throw new Error(`Article validation failed: ${validation.errors?.join(', ')}`);
    }
    let article = {
        ...validation.data,
        author: exports.HAPPYTIMESAZ_EDITORIAL_AUTHOR,
    };
    if (options?.userSuppliedImages) {
        article = {
            ...article,
            heroImagePrompt: exports.EDITOR_SUPPLIED_HERO_IMAGE_PROMPT,
        };
    }
    return article;
}
//# sourceMappingURL=writerAgent.js.map
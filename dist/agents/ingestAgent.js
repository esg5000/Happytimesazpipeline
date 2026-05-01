"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestToTopic = ingestToTopic;
const axios_1 = __importDefault(require("axios"));
const fs_1 = require("fs");
const path_1 = require("path");
const config_1 = require("../config");
const validator_1 = require("../utils/validator");
const articleStyle_1 = require("../utils/articleStyle");
// Resolve prompt path - works in both dev and compiled dist
const INGEST_PROMPT_PATH = (0, path_1.join)(process.cwd(), 'prompts', 'ingest.prompt.txt');
/**
 * Converts Telegram notes into a validated Topic JSON object.
 */
async function ingestToTopic(input) {
    const baseIngest = (0, fs_1.readFileSync)(INGEST_PROMPT_PATH, 'utf-8');
    const applyStyle = input.applyDashboardArticleStyle === true;
    const length = input.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
    const tone = input.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
    const systemPrompt = applyStyle
        ? `${baseIngest.trim()}${(0, articleStyle_1.buildIngestArticleStyleAppend)(length, tone)}`
        : baseIngest.trim();
    const userParts = [];
    if (input.section)
        userParts.push(`PREFERRED_SECTION: ${input.section}`);
    if (input.title)
        userParts.push(`PREFERRED_TITLE: ${input.title}`);
    if (input.keywords && input.keywords.length > 0) {
        userParts.push(`PREFERRED_KEYWORDS: ${input.keywords.join(', ')}`);
    }
    userParts.push(`NOTES:\n${input.notes}`);
    const response = await axios_1.default.post('https://api.openai.com/v1/chat/completions', {
        model: config_1.config.openai.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userParts.join('\n\n') },
        ],
        temperature: 0.6,
        response_format: { type: 'json_object' },
    }, {
        headers: {
            Authorization: `Bearer ${config_1.config.openai.apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    const content = response.data.choices[0].message.content;
    let parsedContent;
    try {
        const cleanedContent = content
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();
        parsedContent = JSON.parse(cleanedContent);
    }
    catch (parseError) {
        throw new Error(`Failed to parse ingest topic JSON: ${parseError}`);
    }
    const validation = (0, validator_1.validateTopic)(parsedContent);
    if (!validation.success) {
        throw new Error(`Ingest topic validation failed: ${validation.errors?.join(', ')}`);
    }
    return validation.data;
}
//# sourceMappingURL=ingestAgent.js.map
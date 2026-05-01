"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateImagePrompt = generateImagePrompt;
exports.generateImage = generateImage;
exports.downloadImage = downloadImage;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const fs_1 = require("fs");
const path_1 = require("path");
// Resolve prompt path - works in both dev and compiled dist
const IMAGE_PROMPT_PATH = (0, path_1.join)(process.cwd(), 'prompts', 'image.prompt.txt');
/**
 * Generates an enhanced image prompt for DALL-E or similar
 */
async function generateImagePrompt(basePrompt, visualStyle) {
    const systemPrompt = (0, fs_1.readFileSync)(IMAGE_PROMPT_PATH, 'utf-8');
    const response = await axios_1.default.post('https://api.openai.com/v1/chat/completions', {
        model: config_1.config.openai.model,
        messages: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: `VISUAL_STYLE: ${visualStyle}\n\nEnhance this base hero image scene description into a final image prompt. Preserve the subject, setting, and composition from the base prompt. Apply the VISUAL_STYLE.\n\nBASE_PROMPT: ${basePrompt}`,
            },
        ],
        temperature: 0.8,
        max_tokens: 200,
    }, {
        headers: {
            'Authorization': `Bearer ${config_1.config.openai.apiKey}`,
            'Content-Type': 'application/json',
        },
    });
    const enhancedPrompt = response.data.choices[0].message.content.trim();
    return enhancedPrompt;
}
/**
 * Generates an image using DALL·E 2 (1024×1024; all pipeline heroes use this path).
 */
async function generateImage(prompt) {
    try {
        const response = await axios_1.default.post('https://api.openai.com/v1/images/generations', {
            model: 'dall-e-2',
            prompt: prompt,
            // DALL·E 2 supports only square sizes: 256x256, 512x512, 1024x1024
            size: '1024x1024',
            n: 1,
        }, {
            headers: {
                'Authorization': `Bearer ${config_1.config.openai.apiKey}`,
                'Content-Type': 'application/json',
            },
        });
        const imageUrl = response.data.data[0].url;
        return typeof imageUrl === 'string' && imageUrl.trim() ? imageUrl : null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[imageAgent] DALL·E image generation failed; continuing without image:', msg);
        if (err instanceof Error && err.stack) {
            console.warn('[imageAgent] stack:\n', err.stack);
        }
        return null;
    }
}
/**
 * Downloads an image from a URL
 */
async function downloadImage(url) {
    const response = await axios_1.default.get(url, {
        responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
}
//# sourceMappingURL=imageAgent.js.map
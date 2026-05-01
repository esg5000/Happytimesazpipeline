"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribeAudio = transcribeAudio;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const config_1 = require("../config");
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
/**
 * Transcribes audio using OpenAI Whisper (same API key as chat).
 * Telegram voice notes are typically OGG Opus; Whisper accepts common formats.
 */
async function transcribeAudio(audioBuffer, filename = 'voice.ogg') {
    const form = new form_data_1.default();
    form.append('file', audioBuffer, { filename });
    form.append('model', 'whisper-1');
    try {
        const response = await axios_1.default.post(TRANSCRIPTION_URL, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${config_1.config.openai.apiKey}`,
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });
        const text = response.data?.text?.trim() ?? '';
        return text;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err) && err.response?.data) {
            const d = err.response.data;
            const openaiMsg = d?.error?.message;
            if (openaiMsg) {
                throw new Error(`Whisper API: ${openaiMsg}`);
            }
        }
        throw err;
    }
}
//# sourceMappingURL=transcribeAgent.js.map
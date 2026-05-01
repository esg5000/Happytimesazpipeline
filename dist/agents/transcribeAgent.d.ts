/**
 * Transcribes audio using OpenAI Whisper (same API key as chat).
 * Telegram voice notes are typically OGG Opus; Whisper accepts common formats.
 */
export declare function transcribeAudio(audioBuffer: Buffer, filename?: string): Promise<string>;
//# sourceMappingURL=transcribeAgent.d.ts.map
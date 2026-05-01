import { VisualStyle } from '../utils/validator';
/**
 * Generates an enhanced image prompt for DALL-E or similar
 */
export declare function generateImagePrompt(basePrompt: string, visualStyle: VisualStyle): Promise<string>;
/**
 * Generates an image using DALL·E 2 (1024×1024; all pipeline heroes use this path).
 */
export declare function generateImage(prompt: string): Promise<string | null>;
/**
 * Downloads an image from a URL
 */
export declare function downloadImage(url: string): Promise<Buffer>;
//# sourceMappingURL=imageAgent.d.ts.map
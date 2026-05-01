import { z } from 'zod';
export declare const VisualStyleSchema: z.ZodEnum<["editorial_realistic", "cinematic_hyperreal", "film_35mm_grain", "documentary_candid", "neon_night_street", "illustrated_watercolor", "bold_vector_flat", "playful_cartoon", "clay_3d"]>;
export type VisualStyle = z.infer<typeof VisualStyleSchema>;
/** Primary site section slugs (Sanity `category` slug, post.section, pipeline topics). */
export declare const SECTION_SLUGS: readonly ["cannabis", "health-wellness", "nightlife", "food", "events", "sports", "global", "news"];
export type SectionSlug = (typeof SECTION_SLUGS)[number];
/**
 * Schema for article output validation
 */
export declare const ArticleSchema: z.ZodObject<{
    title: z.ZodString;
    slug: z.ZodString;
    excerpt: z.ZodString;
    seoTitle: z.ZodString;
    seoDescription: z.ZodString;
    categories: z.ZodArray<z.ZodString, "many">;
    tags: z.ZodArray<z.ZodString, "many">;
    visualStyle: z.ZodEnum<["editorial_realistic", "cinematic_hyperreal", "film_35mm_grain", "documentary_candid", "neon_night_street", "illustrated_watercolor", "bold_vector_flat", "playful_cartoon", "clay_3d"]>;
    heroImagePrompt: z.ZodString;
    bodyMarkdown: z.ZodString;
    /** Byline for Sanity; set by the writer pipeline, not the model. */
    author: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    title: string;
    slug: string;
    excerpt: string;
    seoTitle: string;
    seoDescription: string;
    categories: string[];
    tags: string[];
    visualStyle: "editorial_realistic" | "cinematic_hyperreal" | "film_35mm_grain" | "documentary_candid" | "neon_night_street" | "illustrated_watercolor" | "bold_vector_flat" | "playful_cartoon" | "clay_3d";
    heroImagePrompt: string;
    bodyMarkdown: string;
    author?: string | undefined;
}, {
    title: string;
    slug: string;
    excerpt: string;
    seoTitle: string;
    seoDescription: string;
    categories: string[];
    tags: string[];
    visualStyle: "editorial_realistic" | "cinematic_hyperreal" | "film_35mm_grain" | "documentary_candid" | "neon_night_street" | "illustrated_watercolor" | "bold_vector_flat" | "playful_cartoon" | "clay_3d";
    heroImagePrompt: string;
    bodyMarkdown: string;
    author?: string | undefined;
}>;
export type Article = z.infer<typeof ArticleSchema>;
/**
 * Validates article data against schema
 */
export declare function validateArticle(data: unknown): {
    success: boolean;
    data?: Article;
    errors?: string[];
};
/**
 * Schema for topic output validation
 */
export declare const TopicSchema: z.ZodObject<{
    title: z.ZodString;
    section: z.ZodEnum<["cannabis", "health-wellness", "nightlife", "food", "events", "sports", "global", "news"]>;
    description: z.ZodString;
    keywords: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    title: string;
    section: "cannabis" | "health-wellness" | "nightlife" | "food" | "events" | "sports" | "global" | "news";
    description: string;
    keywords: string[];
}, {
    title: string;
    section: "cannabis" | "health-wellness" | "nightlife" | "food" | "events" | "sports" | "global" | "news";
    description: string;
    keywords: string[];
}>;
export type Topic = z.infer<typeof TopicSchema>;
/**
 * Validates topic data against schema
 */
export declare function validateTopic(data: unknown): {
    success: boolean;
    data?: Topic;
    errors?: string[];
};
//# sourceMappingURL=validator.d.ts.map
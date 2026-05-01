"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopicSchema = exports.ArticleSchema = exports.SECTION_SLUGS = exports.VisualStyleSchema = void 0;
exports.validateArticle = validateArticle;
exports.validateTopic = validateTopic;
const zod_1 = require("zod");
exports.VisualStyleSchema = zod_1.z.enum([
    'editorial_realistic',
    'cinematic_hyperreal',
    'film_35mm_grain',
    'documentary_candid',
    'neon_night_street',
    'illustrated_watercolor',
    'bold_vector_flat',
    'playful_cartoon',
    'clay_3d',
]);
/** Primary site section slugs (Sanity `category` slug, post.section, pipeline topics). */
exports.SECTION_SLUGS = [
    'cannabis',
    'health-wellness',
    'nightlife',
    'food',
    'events',
    'sports',
    'global',
    'news',
];
/**
 * Schema for article output validation
 */
exports.ArticleSchema = zod_1.z.object({
    title: zod_1.z.string().min(10).max(100),
    slug: zod_1.z.string().min(3).max(100),
    excerpt: zod_1.z.string().min(50).max(200),
    seoTitle: zod_1.z.string().min(10).max(70),
    seoDescription: zod_1.z.string().min(50).max(155),
    categories: zod_1.z.array(zod_1.z.string()).min(1).max(5),
    tags: zod_1.z.array(zod_1.z.string()).min(1).max(10),
    visualStyle: exports.VisualStyleSchema,
    heroImagePrompt: zod_1.z.string().min(20).max(500),
    bodyMarkdown: zod_1.z.string().min(500).max(5000),
    /** Byline for Sanity; set by the writer pipeline, not the model. */
    author: zod_1.z.string().optional(),
});
/**
 * Validates article data against schema
 */
function validateArticle(data) {
    try {
        const validated = exports.ArticleSchema.parse(data);
        return { success: true, data: validated };
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return {
                success: false,
                errors: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
            };
        }
        return {
            success: false,
            errors: ['Unknown validation error'],
        };
    }
}
/**
 * Schema for topic output validation
 */
exports.TopicSchema = zod_1.z.object({
    title: zod_1.z.string().min(10).max(100),
    section: zod_1.z.enum(exports.SECTION_SLUGS),
    description: zod_1.z.string().min(50).max(300),
    keywords: zod_1.z.array(zod_1.z.string()).min(3).max(10),
});
/**
 * Validates topic data against schema
 */
function validateTopic(data) {
    try {
        const validated = exports.TopicSchema.parse(data);
        return { success: true, data: validated };
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return {
                success: false,
                errors: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
            };
        }
        return {
            success: false,
            errors: ['Unknown validation error'],
        };
    }
}
//# sourceMappingURL=validator.js.map
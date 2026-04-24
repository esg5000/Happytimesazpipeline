import { z } from 'zod';

export const VisualStyleSchema = z.enum([
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

export type VisualStyle = z.infer<typeof VisualStyleSchema>;

/** Primary site section slugs (Sanity `category` slug, post.section, pipeline topics). */
export const SECTION_SLUGS = [
  'cannabis',
  'health-wellness',
  'nightlife',
  'food',
  'events',
  'sports',
  'global',
  'news',
] as const;

export type SectionSlug = (typeof SECTION_SLUGS)[number];

/**
 * Schema for article output validation
 */
export const ArticleSchema = z.object({
  title: z.string().min(10).max(100),
  slug: z.string().min(3).max(100),
  excerpt: z.string().min(50).max(200),
  seoTitle: z.string().min(10).max(70),
  seoDescription: z.string().min(50).max(155),
  categories: z.array(z.string()).min(1).max(5),
  tags: z.array(z.string()).min(1).max(10),
  visualStyle: VisualStyleSchema,
  heroImagePrompt: z.string().min(20).max(500),
  bodyMarkdown: z.string().min(500).max(5000),
  /** Byline for Sanity; set by the writer pipeline, not the model. */
  author: z.string().optional(),
});

export type Article = z.infer<typeof ArticleSchema>;

/**
 * Validates article data against schema
 */
export function validateArticle(data: unknown): {
  success: boolean;
  data?: Article;
  errors?: string[];
} {
  try {
    const validated = ArticleSchema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
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
export const TopicSchema = z.object({
  title: z.string().min(10).max(100),
  section: z.enum(SECTION_SLUGS),
  description: z.string().min(50).max(300),
  keywords: z.array(z.string()).min(3).max(10),
});

export type Topic = z.infer<typeof TopicSchema>;

/**
 * Validates topic data against schema
 */
export function validateTopic(data: unknown): {
  success: boolean;
  data?: Topic;
  errors?: string[];
} {
  try {
    const validated = TopicSchema.parse(data);
    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
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


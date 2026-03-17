import { z } from 'zod';

/**
 * Ad placement locations
 */
export const AdPlacement = z.enum([
  'section_header',
  'section_banner',
  'article_header',
  'article_inline',
  'article_mid',
  'article_footer',
]);

export type AdPlacement = z.infer<typeof AdPlacement>;

/**
 * Ad section categories
 */
export const AdSection = z.enum([
  'cannabis',
  'mushrooms',
  'nightlife',
  'food',
  'events',
  'global',
]);

export type AdSection = z.infer<typeof AdSection>;

/**
 * Schema for ad documents in Sanity CMS
 */
export const AdSchema = z.object({
  name: z.string().min(1).max(100),
  advertiser: z.string().min(1).max(100),
  image: z.object({
    _type: z.literal('image'),
    asset: z.object({
      _type: z.literal('reference'),
      _ref: z.string(),
    }),
  }),
  clickUrl: z.string().url(),
  placement: AdPlacement,
  section: AdSection,
  startDate: z.string().datetime().or(z.date()),
  endDate: z.string().datetime().or(z.date()).nullable(),
  priority: z.number().int().min(0).max(100).default(50),
  active: z.boolean().default(true),
});

export type Ad = z.infer<typeof AdSchema>;

/**
 * Sanity document structure for ads
 */
export const SanityAdSchema = AdSchema.extend({
  _type: z.literal('ad'),
  _id: z.string(),
  _createdAt: z.string().datetime().optional(),
  _updatedAt: z.string().datetime().optional(),
  _rev: z.string().optional(),
});

export type SanityAd = z.infer<typeof SanityAdSchema>;

/**
 * Validates ad data against schema
 */
export function validateAd(data: unknown): {
  success: boolean;
  data?: Ad;
  errors?: string[];
} {
  try {
    const validated = AdSchema.parse(data);
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
 * Validates Sanity ad document
 */
export function validateSanityAd(data: unknown): {
  success: boolean;
  data?: SanityAd;
  errors?: string[];
} {
  try {
    const validated = SanityAdSchema.parse(data);
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
 * Helper to check if an ad is currently active based on dates
 */
export function isAdActive(ad: Ad | SanityAd): boolean {
  if (!ad.active) {
    return false;
  }

  const now = new Date();
  const startDate = typeof ad.startDate === 'string' ? new Date(ad.startDate) : ad.startDate;
  const endDate = ad.endDate
    ? typeof ad.endDate === 'string'
      ? new Date(ad.endDate)
      : ad.endDate
    : null;

  if (now < startDate) {
    return false;
  }

  if (endDate && now > endDate) {
    return false;
  }

  return true;
}

/**
 * Query helper for fetching ads by placement and section
 * This is what the frontend would use to fetch ads
 */
export function getAdQuery(placement: AdPlacement, section: AdSection): string {
  return `*[_type == "ad" && placement == "${placement}" && section == "${section}" && active == true] | order(priority desc, _createdAt desc) {
    _id,
    name,
    advertiser,
    image,
    clickUrl,
    placement,
    section,
    startDate,
    endDate,
    priority,
    active
  }`;
}


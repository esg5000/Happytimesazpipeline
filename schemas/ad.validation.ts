import { z } from 'zod';

/**
 * All ad placement locations — must stay in sync with ad.ts placement list
 */
export const AdPlacement = z.enum([
  'homepage_leaderboard',
  'homepage_grid_sponsored',
  'homepage_native_mid',
  'spotlight_cannabis_sidebar',
  'spotlight_events_sidebar',
  'category_leaderboard',
  'category_sidebar_mpu',
  'category_grid_sponsored',
  'category_native_mid',
  'article_inline_banner',
  'article_sidebar_mpu',
  'article_partner_mid',
  'article_related_card',
  'food_in_content_top',
  'food_in_content_mid',
  'food_in_content_lower',
  'listing_sidebar_mpu',
  'cannabis_listing_leaderboard',
  'cannabis_listing_rectangle',
  'cannabis_footer_leaderboard',
  'nightlife_listings_top',
  'nightlife_grid_tile',
  'nightlife_listings_mid',
  'nightlife_footer_leaderboard',
  'mushroom_guide_top',
  'mushroom_guide_mid',
  'mushroom_guide_lower',
  'mushroom_footer_leaderboard',
  'events_listing_leaderboard',
  // Legacy placements
  'homepage_major',
  'homepage_sidebar',
  'section_header',
  'inline_banner',
  'footer_banner',
]);

export type AdPlacement = z.infer<typeof AdPlacement>;

/**
 * Ad type (image or HTML embed)
 */
export const AdType = z.enum(['image', 'html']);

export type AdType = z.infer<typeof AdType>;

/**
 * Schema for ad documents in Sanity CMS — mirrors ad.ts field-for-field
 */
export const AdSchema = z.object({
  title: z.string().min(1).max(200),
  advertiser: z.string().min(1).max(200),
  placement: AdPlacement,
  adType: AdType.default('image'),
  image: z
    .object({
      _type: z.literal('image'),
      asset: z.object({
        _type: z.literal('reference'),
        _ref: z.string(),
      }),
    })
    .optional(),
  html: z.string().optional(),
  headline: z.string().optional(),
  cta: z.string().optional(),
  url: z.string().url().optional(),
  startDate: z.string().datetime().or(z.date()).optional(),
  endDate: z.string().datetime().or(z.date()).nullable().optional(),
  priority: z.number().int().min(0).max(100).default(1),
  active: z.boolean().default(true),
  categories: z
    .array(
      z.object({
        _type: z.literal('reference'),
        _ref: z.string(),
      })
    )
    .optional(),
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
    return { success: false, errors: ['Unknown validation error'] };
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
    return { success: false, errors: ['Unknown validation error'] };
  }
}

/**
 * Helper to check if an ad is currently active based on dates
 */
export function isAdActive(ad: Ad | SanityAd): boolean {
  if (!ad.active) return false;

  const now = new Date();

  if (ad.startDate) {
    const startDate = typeof ad.startDate === 'string' ? new Date(ad.startDate) : ad.startDate;
    if (now < startDate) return false;
  }

  if (ad.endDate) {
    const endDate = typeof ad.endDate === 'string' ? new Date(ad.endDate) : ad.endDate;
    if (now > endDate) return false;
  }

  return true;
}

/**
 * Query helper for fetching active ads by placement
 */
export function getAdQuery(placement: AdPlacement): string {
  return `*[_type == "ad" && placement == "${placement}" && active == true] | order(priority desc, _createdAt desc) {
    _id,
    title,
    advertiser,
    placement,
    adType,
    image,
    html,
    headline,
    cta,
    url,
    startDate,
    endDate,
    priority,
    active
  }`;
}

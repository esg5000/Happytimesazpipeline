import { defineField, defineType } from 'sanity'

export default defineType({
  name: 'ad',
  title: 'Advertisement',
  type: 'document',
  orderings: [
    {
      title: 'Priority (High to Low)',
      name: 'priorityDesc',
      by: [{ field: 'priority', direction: 'desc' }]
    }
  ],
  preview: {
    select: {
      title: 'title',
      advertiser: 'advertiser',
      placement: 'placement',
      active: 'active',
      image: 'image'
    },
    prepare({ title, advertiser, placement, active, image }) {
      return {
        title: title || 'Untitled Ad',
        subtitle: `${advertiser || 'No Advertiser'} • ${placement || 'No Placement'}${active === false ? ' • Inactive' : ''}`,
        media: image
      }
    }
  },
  fields: [
    defineField({
      name: 'title',
      type: 'string',
      title: 'Title',
      description: 'Internal reference name for this ad',
      validation: (r) => r.required()
    }),
    defineField({
      name: 'advertiser',
      type: 'string',
      title: 'Advertiser',
      description: 'Name of the advertiser or sponsor',
      validation: (r) => r.required()
    }),
    defineField({
      name: 'placement',
      type: 'string',
      title: 'Placement',
      description: 'Where this ad will be displayed',
      options: {
        list: [
          { title: 'Homepage — leaderboard (below hero)', value: 'homepage_leaderboard' },
          { title: 'Homepage — grid sponsored (every 6th card)', value: 'homepage_grid_sponsored' },
          { title: 'Homepage — native card (after row 2)', value: 'homepage_native_mid' },
          { title: 'Spotlight — Cannabis sidebar 300×250', value: 'spotlight_cannabis_sidebar' },
          { title: 'Spotlight — Events sidebar 300×250', value: 'spotlight_events_sidebar' },
          { title: 'Category — top leaderboard', value: 'category_leaderboard' },
          { title: 'Category — sticky sidebar 300×250', value: 'category_sidebar_mpu' },
          { title: 'Category — grid sponsored', value: 'category_grid_sponsored' },
          { title: 'Category — native mid-grid', value: 'category_native_mid' },
          { title: 'Article — inline banner (after intro)', value: 'article_inline_banner' },
          { title: 'Article — sticky sidebar 300×250', value: 'article_sidebar_mpu' },
          { title: 'Article — partner callout (mid)', value: 'article_partner_mid' },
          { title: 'Article — related row affiliate', value: 'article_related_card' },
          { title: 'Food — listings in-content (rectangle top)', value: 'food_in_content_top' },
          { title: 'Food — listings in-content (leaderboard mid)', value: 'food_in_content_mid' },
          { title: 'Food — listings in-content (rectangle lower)', value: 'food_in_content_lower' },
          { title: 'Listing detail — sidebar MPU', value: 'listing_sidebar_mpu' },
          { title: 'Cannabis — listing feed (leaderboard)', value: 'cannabis_listing_leaderboard' },
          { title: 'Cannabis — listing feed (rectangle)', value: 'cannabis_listing_rectangle' },
          { title: 'Cannabis — footer leaderboard', value: 'cannabis_footer_leaderboard' },
          { title: 'Nightlife — listings top leaderboard', value: 'nightlife_listings_top' },
          { title: 'Nightlife — grid tile rectangle', value: 'nightlife_grid_tile' },
          { title: 'Nightlife — listings mid rectangle', value: 'nightlife_listings_mid' },
          { title: 'Nightlife — footer leaderboard', value: 'nightlife_footer_leaderboard' },
          { title: 'Mushroom guide — top leaderboard', value: 'mushroom_guide_top' },
          { title: 'Mushroom guide — mid rectangle', value: 'mushroom_guide_mid' },
          { title: 'Mushroom guide — lower leaderboard', value: 'mushroom_guide_lower' },
          { title: 'Mushroom guide — footer leaderboard', value: 'mushroom_footer_leaderboard' },
          { title: 'Events — listings in-feed leaderboard', value: 'events_listing_leaderboard' },
          { title: 'Homepage Major (legacy)', value: 'homepage_major' },
          { title: 'Homepage Sidebar (legacy)', value: 'homepage_sidebar' },
          { title: 'Section Header', value: 'section_header' },
          { title: 'Inline Banner (legacy)', value: 'inline_banner' },
          { title: 'Footer Banner', value: 'footer_banner' }
        ],
        layout: 'dropdown'
      },
      validation: (r) => r.required()
    }),
    defineField({
      name: 'adType',
      type: 'string',
      title: 'Ad Type',
      description: 'Type of advertisement content',
      options: {
        list: [
          { title: 'Image', value: 'image' },
          { title: 'HTML', value: 'html' }
        ],
        layout: 'radio'
      },
      initialValue: 'image',
      validation: (r) => r.required()
    }),
    defineField({
      name: 'image',
      type: 'image',
      title: 'Image',
      description: 'Ad image (only used if Ad Type is Image)',
      options: { hotspot: true },
      hidden: ({ parent }) => parent?.adType !== 'image'
    }),
    defineField({
      name: 'html',
      type: 'text',
      title: 'HTML Code',
      description: 'HTML/script code for the ad (only used if Ad Type is HTML)',
      hidden: ({ parent }) => parent?.adType !== 'html'
    }),
    defineField({
      name: 'headline',
      type: 'string',
      title: 'Headline',
      description: 'Optional headline text to display with the ad'
    }),
    defineField({
      name: 'cta',
      type: 'string',
      title: 'Call to Action',
      description: 'Button or link text',
      initialValue: 'Learn More'
    }),
    defineField({
      name: 'url',
      type: 'url',
      title: 'URL',
      description: 'Destination URL when ad is clicked',
      validation: (r) => r.uri({ scheme: ['http', 'https'] })
    }),
    defineField({
      name: 'startDate',
      type: 'datetime',
      title: 'Start Date',
      description: 'Optional: When this ad should start showing'
    }),
    defineField({
      name: 'endDate',
      type: 'datetime',
      title: 'End Date',
      description: 'Optional: When this ad should stop showing'
    }),
    defineField({
      name: 'priority',
      type: 'number',
      title: 'Priority',
      description: 'Higher numbers show first when multiple ads exist for the same placement',
      initialValue: 1,
      validation: (r) => r.min(0).max(100)
    }),
    defineField({
      name: 'active',
      type: 'boolean',
      title: 'Active',
      description: 'Whether this ad is currently active',
      initialValue: true
    }),
    defineField({
      name: 'categories',
      type: 'array',
      title: 'Categories',
      description: 'Optional: Limit this ad to specific content categories',
      of: [{ type: 'reference', to: [{ type: 'category' }] }]
    })
  ]
})

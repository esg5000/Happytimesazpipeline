import { defineField, defineType } from 'sanity';

export default defineType({
  name: 'dispensary',
  title: 'Dispensary',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'slug',
      type: 'slug',
      options: { source: 'name', maxLength: 96 },
      validation: (r) => r.required(),
    }),
    defineField({ name: 'address', type: 'text', rows: 3 }),
    defineField({ name: 'city', type: 'string' }),
    defineField({ name: 'phone', type: 'string' }),
    defineField({ name: 'website', type: 'url' }),
    defineField({ name: 'hours', type: 'text', rows: 8, title: 'Hours' }),
    defineField({
      name: 'categories',
      type: 'array',
      of: [
        {
          type: 'string',
          options: {
            list: [
              { title: 'Medical', value: 'medical' },
              { title: 'Recreational', value: 'recreational' },
            ],
          },
        },
      ],
    }),
    defineField({ name: 'image', type: 'image', options: { hotspot: true } }),
    defineField({
      name: 'logo',
      type: 'image',
      title: 'Logo / storefront (manual)',
      description:
        'When set, the dispensary scraper skips homepage image capture and only updates deal text.',
      options: { hotspot: true },
    }),
    defineField({ name: 'isActive', type: 'boolean', initialValue: true }),
    defineField({
      name: 'source',
      type: 'string',
      description: 'e.g. google_maps_serpapi',
    }),
    defineField({
      name: 'googlePlaceId',
      type: 'string',
      description: 'Google Maps place_id when available (dedupe key)',
    }),
    defineField({
      name: 'scrapedDealsText',
      type: 'text',
      title: 'Scraped deals / specials text',
      rows: 12,
    }),
    defineField({
      name: 'dealsScrapedAt',
      type: 'datetime',
      title: 'Deals scraped at',
    }),
    defineField({
      name: 'scrapedImage',
      type: 'image',
      title: 'Scraped homepage image',
      description: 'Auto-capture from the website; does not replace `image` or manual `logo`.',
      options: { hotspot: true },
    }),
  ],
  preview: {
    select: { title: 'name', city: 'city', categories: 'categories' },
    prepare({ title, city, categories }) {
      return {
        title: title || 'Dispensary',
        subtitle: [city, (categories || []).join(', ')].filter(Boolean).join(' · '),
      };
    },
  },
});

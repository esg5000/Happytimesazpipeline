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

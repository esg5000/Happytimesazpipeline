import { defineField, defineType } from 'sanity';

export default defineType({
  name: 'restaurant',
  title: 'Restaurant',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'slug',
      type: 'slug',
      options: { source: 'name', maxLength: 96 },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'searchCity',
      type: 'string',
      title: 'Search city',
      description: 'Arizona city used for the SerpAPI query (Phoenix, Scottsdale, …).',
      validation: (r) => r.required(),
    }),
    defineField({ name: 'address', type: 'text', rows: 3 }),
    defineField({ name: 'city', type: 'string', description: 'Parsed from address when possible.' }),
    defineField({
      name: 'cuisineType',
      type: 'string',
      title: 'Cuisine type',
      description: 'Primary cuisine / place type from Google Maps.',
    }),
    defineField({ name: 'rating', type: 'number', description: 'Google rating (e.g. 4.5).' }),
    defineField({ name: 'reviewCount', type: 'number', title: 'Review count' }),
    defineField({
      name: 'priceLevel',
      type: 'number',
      title: 'Price level',
      description: '1–4 derived from Google price hint ($ … $$$$).',
    }),
    defineField({ name: 'phone', type: 'string' }),
    defineField({ name: 'website', type: 'url' }),
    defineField({
      name: 'thumbnail',
      type: 'image',
      options: { hotspot: true },
      description: 'Hero/thumbnail from SerpAPI (uploaded to Sanity assets).',
    }),
    defineField({
      name: 'location',
      type: 'geopoint',
      title: 'GPS coordinates',
    }),
    defineField({
      name: 'googlePlaceId',
      type: 'string',
      title: 'Google place_id',
    }),
    defineField({
      name: 'source',
      type: 'string',
      description: 'Ingest source label (e.g. google_maps_serpapi).',
    }),
  ],
  preview: {
    select: { title: 'name', city: 'searchCity', rating: 'rating', cuisine: 'cuisineType' },
    prepare({ title, city, rating, cuisine }) {
      return {
        title: title || 'Restaurant',
        subtitle: [city, cuisine, rating != null ? `★ ${rating}` : ''].filter(Boolean).join(' · '),
      };
    },
  },
});

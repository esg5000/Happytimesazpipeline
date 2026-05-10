import { defineField, defineType } from 'sanity';

export default defineType({
  name: 'nightlife',
  title: 'Nightlife',
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
    defineField({ name: 'city', type: 'string', description: 'Parsed from address when possible.' }),
    defineField({ name: 'phone', type: 'string' }),
    defineField({ name: 'website', type: 'url' }),
    defineField({ name: 'rating', type: 'number', description: 'Google rating (e.g. 4.5).' }),
    defineField({
      name: 'priceLevel',
      type: 'number',
      title: 'Price level',
      description: '1–4 derived from Google price hint ($ … $$$$).',
    }),
    defineField({
      name: 'googlePlaceId',
      type: 'string',
      title: 'Google place_id',
    }),
    defineField({
      name: 'image',
      type: 'image',
      options: { hotspot: true },
      title: 'Image',
      description: 'Uploaded from SerpAPI / Google Maps preview URL.',
    }),
    defineField({
      name: 'isActive',
      type: 'boolean',
      title: 'Active',
      initialValue: true,
    }),
  ],
  preview: {
    select: { title: 'name', city: 'city', rating: 'rating' },
    prepare({ title, city, rating }) {
      return {
        title: title || 'Nightlife',
        subtitle: [city, rating != null ? `★ ${rating}` : ''].filter(Boolean).join(' · '),
      };
    },
  },
});

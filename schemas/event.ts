import { defineField, defineType } from 'sanity';

export default defineType({
  name: 'event',
  title: 'Event',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'slug',
      type: 'slug',
      options: { source: 'title', maxLength: 96 },
      validation: (r) => r.required(),
    }),
    defineField({ name: 'date', type: 'datetime', title: 'Start', validation: (r) => r.required() }),
    defineField({ name: 'endDate', type: 'datetime', title: 'End' }),
    defineField({ name: 'venue', type: 'string' }),
    defineField({ name: 'address', type: 'string' }),
    defineField({ name: 'city', type: 'string' }),
    defineField({ name: 'description', type: 'text', rows: 6 }),
    defineField({ name: 'image', type: 'image', options: { hotspot: true } }),
    defineField({ name: 'ticketUrl', type: 'url' }),
    defineField({
      name: 'price',
      type: 'string',
      description: 'Display string e.g. Free or $25',
    }),
    defineField({
      name: 'categories',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({ name: 'isActive', type: 'boolean', initialValue: true }),
    defineField({
      name: 'source',
      type: 'string',
      description: 'e.g. eventbrite',
    }),
    defineField({
      name: 'eventbriteEventId',
      type: 'string',
      description: 'Eventbrite event id — dedupe key for sync',
    }),
  ],
  preview: {
    select: { title: 'title', date: 'date', city: 'city' },
    prepare({ title, date, city }) {
      return {
        title: title || 'Event',
        subtitle: [city, date].filter(Boolean).join(' · '),
      };
    },
  },
});

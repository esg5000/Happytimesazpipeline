import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'ad',
  title: 'Advertisement',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Campaign Name',
      type: 'string',
      validation: r => r.required()
    }),

    defineField({
      name: 'advertiser',
      title: 'Advertiser',
      type: 'string'
    }),

    defineField({
      name: 'image',
      title: 'Ad Image',
      type: 'image',
      options: { hotspot: true },
      validation: r => r.required()
    }),

    defineField({
      name: 'clickUrl',
      title: 'Destination URL',
      type: 'url',
      validation: r => r.required()
    }),

    defineField({
      name: 'placement',
      title: 'Placement',
      type: 'string',
      options: {
        list: [
          'section_header',
          'section_banner',
          'article_header',
          'article_inline',
          'article_mid',
          'article_footer'
        ]
      },
      validation: r => r.required()
    }),

    defineField({
      name: 'section',
      title: 'Section Target',
      type: 'string',
      options: {
        list: [
          'cannabis',
          'mushrooms',
          'nightlife',
          'food',
          'events',
          'global'
        ]
      },
      validation: r => r.required()
    }),

    defineField({
      name: 'startDate',
      title: 'Start Date',
      type: 'datetime'
    }),

    defineField({
      name: 'endDate',
      title: 'End Date',
      type: 'datetime'
    }),

    defineField({
      name: 'priority',
      title: 'Priority',
      type: 'number',
      initialValue: 1
    }),

    defineField({
      name: 'active',
      title: 'Active',
      type: 'boolean',
      initialValue: true
    })
  ]
})

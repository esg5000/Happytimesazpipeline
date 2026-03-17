import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: r => r.required()
    }),

    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {
        source: 'title',
        maxLength: 100
      },
      validation: r => r.required()
    }),

    defineField({
      name: 'excerpt',
      title: 'Excerpt',
      type: 'text',
      validation: r => r.required()
    }),

    defineField({
      name: 'seoTitle',
      title: 'SEO Title',
      type: 'string'
    }),

    defineField({
      name: 'seoDescription',
      title: 'SEO Description',
      type: 'text'
    }),

    defineField({
      name: 'category',
      title: 'Category',
      type: 'reference',
      to: [{ type: 'category' }],
      description: 'The primary category for this article. Automatically set based on the section.'
    }),

    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{ type: 'string' }]
    }),

    defineField({
      name: 'heroImage',
      title: 'Hero Image',
      type: 'image',
      options: { hotspot: true }
    }),

    defineField({
      name: 'body',
      title: 'Body',
      type: 'array',
      of: [{ type: 'block' }],
      validation: r => r.required()
    }),

    defineField({
      name: 'section',
      title: 'Section',
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
      description: 'The primary section for this article. This will automatically be added to categories.'
    }),

    defineField({
      name: 'publishedAt',
      title: 'Published At',
      type: 'datetime'
    })
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'section'
    }
  }
})


import { defineArrayMember, defineField, defineType } from 'sanity'

export default defineType({
  name: 'post',
  title: 'Post',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'slug', type: 'slug', options: { source: 'title', maxLength: 96 }, validation: (r) => r.required() }),
    defineField({ name: 'excerpt', type: 'text', rows: 3 }),
    defineField({ name: 'publishedAt', type: 'datetime' }),
    defineField({ name: 'readTime', type: 'number', description: 'Estimated minutes' }),
    defineField({ name: 'category', type: 'reference', to: [{ type: 'category' }] }),
    defineField({ name: 'categories', type: 'array', of: [{ type: 'string' }] }),
    defineField({
      name: 'visualStyle',
      title: 'Visual Style (pipeline)',
      type: 'string',
      description: 'The image style profile used by the AI pipeline.',
      options: {
        list: [
          'editorial_realistic',
          'cinematic_hyperreal',
          'film_35mm_grain',
          'documentary_candid',
          'neon_night_street',
          'illustrated_watercolor',
          'bold_vector_flat',
          'playful_cartoon',
          'clay_3d'
        ]
      }
    }),
    defineField({ name: 'heroImage', type: 'image', options: { hotspot: true } }),
    defineField({
      name: 'mainImage',
      type: 'image',
      title: 'Main image (legacy)',
      description: 'Optional. The site prefers heroImage, then mainImage if hero is empty.',
      options: { hotspot: true }
    }),
    defineField({
      name: 'body',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'block',
          styles: [
            { title: 'Normal', value: 'normal' },
            { title: 'H2', value: 'h2' },
            { title: 'H3', value: 'h3' },
            { title: 'H4', value: 'h4' },
            { title: 'Quote', value: 'blockquote' }
          ],
          lists: [
            { title: 'Bullet', value: 'bullet' },
            { title: 'Numbered', value: 'number' }
          ],
          marks: {
            decorators: [
              { title: 'Strong', value: 'strong' },
              { title: 'Emphasis', value: 'em' }
            ],
            annotations: [
              {
                name: 'link',
                type: 'object',
                title: 'Link',
                fields: [
                  {
                    name: 'href',
                    type: 'url',
                    title: 'URL',
                    validation: (Rule) => Rule.uri({ allowRelative: true, scheme: ['http', 'https', 'mailto', 'tel'] })
                  }
                ]
              },
              {
                name: 'affiliateLink',
                type: 'object',
                title: 'Affiliate / partner link',
                fields: [
                  defineField({
                    name: 'href',
                    type: 'url',
                    title: 'URL',
                    validation: (r) => r.uri({ scheme: ['http', 'https'] })
                  })
                ]
              }
            ]
          }
        }),
        defineArrayMember({
          type: 'image',
          options: { hotspot: true },
          fields: [
            defineField({ name: 'alt', type: 'string', title: 'Alternative text' }),
            defineField({ name: 'caption', type: 'string', title: 'Caption' })
          ]
        })
      ]
    }),
    defineField({
      name: 'contentSource',
      type: 'string',
      title: 'Content Source',
      options: {
        list: [
          { title: 'Manual', value: 'manual' },
          { title: 'NewsAPI (legacy)', value: 'newsapi' },
          { title: 'Google News (SerpApi)', value: 'google_news' },
        ],
        layout: 'radio'
      },
      initialValue: 'manual'
    }),
    defineField({
      name: 'source',
      type: 'string',
      title: 'Ingest source label',
      description: 'e.g. google_news, newsapi (legacy) — automated wire sync',
    }),
    defineField({
      name: 'originalSourceUrl',
      type: 'url',
      title: 'Original article URL',
      description: 'Canonical URL from the wire (dedupe key for Google News / wire sync)',
    }),
    defineField({
      name: 'isActive',
      type: 'boolean',
      title: 'Active',
      description: 'When false, hide from listings (e.g. superseded)',
      initialValue: true,
    }),
    defineField({
      name: 'status',
      type: 'string',
      title: 'Status',
      options: {
        list: [
          { title: 'Draft', value: 'draft' },
          { title: 'Published', value: 'published' },
          { title: 'Scheduled', value: 'scheduled' }
        ],
        layout: 'radio'
      },
      initialValue: 'draft'
    }),
    defineField({ name: 'scheduledPublishDate', type: 'datetime', title: 'Scheduled Publish Date' }),
    defineField({ name: 'tags', type: 'array', of: [{ type: 'string' }], title: 'Tags' }),
    // SEO fields
    defineField({ name: 'seoTitle', type: 'string', title: 'SEO Title' }),
    defineField({ name: 'seoDescription', type: 'text', rows: 2, title: 'SEO Description' }),
    defineField({ name: 'seoKeywords', type: 'array', of: [{ type: 'string' }], title: 'SEO Keywords' }),
    // Content flags
    defineField({ name: 'needsFactCheck', type: 'boolean', title: 'Needs Fact-Check', initialValue: false }),
    defineField({ name: 'needsLocalInfo', type: 'boolean', title: 'Needs Local Info', initialValue: false }),
    defineField({ name: 'author', type: 'string', title: 'Author' }),
    // Pipeline-specific: used by the content generation pipeline for section routing
    defineField({
      name: 'section',
      title: 'Section',
      type: 'string',
      options: {
        list: [
          'cannabis',
          'health-wellness',
          'nightlife',
          'food',
          'events',
          'global',
          'news',
        ]
      },
      description: 'The primary section for this article. Used by the pipeline to route content.'
    })
  ],
  preview: {
    select: {
      title: 'title',
      status: 'status',
      contentSource: 'contentSource',
      category: 'category.title'
    },
    prepare({ title, status, contentSource, category }) {
      return {
        title,
        subtitle: `${status || 'draft'} • ${contentSource || 'manual'} • ${category || 'uncategorized'}`
      }
    }
  }
})

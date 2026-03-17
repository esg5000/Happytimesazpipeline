# HappyTimesAZ AI Publishing Pipeline

A deterministic AI publishing pipeline that generates 3 articles per day and publishes them to Sanity CMS as drafts.

## Architecture

- **Deterministic pipeline**: Predictable, repeatable workflow
- **Strict JSON outputs**: All AI responses validated against schemas
- **Schema-aligned publishing**: Articles match Sanity CMS schema
- **No frontend logic**: Pure backend automation service
- **Ad management**: Ads are managed via CMS, not embedded in AI text

## Project Structure

```
/ai-pipeline
  /agents
    topicAgent.ts      # Generates article topics
    writerAgent.ts     # Writes full articles
    imageAgent.ts      # Generates and processes images
    sanityPublisher.ts # Publishes to Sanity CMS
  /prompts
    topic.prompt.txt   # Topic generation prompt
    writer.prompt.txt  # Article writing prompt
    image.prompt.txt   # Image prompt enhancement
  /utils
    slug.ts            # Slug generation utilities
    validator.ts       # JSON schema validation
  orchestrator.ts      # Main pipeline orchestrator
  config.ts           # Configuration management
```

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key
- `OPENAI_MODEL`: OpenAI model to use (default: `gpt-4-turbo-preview`)
- `SANITY_PROJECT_ID`: Your Sanity project ID
- `SANITY_DATASET`: Sanity dataset name (default: `production`)
- `SANITY_API_TOKEN`: Sanity API token with write permissions
- `SANITY_API_VERSION`: Sanity API version (default: `2024-01-01`)
- `ARTICLES_PER_DAY`: Number of articles to generate (default: `3`)
- `DEFAULT_SECTION`: Default section if not specified (default: `cannabis`)

### 3. Build the Project

```bash
npm run build
```

## Usage

### Run the Pipeline

```bash
npm start
```

Or run in development mode (with ts-node):

```bash
npm run dev
```

### Type Checking

```bash
npm run type-check
```

## Pipeline Flow

1. **Generate Topics**: Creates 3 article topics using OpenAI
2. **Write Articles**: Generates full articles (650-900 words) for each topic
3. **Generate Images**: Creates hero images using DALL-E 3
4. **Upload Images**: Uploads images to Sanity assets API
5. **Publish Drafts**: Creates post documents in Sanity as drafts
6. **Log Results**: Outputs summary of successful/failed articles

## Article Output Schema

Each article outputs the following JSON structure:

```json
{
  "title": "Article title",
  "slug": "url-friendly-slug",
  "excerpt": "Compelling excerpt",
  "seoTitle": "SEO optimized title",
  "seoDescription": "SEO meta description",
  "categories": ["category1", "category2"],
  "tags": ["tag1", "tag2", "tag3"],
  "heroImagePrompt": "Detailed image generation prompt",
  "bodyMarkdown": "Full article body in Markdown"
}
```

All outputs are validated against strict schemas before publishing.

## Writer Guidelines

- **Tone**: Phoenix lifestyle insider voice, fun, local, energetic
- **No corporate tone**: Avoid formal or corporate language
- **No AI disclaimers**: Never mention AI or automation
- **Length**: 650-900 words
- **SEO**: Natural keyword repetition, subheaders, scannable paragraphs
- **No ads**: No ad decisions or placements in the text

## Image Guidelines

- **Style**: Editorial photography
- **Color Palette**: Desert colors (warm earth tones, sunset colors)
- **Format**: 16:9 aspect ratio (hero images)
- **No Text Overlays**: Clean editorial photography only

## Sanity CMS Integration

Articles are published as draft posts with the following structure:

- `_type`: `post`
- `title`: Article title
- `slug`: URL-friendly slug
- `excerpt`: Article excerpt
- `seoTitle`: SEO title
- `seoDescription`: SEO description
- `categories`: Array of category references
- `tags`: Array of tag strings
- `heroImage`: Reference to uploaded image asset
- `body`: Article body in Markdown
- `section`: Section name (cannabis, mushrooms, nightlife, food, events, global)
- `publishedAt`: `null` (draft by default)

## Ad System

Ads are managed separately in Sanity CMS with the following schema:

- `name`: Ad name
- `advertiser`: Advertiser name
- `image`: Ad image
- `clickUrl`: Ad destination URL
- `placement`: Enum (section_header, section_banner, article_header, article_inline, article_mid, article_footer)
- `section`: Enum (cannabis, mushrooms, nightlife, food, events, global)
- `startDate`: Ad start date
- `endDate`: Ad end date
- `priority`: Priority number
- `active`: Boolean flag

The pipeline does NOT choose ads. Ads are fetched by placement + section on the frontend.

## Error Handling

The pipeline continues processing even if individual articles fail. All errors are logged and a summary is provided at the end.

## License

ISC

# Happytimesazpipeline

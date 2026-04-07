import { createClient, SanityClient } from '@sanity/client';
import { config } from '../config';
import { Article } from '../utils/validator';
import { downloadImage } from './imageAgent';

let client: SanityClient | null = null;

/**
 * Initializes Sanity client
 */
export function getSanityClient(): SanityClient {
  if (!client) {
    client = createClient({
      projectId: config.sanity.projectId,
      dataset: config.sanity.dataset,
      apiVersion: config.sanity.apiVersion,
      token: config.sanity.apiToken,
      useCdn: false,
    });
  }
  return client;
}

/**
 * Uploads an image to Sanity assets
 */
export async function uploadImageToSanity(
  imageUrl: string,
  filename: string
): Promise<string> {
  const sanityClient = getSanityClient();

  try {
    // Download the image
    const imageBuffer = await downloadImage(imageUrl);

    // Upload to Sanity
    const asset = await sanityClient.assets.upload('image', imageBuffer, {
      filename: filename,
    });

    return asset._id;
  } catch (error) {
    console.error('Error uploading image to Sanity:', error);
    throw error;
  }
}

/**
 * Uploads an image buffer to Sanity assets (e.g., Telegram photo)
 */
export async function uploadImageBufferToSanity(
  imageBuffer: Buffer,
  filename: string
): Promise<string> {
  const sanityClient = getSanityClient();

  try {
    const asset = await sanityClient.assets.upload('image', imageBuffer, {
      filename,
    });
    return asset._id;
  } catch (error) {
    console.error('Error uploading image buffer to Sanity:', error);
    throw error;
  }
}

/**
 * Publishes an article to Sanity as a draft
 */
/**
 * Generates a unique key for Portable Text blocks/spans
 */
function generateKey(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function markdownToPortableText(markdown: string) {
  const blocks: any[] = [];
  const lines = markdown.split('\n');

  lines.forEach(line => {
    line = line.trim();
    if (!line) {
      return;
    }

    let style: string = 'normal';
    let listItem: string | undefined = undefined;
    let level: number | undefined = undefined;
    let textContent: string = line;

    // Detect markdown headings and lists
    if (textContent.startsWith('### ')) {
      style = 'h3';
      textContent = textContent.substring(4);
    } else if (textContent.startsWith('## ')) {
      style = 'h2';
      textContent = textContent.substring(3);
    } else if (textContent.startsWith('# ')) {
      style = 'h1';
      textContent = textContent.substring(2);
    } else if (textContent.startsWith('- ')) {
      style = 'normal'; // List items usually have 'normal' style
      listItem = 'bullet';
      level = 1;
      textContent = textContent.substring(2);
    }

    const children: any[] = [];
    let remainingText = textContent;

    // Process inline formatting (bold and italic)
    while (remainingText.length > 0) {
      let match;
      let plainText = '';

      // Check for bold (**text**)
      match = remainingText.match(/^(.*?)\*\*(.*?)\*\*(.*)$/);
      if (match) {
        plainText = match[1];
        if (plainText) {
          children.push({ 
            _type: 'span', 
            _key: generateKey(),
            text: plainText, 
            marks: [] 
          });
        }
        children.push({ 
          _type: 'span', 
          _key: generateKey(),
          text: match[2], 
          marks: ['strong'] 
        });
        remainingText = match[3];
        continue;
      }

      // Check for italic (*text*)
      match = remainingText.match(/^(.*?)\*(.*?)\*(.*)$/);
      if (match) {
        plainText = match[1];
        if (plainText) {
          children.push({ 
            _type: 'span', 
            _key: generateKey(),
            text: plainText, 
            marks: [] 
          });
        }
        children.push({ 
          _type: 'span', 
          _key: generateKey(),
          text: match[2], 
          marks: ['em'] 
        });
        remainingText = match[3];
        continue;
      }

      // If no markdown found, push the rest as plain text and break
      children.push({ 
        _type: 'span', 
        _key: generateKey(),
        text: remainingText, 
        marks: [] 
      });
      remainingText = '';
    }

    // Ensure there's at least one child span if no content or only spaces were found
    if (children.length === 0 && textContent) {
      children.push({ 
        _type: 'span', 
        _key: generateKey(),
        text: textContent, 
        marks: [] 
      });
    } else if (children.length === 0 && !textContent) {
      // For empty lines that passed filter(Boolean) but resulted in no text content after trimming/markdown removal
      // This might happen if a line was just '## ' for example
      children.push({ 
        _type: 'span', 
        _key: generateKey(),
        text: '', 
        marks: [] 
      });
    }

    const block: any = {
      _type: 'block',
      _key: generateKey(),
      style,
      children,
      markDefs: [],
    };

    if (listItem) {
      block.listItem = listItem;
    }
    if (level) {
      block.level = level;
    }

    blocks.push(block);
  });

  return blocks;
}


export async function publishArticleToSanity(
  article: Article,
  heroImageAssetId: string,
  section: string
): Promise<string> {
  const sanityClient = getSanityClient();

  let primarySection = section.trim().toLowerCase();
  if (primarySection === 'mushrooms' || primarySection === 'wellness') {
    primarySection = 'health-wellness';
  }

  // Ensure bodyMarkdown exists and is a string
  if (!article.bodyMarkdown || typeof article.bodyMarkdown !== 'string') {
    throw new Error(`Invalid bodyMarkdown: expected string, got ${typeof article.bodyMarkdown}`);
  }

  const portableTextBody = markdownToPortableText(article.bodyMarkdown);

  // Validate that portableTextBody is an array
  if (!Array.isArray(portableTextBody)) {
    console.error('ERROR: markdownToPortableText did not return an array!', portableTextBody);
    throw new Error(`markdownToPortableText returned ${typeof portableTextBody}, expected array`);
  }

  // Ensure it's not empty
  if (portableTextBody.length === 0) {
    throw new Error('markdownToPortableText returned empty array');
  }

  // Ensure categories array is not empty - use section as fallback
  let categoryStrings = article.categories || [];
  if (!Array.isArray(categoryStrings) || categoryStrings.length === 0) {
    console.warn(`⚠️  Article "${article.title}" has no categories, using section "${primarySection}" as category`);
    categoryStrings = [primarySection];
  } else {
    // Ensure section is included in categories if not already present
    if (!categoryStrings.includes(primarySection)) {
      categoryStrings = [primarySection, ...categoryStrings];
    }
  }

  // Filter categories to only include valid values from the predefined list (site slugs + extras)
  const validCategoryValues = [
    'cannabis',
    'health-wellness',
    'nightlife',
    'food',
    'events',
    'global',
    'news',
    'lifestyle',
    'culture',
    'entertainment',
  ];
  categoryStrings = categoryStrings
    .map((cat) => {
      const c =
        typeof cat === 'string' ? cat.toLowerCase().trim() : String(cat).toLowerCase().trim();
      if (c === 'mushrooms' || c === 'wellness') return 'health-wellness';
      return c;
    })
    .filter((cat) => validCategoryValues.includes(cat));
  
  // Ensure we still have at least the section after filtering
  if (categoryStrings.length === 0 || !categoryStrings.includes(primarySection)) {
    categoryStrings = [primarySection];
  }

  // Remove duplicates and ensure section is first
  categoryStrings = [...new Set([primarySection, ...categoryStrings])];

  // Convert category strings to a single Sanity reference
  let categoryRef: { _type: 'reference'; _ref: string } | null = null;
  
  try {
    // Query Sanity for matching category documents - use section as primary category
    const primaryCategorySlug = primarySection; // Use section as the primary category
    const categoryDocs = await sanityClient.fetch<Array<{ _id: string; slug: { current: string } }>>(
      `*[_type == "category" && slug.current == $slug]{
        _id,
        slug
      }`,
      { slug: primaryCategorySlug }
    );

    if (categoryDocs && categoryDocs.length > 0) {
      // Use the first matching category as the single reference
      categoryRef = {
        _type: 'reference' as const,
        _ref: categoryDocs[0]._id
      };
      console.log(`✅ Found category reference for: ${primaryCategorySlug}`);
    } else {
      console.warn(`⚠️  No category document found in Sanity for: ${primaryCategorySlug}`);
      console.warn(`⚠️  Article will be published without a category reference`);
    }
  } catch (error: any) {
    console.error('❌ Error fetching category document:', error?.message || error);
    console.warn(`⚠️  Continuing without category reference`);
  }

  // Debug logging
  console.log('📋 Category strings:', JSON.stringify(categoryStrings));
  console.log('📋 Category reference:', JSON.stringify(categoryRef));
  console.log('📋 Section:', primarySection);

  const document = {
    _type: 'post',
    title: article.title,
    slug: {
      _type: 'slug',
      current: article.slug,
    },
    excerpt: article.excerpt,
    seoTitle: article.seoTitle,
    seoDescription: article.seoDescription,
    visualStyle: article.visualStyle,
    category: categoryRef ? {
      _type: 'reference',
      _ref: categoryRef._ref
    } : undefined, // Single category reference, not array
    tags: article.tags,
    heroImage: {
      _type: 'image',
      asset: {
        _type: 'reference',
        _ref: heroImageAssetId,
      },
    },
    body: portableTextBody, // This MUST be an array
    section: primarySection,
    publishedAt: null, // Draft by default
    _id: `post-${article.slug}-${Date.now()}`,
  };

  try {
    console.log('📤 Creating document with category:', document.category);
    const result = await sanityClient.create(document);
    console.log('✅ Document created:', result._id);
    
    // Wait a moment for Sanity to process
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Always patch category to ensure it's saved (even if it was in initial create)
    if (categoryRef) {
      try {
        console.log('🔄 Patching category:', categoryRef);
        await sanityClient
          .patch(result._id)
          .set({ category: categoryRef })
          .commit();
        
        // Wait and verify
        await new Promise(resolve => setTimeout(resolve, 1000));
        const verifyDoc = await sanityClient.getDocument(result._id);
        
        if (verifyDoc && verifyDoc.category) {
          console.log('✅ Category confirmed in document:', verifyDoc.category);
        } else {
          console.error('❌ Category missing! Attempting final patch...');
          // Final attempt with category reference
          await sanityClient
            .patch(result._id)
            .set({ 
              category: categoryRef
            })
            .commit();
          console.log('🔄 Final patch completed');
          
          // Verify one more time
          await new Promise(resolve => setTimeout(resolve, 500));
          const finalVerify = await sanityClient.getDocument(result._id);
          if (finalVerify && finalVerify.category) {
            console.log('🔍 Final verification category:', finalVerify.category);
          }
        }
      } catch (patchError: any) {
        console.error('❌ Patch error:', patchError?.message || patchError);
        console.error('❌ Patch error details:', JSON.stringify(patchError, null, 2));
      }
    } else {
      console.warn('⚠️  No category reference to patch');
    }
    
    return result._id;
  } catch (error: any) {
    console.error('❌ Sanity create error:', error?.response?.body || error);
    throw error;
  }
}

/**
 * Publishes a NewsAPI-sourced article: section `news`, source labels, published + active.
 */
export async function publishNewsApiArticleToSanity(
  article: Article,
  heroImageAssetId: string | undefined,
  originalSourceUrl: string
): Promise<string> {
  const sanityClient = getSanityClient();
  const primarySection = 'news';

  if (!article.bodyMarkdown || typeof article.bodyMarkdown !== 'string') {
    throw new Error(`Invalid bodyMarkdown: expected string, got ${typeof article.bodyMarkdown}`);
  }

  const portableTextBody = markdownToPortableText(article.bodyMarkdown);

  if (!Array.isArray(portableTextBody) || portableTextBody.length === 0) {
    throw new Error('markdownToPortableText returned invalid body for NewsAPI article');
  }

  let categoryStrings = article.categories || [];
  if (!Array.isArray(categoryStrings) || categoryStrings.length === 0) {
    categoryStrings = ['news'];
  } else if (!categoryStrings.includes('news')) {
    categoryStrings = ['news', ...categoryStrings];
  }

  const validCategoryValues = [
    'cannabis',
    'health-wellness',
    'nightlife',
    'food',
    'events',
    'global',
    'news',
    'lifestyle',
    'culture',
    'entertainment',
  ];
  categoryStrings = categoryStrings
    .map((cat) => {
      const c =
        typeof cat === 'string' ? cat.toLowerCase().trim() : String(cat).toLowerCase().trim();
      if (c === 'mushrooms' || c === 'wellness') return 'health-wellness';
      return c;
    })
    .filter((cat) => validCategoryValues.includes(cat));

  if (categoryStrings.length === 0 || !categoryStrings.includes('news')) {
    categoryStrings = ['news'];
  }
  categoryStrings = [...new Set(['news', ...categoryStrings])];

  let categoryRef: { _type: 'reference'; _ref: string } | null = null;

  try {
    const categoryDocs = await sanityClient.fetch<Array<{ _id: string; slug: { current: string } }>>(
      `*[_type == "category" && slug.current == $slug]{ _id, slug }`,
      { slug: primarySection }
    );

    if (categoryDocs && categoryDocs.length > 0) {
      categoryRef = {
        _type: 'reference' as const,
        _ref: categoryDocs[0]._id,
      };
      console.log(`✅ NewsAPI: category reference for: ${primarySection}`);
    } else {
      console.warn(`⚠️  No Sanity category document for slug "${primarySection}"`);
    }
  } catch (error: unknown) {
    console.error('❌ NewsAPI category fetch error:', error);
  }

  const publishedAt = new Date().toISOString();

  const baseDoc = {
    _type: 'post' as const,
    title: article.title,
    slug: {
      _type: 'slug',
      current: article.slug,
    },
    excerpt: article.excerpt,
    seoTitle: article.seoTitle,
    seoDescription: article.seoDescription,
    visualStyle: article.visualStyle,
    category: categoryRef
      ? {
          _type: 'reference',
          _ref: categoryRef._ref,
        }
      : undefined,
    categories: categoryStrings,
    tags: article.tags,
    body: portableTextBody,
    section: primarySection,
    contentSource: 'newsapi',
    source: 'newsapi',
    originalSourceUrl,
    isActive: true,
    status: 'published',
    publishedAt,
    _id: `post-${article.slug}-${Date.now()}`,
    ...(heroImageAssetId
      ? {
          heroImage: {
            _type: 'image' as const,
            asset: {
              _type: 'reference' as const,
              _ref: heroImageAssetId,
            },
          },
        }
      : {}),
  };

  try {
    const result = await sanityClient.create(baseDoc);
    if (categoryRef) {
      await new Promise((r) => setTimeout(r, 500));
      await sanityClient.patch(result._id).set({ category: categoryRef }).commit();
    }
    return result._id;
  } catch (error: unknown) {
    console.error('❌ NewsAPI Sanity create error:', error);
    throw error;
  }
}

/**
 * URLs already ingested from NewsAPI (dedupe).
 */
export async function getExistingNewsSourceUrls(): Promise<Set<string>> {
  const sanityClient = getSanityClient();
  try {
    const urls = await sanityClient.fetch<string[]>(
      `*[_type == "post" && defined(originalSourceUrl)].originalSourceUrl`
    );
    return new Set((urls || []).filter(Boolean));
  } catch (error) {
    console.error('Error fetching originalSourceUrl list:', error);
    return new Set();
  }
}

/**
 * Gets existing post slugs to check for uniqueness
 */
export async function getExistingSlugs(): Promise<string[]> {
  const sanityClient = getSanityClient();

  try {
    const query = `*[_type == "post"]{ "slug": slug.current }`;
    const results = await sanityClient.fetch(query);
    return results.map((r: { slug: string }) => r.slug);
  } catch (error) {
    console.error('Error fetching existing slugs:', error);
    return [];
  }
}

/**
 * Total number of post documents in the configured dataset (for API status).
 */
export async function countPostDocuments(): Promise<number> {
  const sanityClient = getSanityClient();
  const n = await sanityClient.fetch<number>('count(*[_type == "post"])');
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}


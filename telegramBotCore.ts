import axios from 'axios';
import { Bot } from 'grammy';

import { config } from './config';
import { ingestToTopic } from './agents/ingestAgent';
import { transcribeAudio } from './agents/transcribeAgent';
import { writeArticle, type WriteArticleOptions } from './agents/writerAgent';
import { generateImagePrompt, generateImage } from './agents/imageAgent';
import {
  getExistingSlugs,
  publishArticleToSanity,
  uploadImageBufferToSanity,
  uploadImageToSanity,
} from './agents/sanityPublisher';
import { ensureUniqueSlug } from './utils/slug';
import type { SectionSlug } from './utils/validator';
import { SECTION_SLUGS, VisualStyle } from './utils/validator';
import {
  getTelegramSession,
  hydrateTelegramSessionsFromDisk,
  persistTelegramSessions,
  resetTelegramSession,
  type TelegramDraftSession,
} from './telegramSessionStore';

function isAllowedUser(fromId?: number): boolean {
  if (!fromId) return false;
  return fromId === config.telegram.allowedUserId;
}

async function downloadTelegramFile(bot: Bot, fileId: string): Promise<Buffer> {
  const { buffer } = await downloadTelegramFileWithMeta(bot, fileId);
  return buffer;
}

async function downloadTelegramFileWithMeta(
  bot: Bot,
  fileId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram file path missing');
  }
  const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const base = file.file_path.split('/').pop() || 'file.bin';
  return { buffer: Buffer.from(response.data), filename: base };
}

const PHOTO_ONLY_INGEST_SEED =
  'The editor submitted only a hero photo via Telegram (no text notes). Infer a specific Phoenix-area HappyTimesAZ-style article angle; keep factual claims conservative if the image is ambiguous.';

/**
 * Run bot actions from the HTTP API (daemon). Uses the allowed user's private chat id.
 */
export async function executeTelegramDaemonCommand(
  bot: Bot,
  chatId: number,
  command: '/publish' | '/new' | '/start'
): Promise<void> {
  switch (command) {
    case '/start':
      await bot.api.sendMessage(
        chatId,
        [
          'HappyTimesAZ draft bot — messages are processed on your machine when polling is running.',
          '',
          'Try: /new → send text and/or a voice note and/or a photo → /publish',
          'Full list: /help',
        ].join('\n')
      );
      return;
    case '/new':
      resetTelegramSession(chatId);
      await bot.api.sendMessage(
        chatId,
        'Started a new draft. Send text notes, a voice note, and/or a photo, then /publish.'
      );
      return;
    case '/publish':
      await bot.api.sendMessage(chatId, 'Publishing…');
      try {
        await publishFromSession(bot, chatId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Publish error:', msg);
        await bot.api.sendMessage(chatId, `Publish failed: ${msg || 'Unknown error'}`);
        throw err;
      }
      return;
  }
}

/** Merge new notes into session; keep legacy hero + recent /api/upload asset queue. */
function applyMergePublishNotes(chatId: number, text: string): void {
  const prior = getTelegramSession(chatId);
  const preserveHero = prior.heroSanityAssetId;
  const preserveRecent =
    prior.recentUploadAssetIds && prior.recentUploadAssetIds.length > 0
      ? [...prior.recentUploadAssetIds].slice(0, 5)
      : undefined;
  const priorNotes = prior.notes.slice();
  resetTelegramSession(chatId);
  const session = getTelegramSession(chatId);
  if (preserveHero) {
    session.heroSanityAssetId = preserveHero;
  }
  if (preserveRecent && preserveRecent.length > 0) {
    session.recentUploadAssetIds = preserveRecent;
  }
  session.notes =
    priorNotes.length > 0 ? [...priorNotes, text] : [text];
  persistTelegramSessions();
}

/**
 * API/dashboard: treat `sourceNotes` as the full story source (like pasted Telegram text),
 * then run the same ingest → article → Sanity path as /publish in the bot.
 * Non-empty `imageAssetIds` replaces the draft and sets body images only (first = hero).
 * Otherwise merges notes and preserves `recentUploadAssetIds` from POST /api/upload.
 */
export async function publishStoryFromSourceNotes(
  bot: Bot,
  chatId: number,
  sourceNotes: string,
  options?: { imageAssetIds?: string[] }
): Promise<void> {
  const text = sourceNotes.trim();
  if (!text) {
    const prior = getTelegramSession(chatId);
    const ids = options?.imageAssetIds?.filter(
      (id) => typeof id === 'string' && id.trim().length > 0
    );
    const hasBodyImages = ids !== undefined && ids.length > 0;
    const hasSessionMaterial =
      hasBodyImages ||
      (prior.notes?.some((n) => typeof n === 'string' && n.trim().length > 0) ??
        false) ||
      (prior.recentUploadAssetIds && prior.recentUploadAssetIds.length > 0) ||
      !!prior.heroSanityAssetId ||
      (prior.pendingImageAssetIds && prior.pendingImageAssetIds.length > 0);
    if (!hasSessionMaterial) {
      throw new Error('Story source notes are empty');
    }
  }

  if (options && options.imageAssetIds !== undefined) {
    const ids = options.imageAssetIds
      .filter((id) => typeof id === 'string' && id.trim().length > 0)
      .slice(0, 5);
    if (ids.length > 0) {
      resetTelegramSession(chatId);
      const session = getTelegramSession(chatId);
      session.notes = [text];
      session.pendingImageAssetIds = ids;
      persistTelegramSessions();
    } else {
      applyMergePublishNotes(chatId, text);
    }
  } else {
    applyMergePublishNotes(chatId, text);
  }

  await bot.api.sendMessage(chatId, 'Publishing…');
  try {
    await publishFromSession(bot, chatId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Publish error:', msg);
    await bot.api.sendMessage(chatId, `Publish failed: ${msg || 'Unknown error'}`);
    throw err;
  }
}

async function publishFromSession(bot: Bot, chatId: number): Promise<void> {
  const session = getTelegramSession(chatId);
  let notes = session.notes.join('\n').trim();
  const hasPhoto = Boolean(
    session.photoFileId ||
      session.heroSanityAssetId ||
      (session.recentUploadAssetIds && session.recentUploadAssetIds.length > 0)
  );

  if (!notes && !session.title) {
    if (hasPhoto) {
      notes = PHOTO_ONLY_INGEST_SEED;
    } else {
      await bot.api.sendMessage(
        chatId,
        'Send some notes, a voice note, and/or a photo first, then /publish.'
      );
      return;
    }
  }

  const notesForIngest = notes || session.title || '';

  const topic = await ingestToTopic({
    section: session.section,
    title: session.title,
    keywords: session.keywords,
    notes: notesForIngest,
  });

  /** Any path where the hero is not DALL·E (dashboard uploads, /api/upload hero, Telegram photo). */
  const userSuppliedImages =
    Boolean(session.pendingImageAssetIds && session.pendingImageAssetIds.length > 0) ||
    Boolean(session.heroSanityAssetId) ||
    Boolean(session.photoFileId);

  const writeOpts: WriteArticleOptions = {
    sourceNotes: notesForIngest.trim() ? notesForIngest : undefined,
    userSuppliedImages,
  };

  let article = await writeArticle(topic, writeOpts);

  if (session.visualStyle) {
    article = { ...article, visualStyle: session.visualStyle };
  }

  const existingSlugs = await getExistingSlugs();
  article = { ...article, slug: ensureUniqueSlug(article.slug, existingSlugs) };

  let heroImageAssetId: string;
  let additionalImageAssetIds: string[] | undefined;

  const pending = session.pendingImageAssetIds;
  const recent = session.recentUploadAssetIds;
  if (pending && pending.length > 0) {
    console.log(
      '[publish] Publish body images: first = hero, rest = additionalImages — skipping DALL·E entirely'
    );
    heroImageAssetId = pending[0]!;
    const rest = pending.slice(1);
    additionalImageAssetIds = rest.length > 0 ? rest : undefined;
  } else if (recent && recent.length > 0) {
    console.log(
      `[publish] Using ${recent.length} session image(s) from POST /api/upload (same session key) — skipping DALL·E`
    );
    heroImageAssetId = recent[0]!;
    const rest = recent.slice(1);
    additionalImageAssetIds = rest.length > 0 ? rest : undefined;
  } else if (session.heroSanityAssetId) {
    console.log(
      '[publish] Using single pre-uploaded hero (e.g. POST /api/upload) — skipping DALL·E'
    );
    heroImageAssetId = session.heroSanityAssetId;
  } else if (session.photoFileId) {
    const buf = await downloadTelegramFile(bot, session.photoFileId);
    heroImageAssetId = await uploadImageBufferToSanity(buf, `${article.slug}-hero.jpg`);
  } else {
    console.log('[publish] No user images — generating hero via DALL·E from article prompt');
    const enhancedPrompt = await generateImagePrompt(
      article.heroImagePrompt,
      article.visualStyle
    );
    const imageUrl = await generateImage(enhancedPrompt);
    heroImageAssetId = await uploadImageToSanity(imageUrl, `${article.slug}-hero.jpg`);
  }

  const sanityId = await publishArticleToSanity(
    article,
    heroImageAssetId,
    topic.section,
    additionalImageAssetIds
  );

  await bot.api.sendMessage(
    chatId,
    `Published draft:\n- Title: ${article.title}\n- Slug: ${article.slug}\n- Sanity ID: ${sanityId}`
  );

  resetTelegramSession(chatId);
}

let telegramSessionsHydrated = false;

export function registerTelegramHandlers(bot: Bot): void {
  if (!telegramSessionsHydrated) {
    hydrateTelegramSessionsFromDisk();
    telegramSessionsHydrated = true;
  }

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!isAllowedUser(fromId)) return;
    await next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        'HappyTimesAZ draft bot — messages are processed on your machine when polling is running.',
        '',
        'Try: /new → send text and/or a voice note and/or a photo → /publish',
        'Full list: /help',
      ].join('\n')
    );
  });

  bot.command('new', async (ctx) => {
    resetTelegramSession(ctx.chat!.id);
    await ctx.reply(
      'Started a new draft. Send text notes, a voice note, and/or a photo, then /publish.'
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Commands:',
        '- /new — start a new draft session',
        '- /section <cannabis|health-wellness|nightlife|food|events|global|news>',
        '- /title <title>',
        '- /keywords k1, k2, k3',
        '- /style <visualStyle>',
        '- (send a photo) — use as hero image (skips DALL·E)',
        '- (send a voice note) — transcribed with Whisper, added to notes',
        '- (send text) — add to article notes',
        '- /publish — generate + publish draft immediately',
      ].join('\n')
    );
  });

  bot.command('section', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    const raw = ctx.match?.toString().trim().toLowerCase() || '';
    const migrated =
      raw === 'mushrooms' || raw === 'wellness' ? 'health-wellness' : raw;
    if ((SECTION_SLUGS as readonly string[]).includes(migrated)) {
      session.section = migrated as SectionSlug;
      persistTelegramSessions();
      await ctx.reply(`Section set to: ${session.section}`);
      return;
    }
    await ctx.reply(
      'Invalid section. Use: cannabis, health-wellness, nightlife, food, events, global, news (mushrooms → health-wellness).'
    );
  });

  bot.command('title', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    session.title = ctx.match?.toString().trim() || '';
    persistTelegramSessions();
    await ctx.reply('Title set.');
  });

  bot.command('keywords', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    const raw = ctx.match?.toString().trim() || '';
    const keywords = raw
      .split(',')
      .map((k: string) => k.trim())
      .filter(Boolean);
    session.keywords = keywords;
    persistTelegramSessions();
    await ctx.reply(`Keywords set (${keywords.length}).`);
  });

  bot.command('style', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    const style = (ctx.match?.toString().trim() || '') as VisualStyle;
    const allowed: VisualStyle[] = [
      'editorial_realistic',
      'cinematic_hyperreal',
      'film_35mm_grain',
      'documentary_candid',
      'neon_night_street',
      'illustrated_watercolor',
      'bold_vector_flat',
      'playful_cartoon',
      'clay_3d',
    ];
    if (allowed.includes(style)) {
      session.visualStyle = style;
      persistTelegramSessions();
      await ctx.reply(`Visual style set to: ${style}`);
    } else {
      await ctx.reply(`Invalid style. Use one of: ${allowed.join(', ')}`);
    }
  });

  bot.command('publish', async (ctx) => {
    const chatId = ctx.chat!.id;
    try {
      await ctx.reply('Publishing…');
      await publishFromSession(bot, chatId);
    } catch (err: any) {
      console.error('Publish error:', err?.message || err);
      await ctx.reply(`Publish failed: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    const voice = ctx.message.voice;
    if (!voice) return;

    const caption = ctx.message.caption?.trim();
    if (caption) {
      session.notes.push(`[photo/voice caption] ${caption}`);
    }

    try {
      await ctx.reply('Transcribing voice note…');
      const { buffer, filename } = await downloadTelegramFileWithMeta(bot, voice.file_id);
      const text = await transcribeAudio(buffer, filename);
      if (!text) {
        persistTelegramSessions();
        await ctx.reply('Transcription was empty. Try again or send text.');
        return;
      }
      session.notes.push(text);
      persistTelegramSessions();
      const preview = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      await ctx.reply(`Added to notes:\n\n${preview}`);
    } catch (err: any) {
      console.error('Voice transcribe error:', err?.message || err);
      persistTelegramSessions();
      await ctx.reply(`Transcription failed: ${err?.message || 'Unknown error'}`);
    }
  });

  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;
    const best = photos[photos.length - 1];
    session.photoFileId = best.file_id;
    const caption = ctx.message.caption?.trim();
    if (caption) {
      session.notes.push(caption);
    }
    persistTelegramSessions();
    await ctx.reply(
      caption
        ? 'Photo and caption saved. Send more notes or /publish.'
        : 'Photo received. Send notes or /publish.'
    );
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text?.trim();
    if (!text) return;
    if (text.startsWith('/')) return;
    const chatId = ctx.chat!.id;
    const session = getTelegramSession(chatId);
    session.notes.push(text);
    persistTelegramSessions();
  });

  bot.on('message:document', async (ctx) => {
    await ctx.reply(
      'Files/documents are not read yet. Paste the article as text, send a voice note, or send a photo for the hero image. /help'
    );
  });

  bot.on('message').filter((ctx) => {
    const m = ctx.message;
    return (
      !('text' in m && m.text) &&
      !m.photo &&
      !m.voice &&
      !m.document &&
      !m.sticker &&
      !m.contact &&
      !m.location &&
      !m.poll
    );
  }, async (ctx) => {
    await ctx.reply(
      'That type of message is not handled. Use text, a voice note, or a photo. If you get no replies at all, start polling: npm run telegram:polling:dev'
    );
  });
}


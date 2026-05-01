"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeTelegramDaemonCommand = executeTelegramDaemonCommand;
exports.publishStoryFromSourceNotes = publishStoryFromSourceNotes;
exports.registerTelegramHandlers = registerTelegramHandlers;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
const ingestAgent_1 = require("./agents/ingestAgent");
const transcribeAgent_1 = require("./agents/transcribeAgent");
const writerAgent_1 = require("./agents/writerAgent");
const imageAgent_1 = require("./agents/imageAgent");
const sanityPublisher_1 = require("./agents/sanityPublisher");
const slug_1 = require("./utils/slug");
const validator_1 = require("./utils/validator");
const articleStyle_1 = require("./utils/articleStyle");
const telegramSessionStore_1 = require("./telegramSessionStore");
function isAllowedUser(fromId) {
    if (!fromId)
        return false;
    return fromId === config_1.config.telegram.allowedUserId;
}
async function downloadTelegramFile(bot, fileId) {
    const { buffer } = await downloadTelegramFileWithMeta(bot, fileId);
    return buffer;
}
async function downloadTelegramFileWithMeta(bot, fileId) {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
        throw new Error('Telegram file path missing');
    }
    const url = `https://api.telegram.org/file/bot${config_1.config.telegram.botToken}/${file.file_path}`;
    const response = await axios_1.default.get(url, { responseType: 'arraybuffer' });
    const base = file.file_path.split('/').pop() || 'file.bin';
    return { buffer: Buffer.from(response.data), filename: base };
}
const PHOTO_ONLY_INGEST_SEED = 'The editor submitted only a hero photo via Telegram (no text notes). Infer a specific Phoenix-area HappyTimesAZ-style article angle; keep factual claims conservative if the image is ambiguous.';
const VIDEO_ONLY_INGEST_SEED = 'The editor submitted only a featured video via the dashboard (no text notes). Infer a specific Phoenix-area HappyTimesAZ-style article angle; keep factual claims conservative; the post will attach the uploaded video in Sanity.';
/**
 * Run bot actions from the HTTP API (daemon). Uses the allowed user's private chat id.
 */
async function executeTelegramDaemonCommand(bot, chatId, command) {
    switch (command) {
        case '/start':
            await bot.api.sendMessage(chatId, [
                'HappyTimesAZ draft bot — messages are processed on your machine when polling is running.',
                '',
                'Try: /new → send text and/or a voice note and/or a photo → /publish',
                'Full list: /help',
            ].join('\n'));
            return;
        case '/new':
            (0, telegramSessionStore_1.resetTelegramSession)(chatId);
            await bot.api.sendMessage(chatId, 'Started a new draft. Send text notes, a voice note, and/or a photo, then /publish.');
            return;
        case '/publish':
            try {
                await publishFromSession(bot, chatId, { source: 'dashboard' });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('Publish error:', msg);
                throw err;
            }
            return;
    }
}
/** Merge new notes into session; keep legacy hero + recent /api/upload asset queue. */
function applyMergePublishNotes(chatId, text) {
    const prior = (0, telegramSessionStore_1.getTelegramSession)(chatId);
    const preserveHero = prior.heroSanityAssetId;
    const preserveRecent = prior.recentUploadAssetIds && prior.recentUploadAssetIds.length > 0
        ? [...prior.recentUploadAssetIds].slice(0, 5)
        : undefined;
    const preserveVideo = prior.draftVideoAssetId;
    const priorNotes = prior.notes.slice();
    (0, telegramSessionStore_1.resetTelegramSession)(chatId);
    const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
    if (preserveHero) {
        session.heroSanityAssetId = preserveHero;
    }
    if (preserveRecent && preserveRecent.length > 0) {
        session.recentUploadAssetIds = preserveRecent;
    }
    if (preserveVideo) {
        session.draftVideoAssetId = preserveVideo;
    }
    session.notes =
        priorNotes.length > 0 ? [...priorNotes, text] : [text];
    (0, telegramSessionStore_1.persistTelegramSessions)();
}
/**
 * API/dashboard: treat `sourceNotes` as the full story source (like pasted Telegram text),
 * then run the same ingest → article → Sanity path as /publish in the bot.
 * Non-empty `imageAssetIds` replaces the draft and sets body images only (first = hero).
 * Otherwise merges notes and preserves `recentUploadAssetIds` from POST /api/upload.
 */
async function publishStoryFromSourceNotes(bot, chatId, sourceNotes, options) {
    const text = sourceNotes.trim();
    if (!text) {
        const prior = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const ids = options?.imageAssetIds?.filter((id) => typeof id === 'string' && id.trim().length > 0);
        const hasBodyImages = ids !== undefined && ids.length > 0;
        const hasSessionMaterial = hasBodyImages ||
            (prior.notes?.some((n) => typeof n === 'string' && n.trim().length > 0) ??
                false) ||
            (prior.recentUploadAssetIds && prior.recentUploadAssetIds.length > 0) ||
            !!prior.heroSanityAssetId ||
            (prior.pendingImageAssetIds && prior.pendingImageAssetIds.length > 0) ||
            !!prior.draftVideoAssetId;
        if (!hasSessionMaterial) {
            throw new Error('Story source notes are empty');
        }
    }
    if (options && options.imageAssetIds !== undefined) {
        const ids = options.imageAssetIds
            .filter((id) => typeof id === 'string' && id.trim().length > 0)
            .slice(0, 5);
        if (ids.length > 0) {
            const priorSnap = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            const preserveVideo = priorSnap.draftVideoAssetId;
            (0, telegramSessionStore_1.resetTelegramSession)(chatId);
            const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            session.notes = [text];
            session.pendingImageAssetIds = ids;
            if (preserveVideo) {
                session.draftVideoAssetId = preserveVideo;
            }
            (0, telegramSessionStore_1.persistTelegramSessions)();
        }
        else {
            applyMergePublishNotes(chatId, text);
        }
    }
    else {
        applyMergePublishNotes(chatId, text);
    }
    const applyStyle = options?.applyDashboardArticleStyle === true;
    const articleLength = options?.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
    const articleTone = options?.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
    const trimmedAuthor = typeof options?.authorName === 'string' ? options.authorName.trim() : '';
    try {
        await publishFromSession(bot, chatId, {
            source: 'dashboard',
            applyDashboardArticleStyle: applyStyle,
            ...(applyStyle ? { articleLength, articleTone } : {}),
            ...(trimmedAuthor ? { authorName: trimmedAuthor } : {}),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Publish error:', msg);
        throw err;
    }
}
async function publishFromSession(bot, chatId, options) {
    const source = options?.source ?? 'telegram';
    const notifyTelegram = source === 'telegram';
    const applyStyle = options?.applyDashboardArticleStyle === true;
    const articleLength = options?.articleLength ?? articleStyle_1.DEFAULT_ARTICLE_LENGTH;
    const articleTone = options?.articleTone ?? articleStyle_1.DEFAULT_ARTICLE_TONE;
    const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
    let notes = session.notes.join('\n').trim();
    const hasHeroImageSource = Boolean(session.photoFileId ||
        session.heroSanityAssetId ||
        (session.recentUploadAssetIds && session.recentUploadAssetIds.length > 0));
    const hasDraftVideoOnly = Boolean(session.draftVideoAssetId) && !hasHeroImageSource;
    if (!notes && !session.title) {
        if (hasHeroImageSource) {
            notes = PHOTO_ONLY_INGEST_SEED;
        }
        else if (hasDraftVideoOnly) {
            notes = VIDEO_ONLY_INGEST_SEED;
        }
        else {
            const hint = 'Send some notes, a voice note, and/or a photo first, then /publish.';
            if (notifyTelegram) {
                await bot.api.sendMessage(chatId, hint);
                return;
            }
            throw new Error(hint);
        }
    }
    const notesForIngest = notes || session.title || '';
    const topic = await (0, ingestAgent_1.ingestToTopic)({
        section: session.section,
        title: session.title,
        keywords: session.keywords,
        notes: notesForIngest,
        applyDashboardArticleStyle: applyStyle,
        ...(applyStyle ? { articleLength, articleTone } : {}),
    });
    /** Any path where the hero is not DALL·E (dashboard uploads, /api/upload hero, Telegram photo). */
    const userSuppliedImages = Boolean(session.pendingImageAssetIds && session.pendingImageAssetIds.length > 0) ||
        Boolean(session.heroSanityAssetId) ||
        Boolean(session.photoFileId);
    const writeOpts = {
        sourceNotes: notesForIngest.trim() ? notesForIngest : undefined,
        userSuppliedImages,
        applyDashboardArticleStyle: applyStyle,
        ...(applyStyle ? { articleLength, articleTone } : {}),
    };
    let article = await (0, writerAgent_1.writeArticle)(topic, writeOpts);
    if (session.visualStyle) {
        article = { ...article, visualStyle: session.visualStyle };
    }
    const existingSlugs = await (0, sanityPublisher_1.getExistingSlugs)();
    article = { ...article, slug: (0, slug_1.ensureUniqueSlug)(article.slug, existingSlugs) };
    let heroImageAssetId;
    let additionalImageAssetIds;
    /** Session file asset from POST /api/upload-video — same publish path as hero/additional images. */
    const featuredVideoAssetId = typeof session.draftVideoAssetId === 'string'
        ? session.draftVideoAssetId.trim() || undefined
        : undefined;
    const pending = session.pendingImageAssetIds;
    const recent = session.recentUploadAssetIds;
    if (pending && pending.length > 0) {
        console.log('[publish] Publish body images: first = hero, rest = additionalImages — skipping DALL·E entirely');
        heroImageAssetId = pending[0];
        const rest = pending.slice(1);
        additionalImageAssetIds = rest.length > 0 ? rest : undefined;
    }
    else if (recent && recent.length > 0) {
        console.log(`[publish] Using ${recent.length} session image(s) from POST /api/upload (same session key) — skipping DALL·E`);
        heroImageAssetId = recent[0];
        const rest = recent.slice(1);
        additionalImageAssetIds = rest.length > 0 ? rest : undefined;
    }
    else if (session.heroSanityAssetId) {
        console.log('[publish] Using single pre-uploaded hero (e.g. POST /api/upload) — skipping DALL·E');
        heroImageAssetId = session.heroSanityAssetId;
    }
    else if (session.photoFileId) {
        const buf = await downloadTelegramFile(bot, session.photoFileId);
        heroImageAssetId = await (0, sanityPublisher_1.uploadImageBufferToSanity)(buf, `${article.slug}-hero.jpg`);
    }
    else {
        console.log('[publish] No user images — generating hero via DALL·E from article prompt');
        const enhancedPrompt = await (0, imageAgent_1.generateImagePrompt)(article.heroImagePrompt, article.visualStyle);
        const imageUrl = await (0, imageAgent_1.generateImage)(enhancedPrompt);
        if (imageUrl) {
            heroImageAssetId = await (0, sanityPublisher_1.uploadImageToSanity)(imageUrl, `${article.slug}-hero.jpg`);
        }
        else {
            console.warn('[publish] DALL·E image generation failed; continuing without hero image');
        }
    }
    if (featuredVideoAssetId) {
        console.log(`[publish] Including session featured video (Sanity file asset): ${featuredVideoAssetId}`);
    }
    const publishOpts = {};
    if (featuredVideoAssetId) {
        publishOpts.videoAssetId = featuredVideoAssetId;
    }
    const dashAuthor = typeof options?.authorName === 'string' ? options.authorName.trim() : '';
    if (dashAuthor) {
        publishOpts.authorName = dashAuthor;
    }
    const sanityId = await (0, sanityPublisher_1.publishArticleToSanity)(article, heroImageAssetId, topic.section, additionalImageAssetIds, Object.keys(publishOpts).length > 0 ? publishOpts : undefined);
    if (notifyTelegram) {
        await bot.api.sendMessage(chatId, `Published draft:\n- Title: ${article.title}\n- Slug: ${article.slug}\n- Sanity ID: ${sanityId}`);
    }
    (0, telegramSessionStore_1.resetTelegramSession)(chatId);
}
let telegramSessionsHydrated = false;
function registerTelegramHandlers(bot) {
    if (!telegramSessionsHydrated) {
        (0, telegramSessionStore_1.hydrateTelegramSessionsFromDisk)();
        telegramSessionsHydrated = true;
    }
    /** Long polling only (webhook uses HTTP wrapper). Log and swallow so polling does not crash. */
    bot.catch((err) => {
        const updateId = err.ctx?.update?.update_id;
        const cause = err.error;
        const message = cause instanceof Error ? cause.message : String(cause);
        const stack = cause instanceof Error ? cause.stack : undefined;
        console.error(`[telegram] middleware error (update_id=${updateId ?? 'unknown'}):`, message, stack ?? '');
    });
    bot.use(async (ctx, next) => {
        const fromId = ctx.from?.id;
        if (!isAllowedUser(fromId))
            return;
        await next();
    });
    bot.command('start', async (ctx) => {
        await ctx.reply([
            'HappyTimesAZ draft bot — messages are processed on your machine when polling is running.',
            '',
            'Try: /new → send text and/or a voice note and/or a photo → /publish',
            'Full list: /help',
        ].join('\n'));
    });
    bot.command('new', async (ctx) => {
        (0, telegramSessionStore_1.resetTelegramSession)(ctx.chat.id);
        await ctx.reply('Started a new draft. Send text notes, a voice note, and/or a photo, then /publish.');
    });
    bot.command('help', async (ctx) => {
        await ctx.reply([
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
        ].join('\n'));
    });
    bot.command('section', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const raw = ctx.match?.toString().trim().toLowerCase() || '';
        const migrated = raw === 'mushrooms' || raw === 'wellness' ? 'health-wellness' : raw;
        if (validator_1.SECTION_SLUGS.includes(migrated)) {
            session.section = migrated;
            (0, telegramSessionStore_1.persistTelegramSessions)();
            await ctx.reply(`Section set to: ${session.section}`);
            return;
        }
        await ctx.reply('Invalid section. Use: cannabis, health-wellness, nightlife, food, events, global, news (mushrooms → health-wellness).');
    });
    bot.command('title', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        session.title = ctx.match?.toString().trim() || '';
        (0, telegramSessionStore_1.persistTelegramSessions)();
        await ctx.reply('Title set.');
    });
    bot.command('keywords', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const raw = ctx.match?.toString().trim() || '';
        const keywords = raw
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
        session.keywords = keywords;
        (0, telegramSessionStore_1.persistTelegramSessions)();
        await ctx.reply(`Keywords set (${keywords.length}).`);
    });
    bot.command('style', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const style = (ctx.match?.toString().trim() || '');
        const allowed = [
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
            (0, telegramSessionStore_1.persistTelegramSessions)();
            await ctx.reply(`Visual style set to: ${style}`);
        }
        else {
            await ctx.reply(`Invalid style. Use one of: ${allowed.join(', ')}`);
        }
    });
    bot.command('publish', async (ctx) => {
        const chatId = ctx.chat.id;
        try {
            await ctx.reply('Publishing…');
            await publishFromSession(bot, chatId, { source: 'telegram' });
        }
        catch (err) {
            console.error('Publish error:', err?.message || err);
            await ctx.reply(`Publish failed: ${err?.message || 'Unknown error'}`);
        }
    });
    bot.on('message:voice', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const voice = ctx.message.voice;
        if (!voice)
            return;
        const caption = ctx.message.caption?.trim();
        if (caption) {
            session.notes.push(`[photo/voice caption] ${caption}`);
        }
        try {
            await ctx.reply('Transcribing voice note…');
            const { buffer, filename } = await downloadTelegramFileWithMeta(bot, voice.file_id);
            const text = await (0, transcribeAgent_1.transcribeAudio)(buffer, filename);
            if (!text) {
                (0, telegramSessionStore_1.persistTelegramSessions)();
                await ctx.reply('Transcription was empty. Try again or send text.');
                return;
            }
            session.notes.push(text);
            (0, telegramSessionStore_1.persistTelegramSessions)();
            const preview = text.length > 600 ? `${text.slice(0, 600)}…` : text;
            await ctx.reply(`Added to notes:\n\n${preview}`);
        }
        catch (err) {
            console.error('Voice transcribe error:', err?.message || err);
            (0, telegramSessionStore_1.persistTelegramSessions)();
            await ctx.reply(`Transcription failed: ${err?.message || 'Unknown error'}`);
        }
    });
    bot.on('message:photo', async (ctx) => {
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        const photos = ctx.message.photo;
        if (!photos || photos.length === 0)
            return;
        const best = photos[photos.length - 1];
        session.photoFileId = best.file_id;
        const caption = ctx.message.caption?.trim();
        if (caption) {
            session.notes.push(caption);
        }
        (0, telegramSessionStore_1.persistTelegramSessions)();
        await ctx.reply(caption
            ? 'Photo and caption saved. Send more notes or /publish.'
            : 'Photo received. Send notes or /publish.');
    });
    bot.on('message:text', async (ctx) => {
        const text = ctx.message.text?.trim();
        if (!text)
            return;
        if (text.startsWith('/'))
            return;
        const chatId = ctx.chat.id;
        const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
        session.notes.push(text);
        (0, telegramSessionStore_1.persistTelegramSessions)();
    });
    bot.on('message:document', async (ctx) => {
        await ctx.reply('Files/documents are not read yet. Paste the article as text, send a voice note, or send a photo for the hero image. /help');
    });
    bot.on('message').filter((ctx) => {
        const m = ctx.message;
        return (!('text' in m && m.text) &&
            !m.photo &&
            !m.voice &&
            !m.document &&
            !m.sticker &&
            !m.contact &&
            !m.location &&
            !m.poll);
    }, async (ctx) => {
        await ctx.reply('That type of message is not handled. Use text, a voice note, or a photo. If you get no replies at all, start polling: npm run telegram:polling:dev');
    });
}
//# sourceMappingURL=telegramBotCore.js.map
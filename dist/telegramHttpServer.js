"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTelegramWebhookExpress = startTelegramWebhookExpress;
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const grammy_1 = require("grammy");
const config_1 = require("./config");
const newsApiSync_1 = require("./agents/newsApiSync");
const serpApiEventsSync_1 = require("./agents/serpApiEventsSync");
const syncDispensaries_1 = require("./agents/syncDispensaries");
const transcribeAgent_1 = require("./agents/transcribeAgent");
const sanityPublisher_1 = require("./agents/sanityPublisher");
const pipelineStatus_1 = require("./pipelineStatus");
const fetchRestaurants_1 = require("./scripts/fetchRestaurants");
const pipelineRunner_1 = require("./pipelineRunner");
const telegramBotCore_1 = require("./telegramBotCore");
const telegramSessionStore_1 = require("./telegramSessionStore");
const articleStyle_1 = require("./utils/articleStyle");
const researchAndWritePipeline_1 = require("./agents/researchAndWritePipeline");
const RENDER_HOST = '0.0.0.0';
const multerUploadImage = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});
/** Up to 5 images for POST /api/command multipart /publish (field name: images). */
const multerCommandImages = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});
/** Whisper API accepts up to 25 MB per file. */
const multerUploadAudio = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});
/** Dashboard video — Sanity file assets; cap to avoid OOM on small dynos. */
const multerUploadVideo = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 },
});
/** Coerce API body fields into one trimmed notes string for /publish. */
function coerceToNotesString(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'string') {
        const t = value.trim();
        return t.length > 0 ? t : undefined;
    }
    if (Array.isArray(value)) {
        const joined = value
            .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
            .filter((s) => s.length > 0)
            .join('\n');
        return joined.length > 0 ? joined : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return undefined;
}
/**
 * Read editorial / story source from POST /api/command body (JSON or multipart text fields).
 * First non-empty wins (dashboards vary field names).
 */
function extractPublishNotesFromBody(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const o = body;
    const keys = [
        'notes',
        'editorialNotes',
        'editorNotes',
        'topicNotes',
        'story',
        'body',
        'content',
        'text',
        'sourceNotes',
        'article',
        'draft',
    ];
    for (const k of keys) {
        const s = coerceToNotesString(o[k]);
        if (s)
            return s;
    }
    return undefined;
}
/**
 * JSON body: optional `uploadedImages` or `imageAssetIds` (max 5 Sanity asset _ids). First id = hero.
 */
function extractImagePublishOptionsFromBody(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const o = body;
    let raw;
    if ('uploadedImages' in o) {
        raw = o.uploadedImages;
    }
    else if ('imageAssetIds' in o) {
        raw = o.imageAssetIds;
    }
    else {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        return { imageAssetIds: [] };
    }
    const imageAssetIds = raw
        .filter((x) => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
        .slice(0, 5);
    return { imageAssetIds };
}
/** Dashboard /publish: optional byline for the Sanity post `author` field. */
function extractAuthorNameFromBody(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const v = body.authorName;
    if (typeof v !== 'string')
        return undefined;
    const t = v.trim();
    if (!t)
        return undefined;
    return t.slice(0, 200);
}
/** Dig & Write: Unsplash hero on researchAndWrite; `mode`, `digAndWrite`, or `writeMode`. */
function extractDigAndWriteMode(body) {
    if (!body || typeof body !== 'object')
        return false;
    const o = body;
    if (o.digAndWrite === true || o.digWrite === true)
        return true;
    const mode = o.mode;
    if (typeof mode === 'string') {
        const m = mode.trim().toLowerCase().replace(/\s+/g, '-');
        if (m === 'dig-and-write' || m === 'digwrite' || m === 'dig_write')
            return true;
    }
    const wm = o.writeMode;
    if (typeof wm === 'string' && /\bdig\b/i.test(wm) && /\bwrite\b/i.test(wm))
        return true;
    return false;
}
/** Optional OpenAI fact-check (⚠️) on `POST /api/command/researchAndWrite`; default off. */
function extractRunFactCheckFromBody(body) {
    if (!body || typeof body !== 'object')
        return false;
    const o = body;
    if (o.runFactCheck === true || o.factCheck === true)
        return true;
    return false;
}
/** Comma-separated origins (e.g. https://your-app.vercel.app). Empty = allow any origin (*). */
function getCorsAllowlist() {
    const raw = process.env.CORS_ORIGINS?.trim();
    if (!raw)
        return [];
    return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function corsMiddleware(req, res, next) {
    const allowlist = getCorsAllowlist();
    const origin = req.header('Origin');
    if (allowlist.length === 0) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    else if (origin && allowlist.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    else if (origin) {
        // Browser sent Origin but it is not in CORS_ORIGINS — omit ACAO so the browser blocks.
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Session-Chat-Id, X-Requester-Id, X-Client-Source');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
}
function getConfiguredApiKey() {
    return process.env.API_KEY?.trim() || '';
}
function requireApiKey(req, res, next) {
    const configured = getConfiguredApiKey();
    if (!configured) {
        res.status(503).json({ error: 'API_KEY is not configured on the server' });
        return;
    }
    const headerKey = req.header('x-api-key')?.trim();
    const auth = req.header('authorization');
    const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    const key = headerKey || bearer;
    if (key !== configured) {
        res.status(401).json({ error: 'Invalid or missing API key' });
        return;
    }
    next();
}
/**
 * Session bucket for draft + recent uploads. Default: TELEGRAM_ALLOWED_USER_ID.
 * Optional: `X-Session-Chat-Id` or `X-Requester-Id` (numeric string, e.g. Telegram user id).
 */
function resolveSessionChatId(req) {
    const raw = req.header('x-session-chat-id')?.trim() ?? req.header('x-requester-id')?.trim();
    if (raw && /^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (Number.isSafeInteger(n))
            return n;
    }
    return config_1.config.telegram.allowedUserId;
}
/** Set by dashboard (`X-Client-Source: dashboard`); echoed in JSON and used for publishMode labels. */
function resolveApiClientSource(req) {
    const raw = req.header('x-client-source')?.trim().toLowerCase();
    return raw === 'dashboard' ? 'dashboard' : 'unknown';
}
/**
 * Length/tone/spin GPT instructions apply only when the request identifies as dashboard:
 * `X-Client-Source: dashboard` or JSON/multipart field `source: "dashboard"`.
 */
function requestIsDashboardSource(req) {
    if (resolveApiClientSource(req) === 'dashboard')
        return true;
    const b = req.body;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
        const s = b.source;
        if (typeof s === 'string' && s.trim().toLowerCase() === 'dashboard')
            return true;
    }
    return false;
}
function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function registerDaemonApiRoutes(app, bot) {
    app.use(corsMiddleware);
    /**
     * Dashboard: research (OpenAI web search via Responses API) + single-article writer in parallel where possible,
     * stream merged `sources` as SSE, optional fact-check (`runFactCheck` or `factCheck: true`) then Sources section; final payload on `article` event.
     * Body: same steering as autonomous `/publish` — `notes` (or aliases), optional `length`/`tone`, optional `authorName`,
     * dashboard via `X-Client-Source: dashboard` and/or `source: "dashboard"`.
     * Dig & Write: set `mode: "dig-and-write"` or `digAndWrite: true` to use Unsplash hero (`UNSPLASH_ACCESS_KEY`); otherwise DALL·E hero (same image stack as orchestrator, only on this route).
     */
    app.post('/api/command/researchAndWrite', requireApiKey, async (req, res) => {
        const notesRaw = extractPublishNotesFromBody(req.body);
        const notes = notesRaw?.trim() ?? '';
        if (!notes) {
            res.status(400).json({
                error: 'Missing notes: provide `notes` or story/body/content/… (same field names as the publish / runWriter payload).',
            });
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const dashboardStyle = requestIsDashboardSource(req);
        const articleStyle = (0, articleStyle_1.extractArticleStyleFromBody)(req.body);
        const authorName = extractAuthorNameFromBody(req.body);
        const digAndWrite = extractDigAndWriteMode(req.body);
        const runFactCheck = extractRunFactCheckFromBody(req.body);
        try {
            const { article, sources, heroImageAssetId, heroImageSource, sanityDocumentId, } = await (0, researchAndWritePipeline_1.runResearchAndWrite)({
                notes,
                applyDashboardArticleStyle: dashboardStyle,
                ...(dashboardStyle
                    ? { articleLength: articleStyle.articleLength, articleTone: articleStyle.articleTone }
                    : {}),
                ...(authorName ? { authorName } : {}),
                digAndWrite,
                runFactCheck,
                onSourceProgress: ({ sources: src }) => {
                    writeSse(res, 'sources', { sources: src });
                },
            });
            writeSse(res, 'article', {
                ok: true,
                source: resolveApiClientSource(req),
                article,
                sources,
                heroImageAssetId,
                heroImageSource,
                sanityDocumentId,
            });
            writeSse(res, 'done', { ok: true });
            res.end();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/command/researchAndWrite failed:', msg);
            if (err instanceof Error && err.stack) {
                console.error('[api] /api/command/researchAndWrite stack:\n', err.stack);
            }
            writeSse(res, 'error', { ok: false, message: msg });
            writeSse(res, 'done', { ok: false });
            res.end();
        }
    });
    app.post('/api/upload', requireApiKey, (req, res, next) => {
        multerUploadImage.single('image')(req, res, (err) => {
            if (err) {
                const msg = err instanceof Error ? err.message : String(err);
                res.status(400).json({ error: msg });
                return;
            }
            next();
        });
    }, async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer) {
                res.status(400).json({
                    error: 'Missing image file (multipart field name: image)',
                });
                return;
            }
            const name = file.originalname || 'upload.jpg';
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.jpg';
            const assetId = await (0, sanityPublisher_1.uploadImageBufferToSanity)(file.buffer, safeName);
            const chatId = resolveSessionChatId(req);
            const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            const prev = session.recentUploadAssetIds ?? [];
            session.recentUploadAssetIds = [...prev, assetId].slice(-5);
            (0, telegramSessionStore_1.persistTelegramSessions)();
            console.log(`[api] POST /api/upload → session ${chatId} recentUploadAssetIds (${session.recentUploadAssetIds?.length ?? 0}): appended ${assetId}`);
            res.json({
                ok: true,
                source: resolveApiClientSource(req),
                assetId,
                sanityImageAssetId: assetId,
                sessionChatId: chatId,
                recentUploadCount: session.recentUploadAssetIds?.length ?? 0,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/upload failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
    app.post('/api/upload-voice', requireApiKey, (req, res, next) => {
        multerUploadAudio.fields([
            { name: 'audio', maxCount: 1 },
            { name: 'file', maxCount: 1 },
            { name: 'voice', maxCount: 1 },
        ])(req, res, (err) => {
            if (err) {
                const msg = err instanceof Error ? err.message : String(err);
                res.status(400).json({ error: msg });
                return;
            }
            next();
        });
    }, async (req, res) => {
        try {
            const files = req.files;
            const file = files?.['audio']?.[0] ?? files?.['file']?.[0] ?? files?.['voice']?.[0];
            if (!file?.buffer) {
                res.status(400).json({
                    error: 'Missing audio file (multipart field: audio, file, or voice — one required)',
                });
                return;
            }
            const name = file.originalname || 'voice.webm';
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'voice.webm';
            const text = await (0, transcribeAgent_1.transcribeAudio)(file.buffer, safeName);
            if (!text.trim()) {
                res.status(400).json({ error: 'Transcription was empty' });
                return;
            }
            const chatId = resolveSessionChatId(req);
            const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            session.notes.push(text);
            (0, telegramSessionStore_1.persistTelegramSessions)();
            console.log(`[api] POST /api/upload-voice → appended transcript (${text.length} chars) for session ${chatId}`);
            res.json({
                ok: true,
                source: resolveApiClientSource(req),
                text,
                transcription: text,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/upload-voice failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
    app.post('/api/upload-video', requireApiKey, (req, res, next) => {
        multerUploadVideo.single('video')(req, res, (err) => {
            if (err) {
                const msg = err instanceof Error ? err.message : String(err);
                res.status(400).json({ error: msg });
                return;
            }
            next();
        });
    }, async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer) {
                res.status(400).json({
                    error: 'Missing video file (multipart field name: video)',
                });
                return;
            }
            const name = file.originalname || 'upload.mp4';
            const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload.mp4';
            const mime = file.mimetype || 'application/octet-stream';
            const assetId = await (0, sanityPublisher_1.uploadVideoBufferToSanity)(file.buffer, safeName, mime);
            const chatId = resolveSessionChatId(req);
            const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            session.draftVideoAssetId = assetId;
            (0, telegramSessionStore_1.persistTelegramSessions)();
            console.log(`[api] POST /api/upload-video → session ${chatId} draftVideoAssetId=${assetId}`);
            res.json({
                ok: true,
                source: resolveApiClientSource(req),
                assetId,
                fileAssetId: assetId,
                sanityVideoAssetId: assetId,
                sessionChatId: chatId,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/upload-video failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
    app.post('/api/clear-draft-video', requireApiKey, (req, res) => {
        try {
            const chatId = resolveSessionChatId(req);
            const session = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            delete session.draftVideoAssetId;
            (0, telegramSessionStore_1.persistTelegramSessions)();
            res.json({ ok: true, source: resolveApiClientSource(req) });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/clear-draft-video failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
    app.get('/api/status', requireApiKey, async (req, res) => {
        try {
            const snapshot = (0, pipelineStatus_1.getPipelineStatusSnapshot)();
            const articleCount = await (0, sanityPublisher_1.countPostDocuments)();
            res.json({
                ...snapshot,
                articleCount,
                source: resolveApiClientSource(req),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/status failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
    app.post('/api/command', requireApiKey, (req, res, next) => {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('multipart/form-data')) {
            multerCommandImages.array('images', 5)(req, res, (err) => {
                if (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    res.status(400).json({ error: msg });
                    return;
                }
                next();
            });
        }
        else {
            next();
        }
    }, async (req, res) => {
        const raw = req.body?.command;
        const command = typeof raw === 'string' ? raw.trim() : '';
        const isDaemonCommand = (s) => s === '/publish' ||
            s === '/new' ||
            s === '/start' ||
            s === 'runWriter' ||
            s === 'syncEvents' ||
            s === 'syncNews' ||
            s === 'syncDispensaries' ||
            s === 'syncRestaurants';
        if (!isDaemonCommand(command)) {
            res.status(400).json({
                error: 'Use JSON or multipart: command, notes (or story/body/…), optional length/tone (only when dashboard: X-Client-Source: dashboard and/or body.source=dashboard). Commands: /publish | /new | /start | runWriter | syncEvents | syncNews | syncDispensaries | syncRestaurants.',
            });
            return;
        }
        if (command === 'runWriter') {
            console.log('[api] /api/command runWriter → runPipelineJob (scheduled writer pipeline)');
            try {
                const { skipped } = await (0, pipelineRunner_1.runPipelineJob)();
                if (skipped) {
                    res.status(409).json({
                        error: 'Pipeline is already running',
                    });
                    return;
                }
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: 'runWriter',
                    message: 'Writer pipeline started',
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command runWriter failed:', msg);
                res.status(500).json({ error: msg });
            }
            return;
        }
        if (command === 'syncNews') {
            if (!config_1.config.serpApi.apiKey) {
                res.status(503).json({
                    error: 'SERPAPI_API_KEY is not configured',
                });
                return;
            }
            try {
                console.log('[api] /api/command syncNews → syncNewsApiToSanity (SerpApi Google News)');
                const result = await (0, newsApiSync_1.syncNewsApiToSanity)();
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: 'syncNews',
                    ...result,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command syncNews failed:', msg);
                res.status(500).json({ error: msg });
            }
            return;
        }
        if (command === 'syncEvents') {
            if (!config_1.config.serpApi.apiKey) {
                res.status(503).json({
                    error: 'SERPAPI_API_KEY is not configured',
                });
                return;
            }
            try {
                console.log('[api] /api/command syncEvents → syncSerpApiEventsToSanity');
                const result = await (0, serpApiEventsSync_1.syncSerpApiEventsToSanity)();
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: 'syncEvents',
                    ...result,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command syncEvents failed:', msg);
                res.status(500).json({ error: msg });
            }
            return;
        }
        if (command === 'syncDispensaries') {
            if (!config_1.config.serpApi.apiKey) {
                res.status(503).json({
                    error: 'SERPAPI_API_KEY is not configured',
                });
                return;
            }
            try {
                console.log('[api] /api/command syncDispensaries → syncDispensariesToSanity (SerpApi Google Maps)');
                const result = await (0, syncDispensaries_1.syncDispensariesToSanity)();
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: 'syncDispensaries',
                    ...result,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command syncDispensaries failed:', msg);
                res.status(500).json({ error: msg });
            }
            return;
        }
        if (command === 'syncRestaurants') {
            if (!config_1.config.serpApi.apiKey) {
                res.status(503).json({
                    error: 'SERPAPI_API_KEY is not configured',
                });
                return;
            }
            if (!config_1.config.sanity.projectId || !config_1.config.sanity.apiToken) {
                res.status(503).json({
                    error: 'SANITY_PROJECT_ID and SANITY_API_TOKEN are required for restaurant sync',
                });
                return;
            }
            try {
                console.log('[api] /api/command syncRestaurants → runFetchRestaurants (SerpApi Google Maps, 7 AZ cities)');
                (0, pipelineStatus_1.appendActivityLog)('syncRestaurants: started (Phoenix, Scottsdale, Tempe, Mesa, Glendale, Chandler, Surprise AZ)', 'syncRestaurants');
                const cities = await (0, fetchRestaurants_1.runFetchRestaurants)({
                    onCityComplete: (r) => {
                        (0, pipelineStatus_1.appendActivityLog)(`syncRestaurants: ${r.city}, AZ complete — created=${r.created}, updated=${r.updated}, candidates=${r.candidates}`, 'syncRestaurants');
                    },
                });
                (0, pipelineStatus_1.appendActivityLog)('syncRestaurants: all cities finished', 'syncRestaurants');
                const totals = cities.reduce((acc, c) => ({
                    created: acc.created + c.created,
                    updated: acc.updated + c.updated,
                    candidates: acc.candidates + c.candidates,
                }), { created: 0, updated: 0, candidates: 0 });
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: 'syncRestaurants',
                    cities,
                    ...totals,
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command syncRestaurants failed:', msg);
                (0, pipelineStatus_1.appendActivityLog)(`syncRestaurants: failed — ${msg}`, 'syncRestaurants');
                res.status(500).json({ error: msg });
            }
            return;
        }
        if (command === '/publish') {
            const isMultipart = (req.headers['content-type'] || '').includes('multipart/form-data');
            console.log(`[api] /publish mode=${isMultipart ? 'multipart' : 'json'} body keys:`, req.body && typeof req.body === 'object' ? Object.keys(req.body) : []);
            const notesTrim = extractPublishNotesFromBody(req.body);
            const chatId = resolveSessionChatId(req);
            const sessionPreview = (0, telegramSessionStore_1.getTelegramSession)(chatId);
            const hasSessionDraft = (sessionPreview.recentUploadAssetIds?.length ?? 0) > 0 ||
                (sessionPreview.pendingImageAssetIds?.length ?? 0) > 0 ||
                (sessionPreview.notes?.some((n) => typeof n === 'string' && n.trim().length > 0) ??
                    false) ||
                !!sessionPreview.heroSanityAssetId ||
                !!sessionPreview.draftVideoAssetId;
            const jsonImageOpts = extractImagePublishOptionsFromBody(req.body);
            const hasJsonBodyImages = (jsonImageOpts?.imageAssetIds?.length ?? 0) > 0;
            /** Multipart /publish is always dashboard ingest (notes and/or images in form, or relies on session). */
            const useTelegramIngest = notesTrim !== undefined ||
                hasSessionDraft ||
                isMultipart ||
                hasJsonBodyImages;
            console.log('[api] /publish extracted notes:', notesTrim === undefined
                ? hasSessionDraft
                    ? '(none — ingest via session draft)'
                    : '(none — autonomous pipeline)'
                : `${notesTrim.slice(0, 200)}${notesTrim.length > 200 ? '…' : ''}`);
            if (useTelegramIngest) {
                const effectiveNotes = notesTrim ?? '';
                const clientSource = resolveApiClientSource(req);
                const dashboardStyle = requestIsDashboardSource(req);
                const articleStyle = dashboardStyle
                    ? (0, articleStyle_1.extractArticleStyleFromBody)(req.body)
                    : null;
                const styleOpts = dashboardStyle
                    ? {
                        applyDashboardArticleStyle: true,
                        articleLength: articleStyle.articleLength,
                        articleTone: articleStyle.articleTone,
                    }
                    : { applyDashboardArticleStyle: false };
                const publishAuthorName = extractAuthorNameFromBody(req.body);
                const authorOpts = publishAuthorName !== undefined ? { authorName: publishAuthorName } : {};
                console.log(`[api] /publish → ingest path (client=${clientSource}, dashboardStyle=${dashboardStyle}${dashboardStyle
                    ? `, length=${articleStyle.articleLength}, tone=${articleStyle.articleTone}`
                    : ''})`);
                try {
                    if (isMultipart) {
                        const files = req.files;
                        const list = Array.isArray(files) ? files : [];
                        if (list.length > 5) {
                            res.status(400).json({ error: 'At most 5 images allowed per article' });
                            return;
                        }
                        if (list.length > 0) {
                            const imageAssetIds = [];
                            for (let i = 0; i < list.length; i++) {
                                const file = list[i];
                                const name = file.originalname?.replace(/[^a-zA-Z0-9._-]/g, '_') ||
                                    `dashboard-${i}.jpg`;
                                const assetId = await (0, sanityPublisher_1.uploadImageBufferToSanity)(file.buffer, name);
                                imageAssetIds.push(assetId);
                            }
                            console.log(`[api] /publish multipart: ${imageAssetIds.length} file(s) (first = hero) — no DALL·E`);
                            await (0, telegramBotCore_1.publishStoryFromSourceNotes)(bot, chatId, effectiveNotes, {
                                imageAssetIds,
                                ...styleOpts,
                                ...authorOpts,
                            });
                        }
                        else {
                            console.log('[api] /publish multipart: no files — using session recentUploadAssetIds if any (else DALL·E)');
                            await (0, telegramBotCore_1.publishStoryFromSourceNotes)(bot, chatId, effectiveNotes, {
                                ...styleOpts,
                                ...authorOpts,
                            });
                        }
                    }
                    else {
                        const imgOpts = extractImagePublishOptionsFromBody(req.body);
                        if (imgOpts && imgOpts.imageAssetIds.length > 0) {
                            console.log(`[api] /publish JSON: imageAssetIds count=${imgOpts.imageAssetIds.length} (first = hero)`);
                            await (0, telegramBotCore_1.publishStoryFromSourceNotes)(bot, chatId, effectiveNotes, {
                                imageAssetIds: imgOpts.imageAssetIds,
                                ...styleOpts,
                                ...authorOpts,
                            });
                        }
                        else {
                            await (0, telegramBotCore_1.publishStoryFromSourceNotes)(bot, chatId, effectiveNotes, {
                                ...styleOpts,
                                ...authorOpts,
                            });
                        }
                    }
                    res.json({
                        ok: true,
                        source: clientSource,
                        command: '/publish',
                        publishMode: clientSource === 'dashboard' ? 'dashboard_ingest' : 'telegram_ingest',
                        dashboardArticleStyle: dashboardStyle,
                        ...(dashboardStyle && articleStyle
                            ? {
                                articleLength: articleStyle.articleLength,
                                articleTone: articleStyle.articleTone,
                            }
                            : {}),
                    });
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error('[api] /api/command /publish (ingest) failed:', msg);
                    res.status(500).json({ error: msg });
                }
                return;
            }
            console.log('[api] /publish → autonomous pipeline (runPipelineJob)');
            const dashboardPipelineStyle = requestIsDashboardSource(req);
            const pipelineStyle = dashboardPipelineStyle
                ? (0, articleStyle_1.extractArticleStyleFromBody)(req.body)
                : null;
            try {
                const { skipped } = await (0, pipelineRunner_1.runPipelineJob)(dashboardPipelineStyle && pipelineStyle
                    ? {
                        notes: notesTrim,
                        applyDashboardArticleStyle: true,
                        articleLength: pipelineStyle.articleLength,
                        articleTone: pipelineStyle.articleTone,
                    }
                    : { notes: notesTrim });
                if (skipped) {
                    res.status(409).json({
                        error: 'Pipeline is already running',
                    });
                    return;
                }
                res.json({
                    ok: true,
                    source: resolveApiClientSource(req),
                    command: '/publish',
                    publishMode: 'autonomous_pipeline',
                    dashboardArticleStyle: dashboardPipelineStyle,
                    ...(dashboardPipelineStyle && pipelineStyle
                        ? {
                            articleLength: pipelineStyle.articleLength,
                            articleTone: pipelineStyle.articleTone,
                        }
                        : {}),
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[api] /api/command /publish (pipeline) failed:', msg);
                res.status(500).json({ error: msg });
            }
            return;
        }
        const chatId = resolveSessionChatId(req);
        try {
            await (0, telegramBotCore_1.executeTelegramDaemonCommand)(bot, chatId, command);
            res.json({ ok: true, source: resolveApiClientSource(req), command });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[api] /api/command failed:', msg);
            res.status(500).json({ error: msg });
        }
    });
}
/**
 * Grammy's `webhookCallback` returns a Promise that rejects on middleware errors, timeouts,
 * or init failures. Express does not catch async route rejections, so Telegram sees 500 and
 * retries the update. We always respond 200 after logging so Telegram stops retrying.
 */
function createSafeTelegramWebhookHandler(bot) {
    const inner = (0, grammy_1.webhookCallback)(bot, 'express');
    return (req, res) => {
        void Promise.resolve(inner(req, res)).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            console.error('[telegram] webhook error (ack 200 to Telegram):', message, stack ?? '');
            if (!res.headersSent) {
                res.status(200).end();
            }
        });
    };
}
/**
 * Express app + Telegram webhook route, bound for cloud hosts (Render requires 0.0.0.0 + PORT).
 * Registers handlers, calls setWebhook with public URL, logs getWebhookInfo for debugging.
 */
async function startTelegramWebhookExpress(bot) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json({ limit: '20mb' }));
    (0, telegramBotCore_1.registerTelegramHandlers)(bot);
    const webhookPath = `/telegram/webhook/${config_1.config.telegram.webhookPathSecret}`;
    app.post(webhookPath, createSafeTelegramWebhookHandler(bot));
    app.get('/health', (_req, res) => res.status(200).send('ok'));
    registerDaemonApiRoutes(app, bot);
    const webhookUrl = (0, config_1.getTelegramWebhookFullUrl)();
    await new Promise((resolve, reject) => {
        const server = app.listen(config_1.config.telegram.port, RENDER_HOST, async () => {
            try {
                console.log(`[telegram] HTTP listening on http://${RENDER_HOST}:${config_1.config.telegram.port} (POST ${webhookPath})`);
                await bot.api.setWebhook(webhookUrl);
                console.log(`[telegram] setWebhook registered: ${webhookUrl}`);
                const info = await bot.api.getWebhookInfo();
                const summary = {
                    url: info.url,
                    pending_update_count: info.pending_update_count,
                    last_error_message: info.last_error_message,
                    last_error_date: info.last_error_date,
                    max_connections: info.max_connections,
                };
                console.log('[telegram] getWebhookInfo:', JSON.stringify(summary));
                if (info.url && info.url !== webhookUrl) {
                    console.warn(`[telegram] URL mismatch: Telegram has "${info.url}" but this deploy set "${webhookUrl}". Update TELEGRAM_WEBHOOK_BASE_URL or deleteWebhook + redeploy.`);
                }
                if (info.last_error_message) {
                    console.warn('[telegram] Telegram last_error_message:', info.last_error_message);
                }
                resolve();
            }
            catch (err) {
                console.error('[telegram] setWebhook / getWebhookInfo failed:', err);
                reject(err);
            }
        });
        server.on('error', (err) => {
            console.error('[telegram] HTTP server error:', err);
            reject(err);
        });
    });
}
//# sourceMappingURL=telegramHttpServer.js.map
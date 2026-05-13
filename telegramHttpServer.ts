import express from 'express';
import multer from 'multer';

import { config } from './config';
import { syncNewsApiToSanity } from './agents/newsApiSync';
import { syncSerpApiEventsToSanity } from './agents/serpApiEventsSync';
import { syncDispensariesToSanity } from './agents/syncDispensaries';
import { transcribeAudio } from './agents/transcribeAgent';
import {
  countPostDocuments,
  uploadImageBufferToSanity,
  uploadVideoBufferToSanity,
} from './agents/sanityPublisher';
import { appendActivityLog, getPipelineStatusSnapshot } from './pipelineStatus';
import { syncNightlifeToSanity } from './agents/syncNightlife';
import { runFetchRestaurants } from './scripts/fetchRestaurants';
import { runPipelineJob } from './pipelineRunner';
import { getTelegramSession, persistTelegramSessions } from './telegramSessionStore';
import { extractArticleStyleFromBody } from './utils/articleStyle';
import { runResearchAndWrite } from './agents/researchAndWritePipeline';

const RENDER_HOST = '0.0.0.0';

const multerUploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** Up to 5 images for POST /api/command multipart /publish (field name: images). */
const multerCommandImages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** Whisper API accepts up to 25 MB per file. */
const multerUploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Dashboard video — Sanity file assets; cap to avoid OOM on small dynos. */
const multerUploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/** Coerce API body fields into one trimmed notes string for /publish. */
function coerceToNotesString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
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
function extractPublishNotesFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
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
  ] as const;
  for (const k of keys) {
    const s = coerceToNotesString(o[k]);
    if (s) return s;
  }
  return undefined;
}

/**
 * JSON body: optional `uploadedImages` or `imageAssetIds` (max 5 Sanity asset _ids). First id = hero.
 */
function extractImagePublishOptionsFromBody(body: unknown): { imageAssetIds: string[] } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  let raw: unknown;
  if ('uploadedImages' in o) {
    raw = o.uploadedImages;
  } else if ('imageAssetIds' in o) {
    raw = o.imageAssetIds;
  } else {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return { imageAssetIds: [] };
  }
  const imageAssetIds = raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, 5);
  return { imageAssetIds };
}

/** Dashboard /publish: optional byline for the Sanity post `author` field. */
function extractAuthorNameFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const v = (body as Record<string, unknown>).authorName;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, 200);
}

/** Dig & Write: Unsplash hero on researchAndWrite; `mode`, `digAndWrite`, or `writeMode`. */
function extractDigAndWriteMode(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (o.digAndWrite === true || o.digWrite === true) return true;
  const mode = o.mode;
  if (typeof mode === 'string') {
    const m = mode.trim().toLowerCase().replace(/\s+/g, '-');
    if (m === 'dig-and-write' || m === 'digwrite' || m === 'dig_write') return true;
  }
  const wm = o.writeMode;
  if (typeof wm === 'string' && /\bdig\b/i.test(wm) && /\bwrite\b/i.test(wm)) return true;
  return false;
}

/** Optional OpenAI fact-check (⚠️) on `POST /api/command/researchAndWrite`; default off. */
function extractRunFactCheckFromBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (o.runFactCheck === true || o.factCheck === true) return true;
  return false;
}

/** Comma-separated origins (e.g. https://your-app.vercel.app). Empty = allow any origin (*). */
function getCorsAllowlist(): string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function corsMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const allowlist = getCorsAllowlist();
  const origin = req.header('Origin');

  if (allowlist.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowlist.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin) {
    // Browser sent Origin but it is not in CORS_ORIGINS — omit ACAO so the browser blocks.
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-API-Key, Authorization, X-Session-Chat-Id, X-Requester-Id, X-Client-Source'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function getConfiguredApiKey(): string {
  return process.env.API_KEY?.trim() || '';
}

function requireApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const configured = getConfiguredApiKey();
  if (!configured) {
    res.status(503).json({ error: 'API_KEY is not configured on the server' });
    return;
  }
  const headerKey = req.header('x-api-key')?.trim();
  const auth = req.header('authorization');
  const bearer =
    auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
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
function resolveSessionChatId(req: express.Request): number {
  const raw =
    req.header('x-session-chat-id')?.trim() ?? req.header('x-requester-id')?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return 0;
}

/** Set by dashboard (`X-Client-Source: dashboard`); echoed in JSON and used for publishMode labels. */
function resolveApiClientSource(req: express.Request): 'dashboard' | 'unknown' {
  const raw = req.header('x-client-source')?.trim().toLowerCase();
  return raw === 'dashboard' ? 'dashboard' : 'unknown';
}

/**
 * Length/tone/spin GPT instructions apply only when the request identifies as dashboard:
 * `X-Client-Source: dashboard` or JSON/multipart field `source: "dashboard"`.
 */
function requestIsDashboardSource(req: express.Request): boolean {
  if (resolveApiClientSource(req) === 'dashboard') return true;
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const s = (b as Record<string, unknown>).source;
    if (typeof s === 'string' && s.trim().toLowerCase() === 'dashboard') return true;
  }
  return false;
}

function writeSse(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function registerDaemonApiRoutes(app: express.Application): void {
  app.use(corsMiddleware);

  /**
   * Dashboard: research (OpenAI web search via Responses API) + single-article writer in parallel where possible,
   * stream merged `sources` as SSE, optional fact-check (`runFactCheck` or `factCheck: true`) then Sources section; final payload on `article` event.
   * Body: same steering as autonomous `/publish` — `notes` (or aliases), optional `length`/`tone`, optional `authorName`,
   * dashboard via `X-Client-Source: dashboard` and/or `source: "dashboard"`.
   * Dig & Write: set `mode: "dig-and-write"` or `digAndWrite: true` to use Unsplash hero (`UNSPLASH_ACCESS_KEY`); otherwise DALL·E hero (same image stack as orchestrator, only on this route).
   */
  app.post(
    '/api/command/researchAndWrite',
    requireApiKey,
    async (req, res) => {
      const notesRaw = extractPublishNotesFromBody(req.body);
      const notes = notesRaw?.trim() ?? '';
      if (!notes) {
        res.status(400).json({
          error:
            'Missing notes: provide `notes` or story/body/content/… (same field names as the publish / runWriter payload).',
        });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const dashboardStyle = requestIsDashboardSource(req);
      const articleStyle = extractArticleStyleFromBody(req.body);
      const authorName = extractAuthorNameFromBody(req.body);
      const digAndWrite = extractDigAndWriteMode(req.body);
      const runFactCheck = extractRunFactCheckFromBody(req.body);

      try {
        const {
          article,
          sources,
          heroImageAssetId,
          heroImageSource,
          sanityDocumentId,
        } = await runResearchAndWrite({
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command/researchAndWrite failed:', msg);
        if (err instanceof Error && err.stack) {
          console.error('[api] /api/command/researchAndWrite stack:\n', err.stack);
        }
        writeSse(res, 'error', { ok: false, message: msg });
        writeSse(res, 'done', { ok: false });
        res.end();
      }
    }
  );

  app.post(
    '/api/upload',
    requireApiKey,
    (req, res, next) => {
      multerUploadImage.single('image')(req, res, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: msg });
          return;
        }
        next();
      });
    },
    async (req, res) => {
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
        const assetId = await uploadImageBufferToSanity(file.buffer, safeName);
        const chatId = resolveSessionChatId(req);
        const session = getTelegramSession(chatId);
        const prev = session.recentUploadAssetIds ?? [];
        session.recentUploadAssetIds = [...prev, assetId].slice(-5);
        persistTelegramSessions();
        console.log(
          `[api] POST /api/upload → session ${chatId} recentUploadAssetIds (${session.recentUploadAssetIds?.length ?? 0}): appended ${assetId}`
        );
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          assetId,
          sanityImageAssetId: assetId,
          sessionChatId: chatId,
          recentUploadCount: session.recentUploadAssetIds?.length ?? 0,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/upload failed:', msg);
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/upload-voice',
    requireApiKey,
    (req, res, next) => {
      multerUploadAudio.fields([
        { name: 'audio', maxCount: 1 },
        { name: 'file', maxCount: 1 },
        { name: 'voice', maxCount: 1 },
      ])(req, res, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: msg });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      try {
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const file =
          files?.['audio']?.[0] ?? files?.['file']?.[0] ?? files?.['voice']?.[0];
        if (!file?.buffer) {
          res.status(400).json({
            error:
              'Missing audio file (multipart field: audio, file, or voice — one required)',
          });
          return;
        }
        const name = file.originalname || 'voice.webm';
        const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'voice.webm';
        const text = await transcribeAudio(file.buffer, safeName);
        if (!text.trim()) {
          res.status(400).json({ error: 'Transcription was empty' });
          return;
        }
        const chatId = resolveSessionChatId(req);
        const session = getTelegramSession(chatId);
        session.notes.push(text);
        persistTelegramSessions();
        console.log(
          `[api] POST /api/upload-voice → appended transcript (${text.length} chars) for session ${chatId}`
        );
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          text,
          transcription: text,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/upload-voice failed:', msg);
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post(
    '/api/upload-video',
    requireApiKey,
    (req, res, next) => {
      multerUploadVideo.single('video')(req, res, (err: unknown) => {
        if (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.status(400).json({ error: msg });
          return;
        }
        next();
      });
    },
    async (req, res) => {
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
        const assetId = await uploadVideoBufferToSanity(file.buffer, safeName, mime);
        const chatId = resolveSessionChatId(req);
        const session = getTelegramSession(chatId);
        session.draftVideoAssetId = assetId;
        persistTelegramSessions();
        console.log(
          `[api] POST /api/upload-video → session ${chatId} draftVideoAssetId=${assetId}`
        );
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          assetId,
          fileAssetId: assetId,
          sanityVideoAssetId: assetId,
          sessionChatId: chatId,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/upload-video failed:', msg);
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post('/api/clear-draft-video', requireApiKey, (req, res) => {
    try {
      const chatId = resolveSessionChatId(req);
      const session = getTelegramSession(chatId);
      delete session.draftVideoAssetId;
      persistTelegramSessions();
      res.json({ ok: true, source: resolveApiClientSource(req) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[api] /api/clear-draft-video failed:', msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/status', requireApiKey, async (req, res) => {
    try {
      const snapshot = getPipelineStatusSnapshot();
      const articleCount = await countPostDocuments();
      res.json({
        ...snapshot,
        articleCount,
        source: resolveApiClientSource(req),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[api] /api/status failed:', msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    '/api/command',
    requireApiKey,
    (req, res, next) => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('multipart/form-data')) {
        multerCommandImages.array('images', 5)(req, res, (err: unknown) => {
          if (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(400).json({ error: msg });
            return;
          }
          next();
        });
      } else {
        next();
      }
    },
    async (req, res) => {
    const raw = req.body?.command;
    const command =
      typeof raw === 'string' ? raw.trim() : '';
    const isDaemonCommand = (
      s: string
    ): s is
      | '/publish'
      | 'runWriter'
      | 'syncEvents'
      | 'syncNews'
      | 'syncDispensaries'
      | 'syncRestaurants'
      | 'syncNightlife' =>
      s === '/publish' ||
      s === 'runWriter' ||
      s === 'syncEvents' ||
      s === 'syncNews' ||
      s === 'syncDispensaries' ||
      s === 'syncRestaurants' ||
      s === 'syncNightlife';
    if (!isDaemonCommand(command)) {
      res.status(400).json({
        error:
          'Use JSON or multipart: command, notes (or story/body/…), optional length/tone (only when dashboard: X-Client-Source: dashboard and/or body.source=dashboard). Commands: /publish | runWriter | syncEvents | syncNews | syncDispensaries | syncRestaurants | syncNightlife.',
      });
      return;
    }

    if (command === 'runWriter') {
      console.log('[api] /api/command runWriter → runPipelineJob (scheduled writer pipeline)');
      try {
        const { skipped } = await runPipelineJob();
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command runWriter failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === 'syncNews') {
      if (!config.serpApi.apiKey) {
        res.status(503).json({
          error: 'SERPAPI_API_KEY is not configured',
        });
        return;
      }
      try {
        console.log('[api] /api/command syncNews → syncNewsApiToSanity (SerpApi Google News)');
        const result = await syncNewsApiToSanity();
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: 'syncNews',
          ...result,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command syncNews failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === 'syncEvents') {
      if (!config.serpApi.apiKey) {
        res.status(503).json({
          error: 'SERPAPI_API_KEY is not configured',
        });
        return;
      }
      try {
        console.log('[api] /api/command syncEvents → syncSerpApiEventsToSanity');
        const result = await syncSerpApiEventsToSanity();
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: 'syncEvents',
          ...result,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command syncEvents failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === 'syncDispensaries') {
      if (!config.serpApi.apiKey) {
        res.status(503).json({
          error: 'SERPAPI_API_KEY is not configured',
        });
        return;
      }
      try {
        console.log('[api] /api/command syncDispensaries → syncDispensariesToSanity (SerpApi Google Maps)');
        const result = await syncDispensariesToSanity();
        appendActivityLog(`syncDispensaries: SerpAPI calls used: ${result.serpApiCalls}`, 'syncDispensaries');
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: 'syncDispensaries',
          ...result,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command syncDispensaries failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === 'syncRestaurants') {
      if (!config.serpApi.apiKey) {
        res.status(503).json({
          error: 'SERPAPI_API_KEY is not configured',
        });
        return;
      }
      if (!config.sanity.projectId || !config.sanity.apiToken) {
        res.status(503).json({
          error: 'SANITY_PROJECT_ID and SANITY_API_TOKEN are required for restaurant sync',
        });
        return;
      }
      try {
        console.log(
          '[api] /api/command syncRestaurants → runFetchRestaurants (SerpApi Google Maps, 7 AZ cities)'
        );
        appendActivityLog(
          'syncRestaurants: started (Phoenix, Scottsdale, Tempe, Mesa, Glendale, Chandler, Surprise AZ)',
          'syncRestaurants'
        );
        const cities = await runFetchRestaurants({
          onCityComplete: (r) => {
            appendActivityLog(
              `syncRestaurants: ${r.city}, AZ complete — created=${r.created}, updated=${r.updated}, candidates=${r.candidates}`,
              'syncRestaurants'
            );
          },
        });
        const totals = cities.reduce(
          (acc, c) => ({
            created: acc.created + c.created,
            updated: acc.updated + c.updated,
            candidates: acc.candidates + c.candidates,
            serpApiCalls: acc.serpApiCalls + c.serpApiCalls,
          }),
          { created: 0, updated: 0, candidates: 0, serpApiCalls: 0 }
        );
        appendActivityLog(`syncRestaurants: SerpAPI calls used: ${totals.serpApiCalls}`, 'syncRestaurants');
        appendActivityLog('syncRestaurants: all cities finished', 'syncRestaurants');
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: 'syncRestaurants',
          cities,
          ...totals,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command syncRestaurants failed:', msg);
        appendActivityLog(`syncRestaurants: failed — ${msg}`, 'syncRestaurants');
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === 'syncNightlife') {
      if (!config.serpApi.apiKey) {
        res.status(503).json({
          error: 'SERPAPI_API_KEY is not configured',
        });
        return;
      }
      if (!config.sanity.projectId || !config.sanity.apiToken) {
        res.status(503).json({
          error: 'SANITY_PROJECT_ID and SANITY_API_TOKEN are required for nightlife sync',
        });
        return;
      }
      try {
        console.log(
          '[api] /api/command syncNightlife → syncNightlifeToSanity (SerpApi Google Maps, Phoenix/Scottsdale bars & nightclubs)'
        );
        appendActivityLog(
          'syncNightlife: started (top 25 metro-wide → Sanity `nightlife`)',
          'syncNightlife'
        );
        const result = await syncNightlifeToSanity();
        appendActivityLog(
          `syncNightlife: complete — created=${result.created}, updated=${result.updated}, candidates=${result.candidates}`,
          'syncNightlife'
        );
        appendActivityLog(`syncNightlife: SerpAPI calls used: ${result.serpApiCalls}`, 'syncNightlife');
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: 'syncNightlife',
          ...result,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command syncNightlife failed:', msg);
        appendActivityLog(`syncNightlife: failed — ${msg}`, 'syncNightlife');
        res.status(500).json({ error: msg });
      }
      return;
    }

    if (command === '/publish') {
      console.log(
        `[api] /publish body keys:`,
        req.body && typeof req.body === 'object' ? Object.keys(req.body as object) : []
      );
      const notesTrim = extractPublishNotesFromBody(req.body);
      console.log(
        '[api] /publish notes:',
        notesTrim ? `${notesTrim.slice(0, 200)}${notesTrim.length > 200 ? '…' : ''}` : '(none — autonomous pipeline)'
      );
      const dashboardStyle = requestIsDashboardSource(req);
      const pipelineStyle = dashboardStyle ? extractArticleStyleFromBody(req.body) : null;
      const publishAuthorName = extractAuthorNameFromBody(req.body);
      try {
        const { skipped } = await runPipelineJob({
          notes: notesTrim,
          ...(dashboardStyle && pipelineStyle
            ? {
                applyDashboardArticleStyle: true,
                articleLength: pipelineStyle.articleLength,
                articleTone: pipelineStyle.articleTone,
              }
            : {}),
          ...(publishAuthorName ? { authorName: publishAuthorName } : {}),
        });
        if (skipped) {
          res.status(409).json({ error: 'Pipeline is already running' });
          return;
        }
        res.json({
          ok: true,
          source: resolveApiClientSource(req),
          command: '/publish',
          publishMode: 'autonomous_pipeline',
          dashboardArticleStyle: dashboardStyle,
          ...(dashboardStyle && pipelineStyle
            ? {
                articleLength: pipelineStyle.articleLength,
                articleTone: pipelineStyle.articleTone,
              }
            : {}),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command /publish failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }
  }
  );
}


/**
 * Express API server for cloud hosts (Render requires 0.0.0.0 + PORT).
 * Exposes /api/* routes used by the dashboard. No Telegram dependency.
 */
export async function startApiServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (_req, res) => res.status(200).send('ok'));

  registerDaemonApiRoutes(app);

  const port = config.telegram.port;

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, RENDER_HOST, () => {
      console.log(`[api] HTTP server listening on http://${RENDER_HOST}:${port}`);
      resolve();
    });

    server.on('error', (err) => {
      console.error('[api] HTTP server error:', err);
      reject(err);
    });
  });
}

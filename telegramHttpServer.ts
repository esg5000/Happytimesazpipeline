import express from 'express';
import multer from 'multer';
import { Bot, webhookCallback } from 'grammy';

import { config, getTelegramWebhookFullUrl } from './config';
import { syncNewsApiToSanity } from './agents/newsApiSync';
import { syncSerpApiEventsToSanity } from './agents/serpApiEventsSync';
import { syncDispensariesToSanity } from './agents/syncDispensaries';
import { transcribeAudio } from './agents/transcribeAgent';
import {
  countPostDocuments,
  uploadImageBufferToSanity,
} from './agents/sanityPublisher';
import { getPipelineStatusSnapshot } from './pipelineStatus';
import { runPipelineJob } from './pipelineRunner';
import {
  executeTelegramDaemonCommand,
  publishStoryFromSourceNotes,
  registerTelegramHandlers,
} from './telegramBotCore';
import { getTelegramSession, persistTelegramSessions } from './telegramSessionStore';

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
 * Read editorial notes from POST /api/command JSON body.
 * Accepts `notes`, `editorialNotes`, `editorNotes`, or `topicNotes` (first non-empty wins).
 */
function extractPublishNotesFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  const keys = [
    'notes',
    'editorialNotes',
    'editorNotes',
    'topicNotes',
  ] as const;
  for (const k of keys) {
    const s = coerceToNotesString(o[k]);
    if (s) return s;
  }
  return undefined;
}

/**
 * JSON body: optional `imageAssetIds` (max 5 Sanity image asset _ids) + `heroImageIndex` (0-based).
 * When present, publish replaces the draft and uses the designated hero + additionalImages on the post.
 */
function extractImagePublishOptionsFromBody(body: unknown):
  | { imageAssetIds: string[]; heroImageIndex: number }
  | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  if (!('imageAssetIds' in o)) return undefined;
  const raw = o.imageAssetIds;
  if (!Array.isArray(raw)) {
    return { imageAssetIds: [], heroImageIndex: 0 };
  }
  const imageAssetIds = raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, 5);
  let heroImageIndex = 0;
  if (typeof o.heroImageIndex === 'number' && Number.isFinite(o.heroImageIndex)) {
    heroImageIndex = Math.trunc(o.heroImageIndex);
  } else if (typeof o.heroImageIndex === 'string') {
    const p = parseInt(o.heroImageIndex, 10);
    if (Number.isFinite(p)) heroImageIndex = p;
  }
  return { imageAssetIds, heroImageIndex };
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
    'Content-Type, X-API-Key, Authorization'
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

function registerDaemonApiRoutes(app: express.Application, bot: Bot): void {
  app.use(corsMiddleware);

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
        const chatId = config.telegram.allowedUserId;
        const session = getTelegramSession(chatId);
        session.heroSanityAssetId = assetId;
        persistTelegramSessions();
        console.log(
          `[api] POST /api/upload → heroSanityAssetId for chat ${chatId}: ${assetId}`
        );
        res.json({
          ok: true,
          assetId,
          sanityImageAssetId: assetId,
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
      multerUploadAudio.single('audio')(req, res, (err: unknown) => {
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
            error: 'Missing audio file (multipart field name: audio)',
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
        const chatId = config.telegram.allowedUserId;
        const session = getTelegramSession(chatId);
        session.notes.push(text);
        persistTelegramSessions();
        console.log(
          `[api] POST /api/upload-voice → appended transcript (${text.length} chars) for chat ${chatId}`
        );
        res.json({
          ok: true,
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

  app.get('/api/status', requireApiKey, async (_req, res) => {
    try {
      const snapshot = getPipelineStatusSnapshot();
      const articleCount = await countPostDocuments();
      res.json({
        ...snapshot,
        articleCount,
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
    ): s is '/publish' | '/new' | '/start' | 'syncEvents' | 'syncNews' | 'syncDispensaries' =>
      s === '/publish' ||
      s === '/new' ||
      s === '/start' ||
      s === 'syncEvents' ||
      s === 'syncNews' ||
      s === 'syncDispensaries';
    if (!isDaemonCommand(command)) {
      res.status(400).json({
        error:
          'Use JSON: { "command": "...", "notes"?: string, "imageAssetIds"?: string[], "heroImageIndex"?: number } or multipart/form-data with fields command, notes, heroIndex (optional), and up to 5 files in field "images". Commands: /publish | /new | /start | syncEvents | syncNews | syncDispensaries.',
      });
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
        res.json({
          ok: true,
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

    if (command === '/publish') {
      const isMultipart = (req.headers['content-type'] || '').includes(
        'multipart/form-data'
      );
      console.log(
        `[api] /publish mode=${isMultipart ? 'multipart' : 'json'} body keys:`,
        req.body && typeof req.body === 'object' ? Object.keys(req.body as object) : []
      );
      const notesTrim = extractPublishNotesFromBody(req.body);
      console.log(
        '[api] /publish extracted notes:',
        notesTrim === undefined ? '(none — autonomous pipeline)' : `${notesTrim.slice(0, 200)}${notesTrim.length > 200 ? '…' : ''}`
      );
      const chatId = config.telegram.allowedUserId;

      if (notesTrim !== undefined) {
        console.log(
          '[api] /publish → Telegram ingest path (notes as story source material)'
        );
        try {
          if (isMultipart) {
            const files = (req as { files?: Express.Multer.File[] }).files;
            const list = Array.isArray(files) ? files : [];
            if (list.length > 5) {
              res.status(400).json({ error: 'At most 5 images allowed per article' });
              return;
            }
            const imageAssetIds: string[] = [];
            for (let i = 0; i < list.length; i++) {
              const file = list[i]!;
              const name =
                file.originalname?.replace(/[^a-zA-Z0-9._-]/g, '_') ||
                `dashboard-${i}.jpg`;
              const assetId = await uploadImageBufferToSanity(file.buffer, name);
              imageAssetIds.push(assetId);
            }
            const hiRaw = (req.body as Record<string, unknown>)?.heroIndex;
            let heroImageIndex = 0;
            if (typeof hiRaw === 'string' || typeof hiRaw === 'number') {
              const p = parseInt(String(hiRaw), 10);
              if (Number.isFinite(p)) heroImageIndex = p;
            }
            console.log(
              `[api] /publish multipart: ${imageAssetIds.length} image(s), heroImageIndex=${heroImageIndex}`
            );
            await publishStoryFromSourceNotes(bot, chatId, notesTrim, {
              imageAssetIds,
              heroImageIndex,
            });
          } else {
            const imgOpts = extractImagePublishOptionsFromBody(req.body);
            if (imgOpts) {
              console.log(
                `[api] /publish JSON: imageAssetIds count=${imgOpts.imageAssetIds.length}, heroImageIndex=${imgOpts.heroImageIndex}`
              );
              await publishStoryFromSourceNotes(bot, chatId, notesTrim, {
                imageAssetIds: imgOpts.imageAssetIds,
                heroImageIndex: imgOpts.heroImageIndex,
              });
            } else {
              await publishStoryFromSourceNotes(bot, chatId, notesTrim);
            }
          }
          res.json({
            ok: true,
            command: '/publish',
            publishMode: 'telegram_ingest',
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[api] /api/command /publish (ingest) failed:', msg);
          res.status(500).json({ error: msg });
        }
        return;
      }

      console.log('[api] /publish → autonomous pipeline (runPipelineJob)');
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
          command: '/publish',
          publishMode: 'autonomous_pipeline',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[api] /api/command /publish (pipeline) failed:', msg);
        res.status(500).json({ error: msg });
      }
      return;
    }

    const chatId = config.telegram.allowedUserId;
    try {
      await executeTelegramDaemonCommand(bot, chatId, command);
      res.json({ ok: true, command });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[api] /api/command failed:', msg);
      res.status(500).json({ error: msg });
    }
  }
  );
}

/**
 * Express app + Telegram webhook route, bound for cloud hosts (Render requires 0.0.0.0 + PORT).
 * Registers handlers, calls setWebhook with public URL, logs getWebhookInfo for debugging.
 */
export async function startTelegramWebhookExpress(bot: Bot): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const webhookPath = `/telegram/webhook/${config.telegram.webhookPathSecret}`;
  app.post(webhookPath, webhookCallback(bot, 'express'));
  app.get('/health', (_req, res) => res.status(200).send('ok'));

  registerDaemonApiRoutes(app, bot);
  registerTelegramHandlers(bot);

  const webhookUrl = getTelegramWebhookFullUrl();

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(
      config.telegram.port,
      RENDER_HOST,
      async () => {
        try {
          console.log(
            `[telegram] HTTP listening on http://${RENDER_HOST}:${config.telegram.port} (POST ${webhookPath})`
          );
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
            console.warn(
              `[telegram] URL mismatch: Telegram has "${info.url}" but this deploy set "${webhookUrl}". Update TELEGRAM_WEBHOOK_BASE_URL or deleteWebhook + redeploy.`
            );
          }
          if (info.last_error_message) {
            console.warn('[telegram] Telegram last_error_message:', info.last_error_message);
          }

          resolve();
        } catch (err) {
          console.error('[telegram] setWebhook / getWebhookInfo failed:', err);
          reject(err);
        }
      }
    );

    server.on('error', (err) => {
      console.error('[telegram] HTTP server error:', err);
      reject(err);
    });
  });
}

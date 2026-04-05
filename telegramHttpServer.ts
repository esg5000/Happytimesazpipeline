import express from 'express';
import { Bot, webhookCallback } from 'grammy';

import { config, getTelegramWebhookFullUrl } from './config';
import { countPostDocuments } from './agents/sanityPublisher';
import { getPipelineStatusSnapshot } from './pipelineStatus';
import { runPipelineJob } from './pipelineRunner';
import {
  executeTelegramDaemonCommand,
  publishStoryFromSourceNotes,
  registerTelegramHandlers,
} from './telegramBotCore';

const RENDER_HOST = '0.0.0.0';

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

  app.post('/api/command', requireApiKey, async (req, res) => {
    const raw = req.body?.command;
    const command =
      typeof raw === 'string' ? raw.trim() : '';
    const isDaemonCommand = (
      s: string
    ): s is '/publish' | '/new' | '/start' =>
      s === '/publish' || s === '/new' || s === '/start';
    if (!isDaemonCommand(command)) {
      res.status(400).json({
        error:
          'Body must be JSON: { "command": "/publish" | "/new" | "/start", "notes"?: string } — with /publish, notes are story source (Telegram ingest); omit notes for autonomous batch pipeline',
      });
      return;
    }

    if (command === '/publish') {
      console.log(
        '[api] /publish req.body:',
        JSON.stringify(req.body ?? null, null, 2)
      );
      const notesTrim = extractPublishNotesFromBody(req.body);
      console.log(
        '[api] /publish extracted notes:',
        notesTrim === undefined ? '(none — autonomous pipeline)' : notesTrim
      );
      const chatId = config.telegram.allowedUserId;

      if (notesTrim !== undefined) {
        console.log(
          '[api] /publish → Telegram ingest path (notes as story source material)'
        );
        try {
          await publishStoryFromSourceNotes(bot, chatId, notesTrim);
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
  });
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

import dotenv from 'dotenv';

dotenv.config();

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    /**
     * 'gemini-2.5-flash' was the original default but is retired (HTTP 404 "no longer available
     * to new users" — confirmed live 2026-08-27). The flagship 3.x flash/pro line
     * (gemini-3.5/3.6/3.7-flash, gemini-pro-latest, gemini-3.1-pro-preview) all showed real,
     * live 503 "high demand" capacity shedding that day (roughly 25-75% failure rate across
     * dozens of live attempts) — every response carried `x-gemini-service-tier: standard`
     * regardless of model, consistent with those being the highest-traffic, most
     * capacity-constrained models available to this account right now.
     * 'gemini-3.1-flash-lite' tested 21/21 (100%) successful across two separate live runs
     * that same day — a smaller/cheaper model with evidently far more headroom. Use it as the
     * default until the flagship line's capacity crunch resolves; re-test the others later.
     */
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  },
  /** Unsplash — Dig & Write hero on `POST /api/command/researchAndWrite` only. */
  unsplash: {
    accessKey: (process.env.UNSPLASH_ACCESS_KEY || '').trim(),
  },
  sanity: {
    projectId: process.env.SANITY_PROJECT_ID || '',
    dataset: process.env.SANITY_DATASET || 'production',
    apiToken: process.env.SANITY_API_TOKEN || '',
    apiVersion: process.env.SANITY_API_VERSION || '2024-01-01',
  },
  pipeline: {
    articlesPerDay: parseInt(process.env.ARTICLES_PER_DAY || '1', 10),
    defaultSection: process.env.DEFAULT_SECTION || 'cannabis',
    /** node-cron expression for daemonServer only (default 14:00 daily, server timezone e.g. UTC on Render) */
    cronSchedule: process.env.PIPELINE_CRON || '0 14 * * *',
  },
  ticketmaster: {
    /** Ticketmaster Discovery API consumer key — https://developer.ticketmaster.com */
    apiKey: (process.env.TICKETMASTER_API_KEY || '').trim(),
  },
  brightData: {
    /** Bright Data API key — https://brightdata.com */
    apiKey: (process.env.BRIGHTDATA_API_KEY || '').trim(),
    /** Bright Data SERP zone name. Stage 0's primary provider; falls back to SerpAPI on error/timeout/empty/non-200. */
    zone: (process.env.BRIGHTDATA_ZONE || 'happyserp_api1').trim(),
  },
  serpApi: {
    /** SerpApi key — https://serpapi.com/manage-api-key */
    apiKey: (process.env.SERPAPI_API_KEY || '').trim(),
    /**
     * Weekly Monday 08:00 (server timezone). Override with SERPAPI_EVENTS_CRON.
     */
    cronSchedule: process.env.SERPAPI_EVENTS_CRON || '0 8 * * 1',
  },
  /** Deactivate past events in Sanity (isActive → false). Default daily 01:00. */
  eventsCleanup: {
    cronSchedule: process.env.EVENTS_CLEANUP_CRON || '0 1 * * *',
  },
  /**
   * SerpApi Google News → Phoenix local rewrite. Uses SERPAPI_API_KEY (same as events).
   * GOOGLE_NEWS_CRON / NEWS_API_CRON: default 10:00 daily.
   */
  googleNews: {
    cronSchedule:
      process.env.GOOGLE_NEWS_CRON || process.env.NEWS_API_CRON || '0 10 * * *',
    /** Stories to pull from SerpApi per run (max 20). */
    maxFetch: Math.min(
      20,
      Math.max(1, parseInt(process.env.GOOGLE_NEWS_MAX_FETCH || '20', 10) || 20)
    ),
    /** After AI scoring, publish at most this many Google News rewrites per run (1–10). */
    maxPublishPerRun: Math.min(
      10,
      Math.max(
        1,
        parseInt(process.env.GOOGLE_NEWS_MAX_PUBLISH || '10', 10) || 10
      )
    ),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUserId: parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '', 10),
    /** No trailing slash — avoids https://host//telegram/... when building webhook URL */
    webhookBaseUrl: (process.env.TELEGRAM_WEBHOOK_BASE_URL || '').replace(/\/+$/, ''),
    webhookPathSecret: process.env.TELEGRAM_WEBHOOK_PATH_SECRET || '',
    port: parseInt(process.env.PORT || '3000', 10),
  },
};

/** Full HTTPS URL Telegram should POST updates to (matches Express route). */
export function getTelegramWebhookFullUrl(): string {
  const base = config.telegram.webhookBaseUrl;
  const secret = config.telegram.webhookPathSecret;
  return `${base}/telegram/webhook/${secret}`;
}

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY',
  'SANITY_PROJECT_ID',
  'SANITY_API_TOKEN',
];

export function validateConfig(): void {
  const missing = requiredEnvVars.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }
}

export function validateTelegramBaseConfig(): void {
  const requiredTelegramVars = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_ID',
  ];

  const missing = requiredTelegramVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Telegram environment variables: ${missing.join(', ')}`
    );
  }

  if (!Number.isFinite(config.telegram.allowedUserId)) {
    throw new Error(
      'Invalid TELEGRAM_ALLOWED_USER_ID: must be a numeric Telegram user id'
    );
  }
}

export function validateTelegramConfig(): void {
  validateTelegramBaseConfig();

  const requiredWebhookVars = [
    'TELEGRAM_WEBHOOK_BASE_URL',
    'TELEGRAM_WEBHOOK_PATH_SECRET',
  ];

  const missingWebhookVars = requiredWebhookVars.filter((key) => !process.env[key]);
  if (missingWebhookVars.length > 0) {
    throw new Error(
      `Missing required Telegram webhook environment variables: ${missingWebhookVars.join(', ')}`
    );
  }

  if (!config.telegram.webhookBaseUrl.startsWith('https://')) {
    throw new Error(
      'Invalid TELEGRAM_WEBHOOK_BASE_URL: must start with https://'
    );
  }
}


import dotenv from 'dotenv';

dotenv.config();

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
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
  serpApi: {
    /** SerpApi key — https://serpapi.com/manage-api-key */
    apiKey: (process.env.SERPAPI_API_KEY || '').trim(),
    /**
     * Separate from article pipeline — default 14:15 so it runs after the default 14:00 pipeline tick.
     */
    cronSchedule: process.env.SERPAPI_EVENTS_CRON || '15 14 * * *',
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


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
  },
};

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


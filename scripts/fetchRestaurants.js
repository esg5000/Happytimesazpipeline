#!/usr/bin/env node
/**
 * Entry point named fetchRestaurants.js — loads TypeScript via ts-node (dev dependency).
 * Requires: SERPAPI_API_KEY, SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN
 */
require('ts-node/register');
const { runFetchRestaurants } = require('./fetchRestaurants.ts');

runFetchRestaurants().catch((err) => {
  console.error(err);
  process.exit(1);
});

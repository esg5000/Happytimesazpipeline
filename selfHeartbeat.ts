import axios from 'axios';

import { config } from './config';

/**
 * Render's free-tier web services spin down after 15 minutes with zero
 * inbound HTTP traffic. A long-running background job (discoverTopics'
 * Stage 0-2 pass on a bad Bright Data day, or the daily pipeline's
 * Stage 3+ Playwright-heavy run) can cross that window with nothing else
 * hitting the server in between, so the container gets killed mid-job —
 * no crash, no stack trace, just gone. Self-pinging the health route
 * while one of these jobs is in flight counts as inbound traffic and
 * resets Render's idle clock.
 */
const HEARTBEAT_INTERVAL_MS = 8 * 60 * 1000;
const PING_TIMEOUT_MS = 10_000;

let intervalHandle: NodeJS.Timeout | null = null;
let activeJobCount = 0;

/**
 * Render sets RENDER_EXTERNAL_URL automatically on web services. Falls back
 * to the Telegram webhook base URL (also a public HTTPS URL for this same
 * service, already configured) if that's unset for some reason.
 */
function resolveHeartbeatUrl(): string | null {
  const base = (process.env.RENDER_EXTERNAL_URL || config.telegram.webhookBaseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/health`;
}

async function pingSelf(): Promise<void> {
  const url = resolveHeartbeatUrl();
  if (!url) {
    console.warn(
      '[heartbeat] No public base URL configured (RENDER_EXTERNAL_URL / TELEGRAM_WEBHOOK_BASE_URL) — self-ping cannot reach the public endpoint, so it will not prevent Render free-tier spin-down.'
    );
    return;
  }
  try {
    await axios.get(url, { timeout: PING_TIMEOUT_MS });
    console.log(`[heartbeat] Self-ping ok (${url})`);
  } catch (e) {
    // Never throw — a failed keep-alive ping is not fatal to the job it's protecting.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[heartbeat] Self-ping failed (${url}): ${msg}`);
  }
}

/**
 * Ref-counted so two long-running jobs (e.g. a manual discoverTopics run
 * overlapping the scheduled daily pipeline) can be in flight at once without
 * one job's finish stopping the ping the other still needs. The interval
 * only starts on the first caller and only stops once every caller has
 * called stopHeartbeat() — genuine full-idle periods (nothing running)
 * still spin down as intended on the free tier.
 */
export function startHeartbeat(label: string): void {
  activeJobCount += 1;
  if (intervalHandle) return;
  console.log(
    `[heartbeat] Starting self-ping every ${HEARTBEAT_INTERVAL_MS / 60_000}min (triggered by: ${label})`
  );
  intervalHandle = setInterval(() => {
    void pingSelf();
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(label: string): void {
  activeJobCount = Math.max(0, activeJobCount - 1);
  if (activeJobCount === 0 && intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log(`[heartbeat] Stopped self-ping (last active job finished: ${label})`);
  }
}

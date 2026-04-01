import fs from 'fs';
import path from 'path';
import os from 'os';

import type { VisualStyle } from './utils/validator';

export type TelegramDraftSession = {
  section?: 'cannabis' | 'mushrooms' | 'nightlife' | 'food' | 'events' | 'global';
  title?: string;
  keywords?: string[];
  visualStyle?: VisualStyle;
  notes: string[];
  photoFileId?: string;
};

const sessionFile =
  process.env.TELEGRAM_SESSION_FILE ||
  path.join(os.tmpdir(), 'happytimes-telegram-sessions.json');

const cache = new Map<number, TelegramDraftSession>();

function parseSession(raw: unknown): TelegramDraftSession {
  if (!raw || typeof raw !== 'object') {
    return { notes: [] };
  }
  const o = raw as Record<string, unknown>;
  return {
    notes: Array.isArray(o.notes)
      ? (o.notes as unknown[]).map((x) => String(x))
      : [],
    section: o.section as TelegramDraftSession['section'],
    title: typeof o.title === 'string' ? o.title : undefined,
    keywords: Array.isArray(o.keywords)
      ? (o.keywords as unknown[]).map((x) => String(x))
      : undefined,
    visualStyle: o.visualStyle as VisualStyle | undefined,
    photoFileId: typeof o.photoFileId === 'string' ? o.photoFileId : undefined,
  };
}

/**
 * Load sessions from disk into memory (survives Render cold starts when /tmp or path persists).
 */
export function hydrateTelegramSessionsFromDisk(): void {
  try {
    if (!fs.existsSync(sessionFile)) return;
    const data = JSON.parse(
      fs.readFileSync(sessionFile, 'utf-8')
    ) as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      const id = Number(k);
      if (Number.isFinite(id)) {
        cache.set(id, parseSession(v));
      }
    }
    console.log(
      `[telegram-session] Loaded ${cache.size} draft(s) from ${sessionFile}`
    );
  } catch (e) {
    console.warn('[telegram-session] Could not load session file:', e);
  }
}

export function persistTelegramSessions(): void {
  try {
    const dir = path.dirname(sessionFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, TelegramDraftSession> = {};
    for (const [chatId, session] of cache) {
      obj[String(chatId)] = session;
    }
    const json = JSON.stringify(obj);
    const tmp = `${sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, sessionFile);
  } catch (e) {
    console.error('[telegram-session] Could not persist sessions:', e);
  }
}

export function getTelegramSession(chatId: number): TelegramDraftSession {
  if (!cache.has(chatId)) {
    cache.set(chatId, { notes: [] });
  }
  return cache.get(chatId)!;
}

export function resetTelegramSession(chatId: number): TelegramDraftSession {
  const created: TelegramDraftSession = { notes: [] };
  cache.set(chatId, created);
  persistTelegramSessions();
  return created;
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hydrateTelegramSessionsFromDisk = hydrateTelegramSessionsFromDisk;
exports.persistTelegramSessions = persistTelegramSessions;
exports.getTelegramSession = getTelegramSession;
exports.resetTelegramSession = resetTelegramSession;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const validator_1 = require("./utils/validator");
const sessionFile = process.env.TELEGRAM_SESSION_FILE ||
    path_1.default.join(os_1.default.tmpdir(), 'happytimes-telegram-sessions.json');
const cache = new Map();
function parseSession(raw) {
    if (!raw || typeof raw !== 'object') {
        return { notes: [] };
    }
    const o = raw;
    let section;
    if (typeof o.section === 'string') {
        const s = o.section.trim().toLowerCase();
        const migrated = s === 'mushrooms' || s === 'wellness' ? 'health-wellness' : s;
        section = validator_1.SECTION_SLUGS.includes(migrated)
            ? migrated
            : undefined;
    }
    return {
        notes: Array.isArray(o.notes)
            ? o.notes.map((x) => String(x))
            : [],
        section,
        title: typeof o.title === 'string' ? o.title : undefined,
        keywords: Array.isArray(o.keywords)
            ? o.keywords.map((x) => String(x))
            : undefined,
        visualStyle: o.visualStyle,
        photoFileId: typeof o.photoFileId === 'string' ? o.photoFileId : undefined,
        heroSanityAssetId: typeof o.heroSanityAssetId === 'string' ? o.heroSanityAssetId : undefined,
        recentUploadAssetIds: Array.isArray(o.recentUploadAssetIds)
            ? o.recentUploadAssetIds
                .map((x) => String(x))
                .filter(Boolean)
                .slice(0, 5)
            : undefined,
        pendingImageAssetIds: Array.isArray(o.pendingImageAssetIds)
            ? o.pendingImageAssetIds
                .map((x) => String(x))
                .filter(Boolean)
                .slice(0, 5)
            : undefined,
        draftVideoAssetId: typeof o.draftVideoAssetId === 'string' && o.draftVideoAssetId.trim()
            ? o.draftVideoAssetId.trim()
            : undefined,
        heroImageIndex: typeof o.heroImageIndex === 'number' && Number.isFinite(o.heroImageIndex)
            ? Math.trunc(o.heroImageIndex)
            : undefined,
    };
}
/**
 * Load sessions from disk into memory (survives Render cold starts when /tmp or path persists).
 */
function hydrateTelegramSessionsFromDisk() {
    try {
        if (!fs_1.default.existsSync(sessionFile))
            return;
        const data = JSON.parse(fs_1.default.readFileSync(sessionFile, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
            const id = Number(k);
            if (Number.isFinite(id)) {
                cache.set(id, parseSession(v));
            }
        }
        console.log(`[telegram-session] Loaded ${cache.size} draft(s) from ${sessionFile}`);
    }
    catch (e) {
        console.warn('[telegram-session] Could not load session file:', e);
    }
}
function persistTelegramSessions() {
    try {
        const dir = path_1.default.dirname(sessionFile);
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
        const obj = {};
        for (const [chatId, session] of cache) {
            obj[String(chatId)] = session;
        }
        const json = JSON.stringify(obj);
        const tmp = `${sessionFile}.${process.pid}.tmp`;
        fs_1.default.writeFileSync(tmp, json, 'utf-8');
        fs_1.default.renameSync(tmp, sessionFile);
    }
    catch (e) {
        console.error('[telegram-session] Could not persist sessions:', e);
    }
}
function getTelegramSession(chatId) {
    if (!cache.has(chatId)) {
        cache.set(chatId, { notes: [] });
    }
    return cache.get(chatId);
}
function resetTelegramSession(chatId) {
    const created = { notes: [] };
    cache.set(chatId, created);
    persistTelegramSessions();
    return created;
}
//# sourceMappingURL=telegramSessionStore.js.map
import { isSpiderCacheRoutePath } from './spiderRouteMatcher.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

const store = new Map();
const inflight = new Map();

function nowMs() {
    return Date.now();
}

function trimPathQuery(forwardPath) {
    const raw = typeof forwardPath === 'string' ? forwardPath.trim() : '';
    if (!raw) return '/';
    try {
        const u = new URL(raw, 'http://127.0.0.1');
        return String(u.pathname || '/');
    } catch (_) {
        const idx = raw.indexOf('?');
        return idx >= 0 ? raw.slice(0, idx) || '/' : raw;
    }
}

function normalizePayloadValue(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item) => normalizePayloadValue(item));
    if (typeof value === 'object') {
        const out = {};
        Object.keys(value)
            .sort()
            .forEach((key) => {
                const next = normalizePayloadValue(value[key]);
                if (next !== undefined) out[key] = next;
            });
        return out;
    }
    return value;
}

export function normalizePayloadForCache(body) {
    return JSON.stringify(normalizePayloadValue(body == null ? {} : body));
}

export function isEligibleSpiderCacheRequest(method, forwardPath) {
    const m = String(method || '').trim().toUpperCase();
    if (m !== 'POST') return false;
    const pathName = trimPathQuery(forwardPath);
    return isSpiderCacheRoutePath(pathName);
}

export function buildSpiderCacheKey({ runtimeId, forwardPath, method, body }) {
    const rid = String(runtimeId || '').trim().toLowerCase();
    const pathName = trimPathQuery(forwardPath);
    const m = String(method || '').trim().toUpperCase();
    const payload = normalizePayloadForCache(body);
    return `${rid}|${m}|${pathName}|${payload}`;
}

export function getSpiderCache(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (!hit.exp || hit.exp <= nowMs()) {
        store.delete(key);
        return null;
    }
    return hit.value || null;
}

function pruneSpiderCache(maxEntries = DEFAULT_MAX_ENTRIES) {
    const now = nowMs();
    for (const [key, value] of store.entries()) {
        if (!value || !value.exp || value.exp <= now) {
            store.delete(key);
        }
    }
    if (store.size <= maxEntries) return;
    const ordered = Array.from(store.entries()).sort((a, b) => {
        const av = a[1] && Number.isFinite(Number(a[1].exp)) ? Number(a[1].exp) : 0;
        const bv = b[1] && Number.isFinite(Number(b[1].exp)) ? Number(b[1].exp) : 0;
        if (av !== bv) return av - bv;
        const ac = a[1] && Number.isFinite(Number(a[1].createdAt)) ? Number(a[1].createdAt) : 0;
        const bc = b[1] && Number.isFinite(Number(b[1].createdAt)) ? Number(b[1].createdAt) : 0;
        return ac - bc;
    });
    const removeCount = Math.max(0, ordered.length - maxEntries);
    for (let i = 0; i < removeCount; i += 1) {
        store.delete(ordered[i][0]);
    }
}

export function setSpiderCache(key, entry, ttlMs = DEFAULT_TTL_MS) {
    const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(1, Math.trunc(Number(ttlMs))) : DEFAULT_TTL_MS;
    const now = nowMs();
    store.set(key, {
        exp: now + ttl,
        createdAt: now,
        value: entry,
    });
    pruneSpiderCache(DEFAULT_MAX_ENTRIES);
    return entry;
}

export async function getOrCreateSpiderCache(key, loader) {
    const cached = getSpiderCache(key);
    if (cached) return { hit: true, entry: cached };
    const running = inflight.get(key);
    if (running) {
        const awaited = await running;
        return { hit: false, entry: awaited };
    }
    const promise = (async () => {
        const loaded = await loader();
        const entry = loaded && typeof loaded === 'object' ? loaded.entry || null : null;
        const cacheable = !!(loaded && loaded.cacheable && entry);
        const ttlMs = loaded && Number.isFinite(Number(loaded.ttlMs)) ? Math.trunc(Number(loaded.ttlMs)) : DEFAULT_TTL_MS;
        if (cacheable) return setSpiderCache(key, entry, ttlMs);
        return entry;
    })().finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, promise);
    const awaited = await promise;
    return { hit: false, entry: awaited };
}

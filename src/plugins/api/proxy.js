import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import chunkStream from '../../util/chunk.js';
import { md5 } from '../../util/crypto-util.js';

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 24 * 3600;
const MIN_TTL_SECONDS = 30;
const MAX_URL_LEN = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

function nowMs() {
  return Date.now();
}

function safeTrim(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isHttpUrl(u) {
  try {
    const p = new URL(String(u || ''));
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHttpUrl(u) {
  const raw = safeTrim(u);
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function normalizeHeaders(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [k0, v0] of Object.entries(src)) {
    const k = safeTrim(k0);
    if (!k || v0 == null) continue;
    const v = safeTrim(String(v0));
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function ensureStore(fastify) {
  if (!fastify.proxyTokenStore) fastify.proxyTokenStore = new Map();
  return fastify.proxyTokenStore;
}

function sweepExpired(store) {
  const t = nowMs();
  for (const [k, v] of store.entries()) {
    if (!v || !v.expiresAt || v.expiresAt <= t) store.delete(k);
  }
}

function getSession(store, token) {
  sweepExpired(store);
  const s = store.get(token);
  if (!s) return null;
  if (s.expiresAt <= nowMs()) {
    store.delete(token);
    return null;
  }
  return s;
}

function apiError(reply, status, message) {
  reply.code(status);
  return { ok: false, message: String(message || 'error') };
}

function resolveRuntimeRootDir() {
  try {
    if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
      return path.dirname(process.execPath);
    }
  } catch (_) {}
  try {
    const envRoot = typeof process.env.NODE_PATH === 'string' ? process.env.NODE_PATH.trim() : '';
    if (envRoot) return path.resolve(envRoot);
  } catch (_) {}
  return process.cwd();
}

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw && raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function isProxyDisabled() {
  try {
    const cfgPath = path.resolve(resolveRuntimeRootDir(), 'config.json');
    const cfg = readJsonFileSafe(cfgPath);
    return !!(cfg && cfg.disable_proxy);
  } catch (_) {
    return false;
  }
}

const apiPlugins = [
  {
    prefix: '/api/proxy',
    plugin: async function proxyApi(fastify) {
      const store = ensureStore(fastify);

      fastify.post('/register', async function registerProxy(request, reply) {
        if (isProxyDisabled()) return apiError(reply, 403, 'proxy disabled');
        const body = request && request.body && typeof request.body === 'object' ? request.body : {};
        const upstreamUrl = normalizeHttpUrl(body && body.url);
        if (!upstreamUrl) return apiError(reply, 400, 'missing url');
        if (upstreamUrl.length > MAX_URL_LEN) return apiError(reply, 400, 'url too long');
        if (!isHttpUrl(upstreamUrl)) return apiError(reply, 400, 'invalid url');

        const ttlIn = Number(body && body.ttlSeconds);
        const ttlSeconds = Number.isFinite(ttlIn)
          ? Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.trunc(ttlIn)))
          : DEFAULT_TTL_SECONDS;
        const headers = normalizeHeaders(body && body.headers);

        const token = crypto.randomBytes(12).toString('hex');
        const createdAt = nowMs();
        store.set(token, {
          token,
          url: upstreamUrl,
          headers,
          createdAt,
          expiresAt: createdAt + ttlSeconds * 1000,
        });

        return {
          ok: true,
          token,
          proxy: `/api/proxy/${encodeURIComponent(token)}`,
          expiresAt: createdAt + ttlSeconds * 1000,
        };
      });

      fastify.get('/:token', async function proxyByToken(request, reply) {
        if (isProxyDisabled()) return apiError(reply, 403, 'proxy disabled');
        const token = safeTrim(request && request.params ? request.params.token : '');
        if (!token) return apiError(reply, 404, 'not found');
        const session = getSession(store, token);
        if (!session) return apiError(reply, 404, 'not found');
        const query = request && request.query && typeof request.query === 'object' ? request.query : {};
        const threadRaw = Number.parseInt(String(query.thread ?? ''), 10);
        const chunkSizeRaw = Number.parseInt(String(query.chunkSize ?? ''), 10);
        const timeoutRaw = Number.parseInt(String(query.timeout ?? ''), 10);
        const option = {
          chunkSize: Number.isFinite(chunkSizeRaw) && chunkSizeRaw > 0 ? 1024 * chunkSizeRaw : 1024 * 256,
          poolSize: Number.isFinite(threadRaw) && threadRaw > 0 ? threadRaw : 10,
          timeout: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
        };
        const urlKey = md5(`${String(session.url || '')}|${token}`);
        return await chunkStream(request, reply, String(session.url || ''), urlKey, { ...(session.headers || {}) }, option);
      });
    },
  },
];

export { apiPlugins };
export default apiPlugins;

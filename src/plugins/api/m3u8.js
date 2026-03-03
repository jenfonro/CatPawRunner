import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_URL_LEN = 8 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 5;

function nowMs() {
  return Date.now();
}

function safeTrim(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeHeaders(input) {
  const h = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [k0, v0] of Object.entries(h)) {
    const k = safeTrim(k0);
    if (!k) continue;
    if (v0 == null) continue;
    const v = safeTrim(String(v0));
    if (!v) continue;
    out[k] = v;
  }
  return out;
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHttpUrl(u) {
  const raw = safeTrim(u);
  if (!raw) return '';
  try {
    // Ensure a WHATWG-normalized, ASCII-safe URL string (percent-encoded pathname/query).
    const p = new URL(raw);
    return p.toString();
  } catch {
    return raw;
  }
}

function resolveRuntimeRootDir() {
  try {
    if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
      return path.dirname(process.execPath);
    }
  } catch {}
  try {
    const envRoot = typeof process.env.NODE_PATH === 'string' ? process.env.NODE_PATH.trim() : '';
    if (envRoot) return path.resolve(envRoot);
  } catch {}
  return process.cwd();
}

function readConfigJsonSafe() {
  try {
    const rootDir = resolveRuntimeRootDir();
    const cfgPath = path.resolve(rootDir, 'config.json');
    if (!fs.existsSync(cfgPath)) return {};
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = raw && raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pickForwardedFirst(value) {
  if (typeof value !== 'string') return '';
  const first = value.split(',')[0];
  return String(first || '').trim();
}

function getExternalOriginFromRequest(request) {
  const headers = (request && request.headers) || {};
  const proto = pickForwardedFirst(headers['x-forwarded-proto']) || '';
  const scheme = proto === 'https' || proto === 'http' ? proto : 'http';

  const xfHost = pickForwardedFirst(headers['x-forwarded-host']);
  const hHost = String(headers.host || '').trim();
  const xfPort = pickForwardedFirst(headers['x-forwarded-port']);

  // Prefer forwarded host, but do not accidentally drop an explicit port.
  // Common nginx config sets `X-Forwarded-Host $host` (no port) while `Host $http_host` includes the port.
  let host = xfHost || hHost;
  if (host && !String(host).includes(':') && hHost && hHost.includes(':')) {
    host = hHost;
  } else if (host && !String(host).includes(':') && xfPort) {
    const port = String(xfPort).trim();
    if (port && /^\d+$/.test(port)) {
      const isDefault = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
      if (!isDefault) host = `${host}:${port}`;
    }
  }

  if (!host) return '';
  return `${scheme}://${host}`;
}

function decodeQueryUrl(raw) {
  const s = safeTrim(String(raw || ''));
  if (!s) return '';
  // Fastify usually decodes query values, but keep it safe for double-encoded inputs.
  let v = s;
  try {
    v = decodeURIComponent(v);
  } catch {}
  return v;
}

function toNodeReadable(body) {
  if (!body) return null;
  // undici fetch: body is a WHATWG ReadableStream
  if (typeof body.getReader === 'function' && typeof Readable.fromWeb === 'function') {
    return Readable.fromWeb(body);
  }
  // node stream
  if (typeof body.pipe === 'function') return body;
  return null;
}

function withTimeout(ms, fn) {
  const timeoutMs = Number.isFinite(Number(ms)) ? Math.max(200, Math.trunc(Number(ms))) : DEFAULT_HTTP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    Promise.resolve()
      .then(fn)
      .then((v) => resolve(v))
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function requestOnce(urlStr, { method, headers } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(String(urlStr || ''));
    } catch {
      reject(new Error('invalid url'));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: method || 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname || '/'}${u.search || ''}`,
        headers: headers || {},
      },
      (res) => resolve({ u, res })
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpRequestFollow(urlStr, { method, headers, timeoutMs } = {}) {
  let current = String(urlStr || '');
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const { u, res } = await withTimeout(timeoutMs, () => requestOnce(current, { method, headers }));
    const status = Number(res.statusCode || 0);
    const loc = res.headers && (res.headers.location || res.headers.Location);
    if (status >= 300 && status < 400 && loc) {
      try {
        const next = new URL(String(loc), u).toString();
        res.resume();
        current = next;
        continue;
      } catch {}
    }
    return { url: current, res };
  }
  throw new Error('too many redirects');
}

async function readAll(res) {
  const chunks = [];
  for await (const c of res) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function ensureStore(fastify) {
  if (!fastify) return null;
  if (!fastify.m3u8Store) {
    fastify.m3u8Store = new Map();
  }
  return fastify.m3u8Store;
}

function sweepExpired(store) {
  if (!store || typeof store.forEach !== 'function') return;
  const t = nowMs();
  for (const [k, v] of store.entries()) {
    if (!v || !v.expiresAt || v.expiresAt <= t) store.delete(k);
  }
}

function getSession(store, token) {
  if (!store) return null;
  sweepExpired(store);
  const s = store.get(token);
  if (!s) return null;
  if (s.expiresAt && s.expiresAt <= nowMs()) {
    store.delete(token);
    return null;
  }
  return s;
}

function parseAttributeUri(tagLine) {
  // Extract URI="..." (first occurrence)
  const m = /URI\s*=\s*"([^"]+)"/i.exec(String(tagLine || ''));
  return m && m[1] ? String(m[1]) : '';
}

function replaceAttributeUri(tagLine, nextUri) {
  const line = String(tagLine || '');
  if (!line) return line;
  if (!/URI\s*=\s*"/i.test(line)) return line;
  return line.replace(/URI\s*=\s*"([^"]*)"/i, (_all, _v) => `URI="${nextUri}"`);
}

function absolutizeMaybe(uri, baseUrl) {
  const u = safeTrim(uri);
  if (!u) return '';
  try {
    return new URL(u, baseUrl).toString();
  } catch {
    return u;
  }
}

function classifyUriKind(absUrl) {
  const s = safeTrim(absUrl);
  if (!s) return 'seg';
  try {
    const u = new URL(s);
    const p = String(u.pathname || '').toLowerCase();
    if (p.endsWith('.m3u8')) return 'pl';
  } catch {}
  return 'seg';
}

function buildProxyPath(token, kind, absUrl) {
  const enc = encodeURIComponent(absUrl);
  if (kind === 'key') return `/api/m3u8/${encodeURIComponent(token)}/key?u=${enc}`;
  if (kind === 'pl') return `/api/m3u8/${encodeURIComponent(token)}/pl?u=${enc}`;
  return `/api/m3u8/${encodeURIComponent(token)}/seg?u=${enc}`;
}

function normalizeGoProxyApiBase(input) {
  const raw = safeTrim(input);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      u.hash = '';
      u.search = '';
      const p = u.pathname || '/';
      u.pathname = p.endsWith('/') ? p : `${p}/`;
      return u.toString();
    } catch {
      return raw;
    }
  }
  if (raw.startsWith('/')) return raw.replace(/\/+$/g, '') || '/';
  return '';
}

function resolveGoProxyBases(request, cfg) {
  const root = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const q = request && request.query && typeof request.query === 'object' ? request.query : {};
  // Allow per-request override for GoProxy base (useful when multiple GoProxy servers exist).
  // This is intentionally scoped to m3u8 proxy endpoints only.
  const overrideRaw =
    safeTrim(q.__tv_go) ||
    safeTrim(q.tv_go) ||
    safeTrim(q.goproxy) ||
    safeTrim(q.goProxy) ||
    '';
  const override = normalizeGoProxyApiBase(overrideRaw);
  const api = override || normalizeGoProxyApiBase(root.goProxyApi);
  if (!api) return { enabled: false, internalBase: '', publicBase: '' };

  if (/^https?:\/\//i.test(api)) {
    const base = api.replace(/\/+$/g, '');
    return { enabled: true, internalBase: `${base}/`, publicBase: `${base}/` };
  }

  const origin = getExternalOriginFromRequest(request);
  if (!origin) return { enabled: false, internalBase: '', publicBase: '' };
  const base = `${origin}${api}`.replace(/\/+$/g, '');
  return { enabled: true, internalBase: `${base}/`, publicBase: `${base}/` };
}

function headersMapToList(headers) {
  const h = normalizeHeaders(headers);
  const out = [];
  Object.keys(h).forEach((k) => {
    out.push({ key: k, value: String(h[k] || '') });
  });
  return out;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(200, Math.trunc(Number(timeoutMs))) : 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { ...(options || {}), signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  } finally {
    clearTimeout(timer);
  }
}

async function registerGoProxy(internalBase, upstreamUrl, headers) {
  const base = safeTrim(internalBase).replace(/\/+$/g, '');
  if (!base) throw new Error('missing goproxy base');
  const url = `${base}/register`;
  const { resp, data } = await fetchJsonWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, headersList: headersMapToList(headers) }),
    },
    3000
  );
  if (!resp.ok) {
    const msg = data && (data.message || data.error) ? String(data.message || data.error) : `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  const token = data && data.token ? String(data.token).trim() : '';
  if (!token) throw new Error('missing goproxy token');
  return token;
}

function buildGoProxyBinaryUrl(publicBase, goToken, kind, absUrl) {
  const base = safeTrim(publicBase).replace(/\/+$/g, '');
  const tok = safeTrim(goToken);
  if (!base || !tok) return '';
  const enc = encodeURIComponent(absUrl);
  const p = kind === 'key' ? 'key' : 'seg';
  return `${base}/${encodeURIComponent(tok)}/${p}?u=${enc}`;
}

function rewritePlaylistProxy(text, { token, baseUrl, go, goToken }) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-(KEY|SESSION-KEY)\b/i.test(trimmed) && /URI\s*=\s*"/i.test(trimmed)) {
        const uri = parseAttributeUri(trimmed);
        const abs = uri ? absolutizeMaybe(uri, baseUrl) : '';
        if (abs && go && go.enabled && goToken) {
          out.push(replaceAttributeUri(line, buildGoProxyBinaryUrl(go.publicBase, goToken, 'key', abs) || buildProxyPath(token, 'key', abs)));
        } else if (abs) {
          out.push(replaceAttributeUri(line, buildProxyPath(token, 'key', abs)));
        } else {
          out.push(line);
        }
        continue;
      }
      if (/^#EXT-X-MAP\b/i.test(trimmed) && /URI\s*=\s*"/i.test(trimmed)) {
        const uri = parseAttributeUri(trimmed);
        const abs = uri ? absolutizeMaybe(uri, baseUrl) : '';
        if (abs && go && go.enabled && goToken) {
          out.push(replaceAttributeUri(line, buildGoProxyBinaryUrl(go.publicBase, goToken, 'seg', abs) || buildProxyPath(token, 'seg', abs)));
        } else if (abs) {
          out.push(replaceAttributeUri(line, buildProxyPath(token, 'seg', abs)));
        } else {
          out.push(line);
        }
        continue;
      }
      if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed) && /URI\s*=\s*"/i.test(trimmed)) {
        const uri = parseAttributeUri(trimmed);
        const abs = uri ? absolutizeMaybe(uri, baseUrl) : '';
        if (abs) out.push(replaceAttributeUri(line, buildProxyPath(token, 'pl', abs)));
        else out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }

    const abs = absolutizeMaybe(trimmed, baseUrl);
    if (!abs) {
      out.push(trimmed);
      continue;
    }
    if (String(abs).toLowerCase().endsWith('.m3u8')) {
      out.push(buildProxyPath(token, 'pl', abs));
      continue;
    }
    if (go && go.enabled && goToken) {
      out.push(buildGoProxyBinaryUrl(go.publicBase, goToken, 'seg', abs) || buildProxyPath(token, 'seg', abs));
    } else {
      out.push(buildProxyPath(token, 'seg', abs));
    }
  }

  return out.join('\n');
}

function rewritePlaylistText(text, { token, baseUrl, mode }) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      // Tags with URI="..."
      if (/^#EXT-X-(KEY|SESSION-KEY|MAP|MEDIA|I-FRAME-STREAM-INF)\b/i.test(trimmed) && /URI\s*=\s*"/i.test(trimmed)) {
        const uri = parseAttributeUri(trimmed);
        const abs = uri ? absolutizeMaybe(uri, baseUrl) : '';
        if (mode === 'proxy') {
          const kind = /^#EXT-X-(KEY|SESSION-KEY|MAP)\b/i.test(trimmed) ? 'key' : 'pl';
          const nextUri = abs ? buildProxyPath(token, kind, abs) : uri;
          out.push(replaceAttributeUri(line, nextUri));
        } else {
          // index mode: keep "original" but normalize to absolute so the client can resolve correctly.
          const nextUri = abs || uri;
          out.push(replaceAttributeUri(line, nextUri));
        }
        continue;
      }
      out.push(line);
      continue;
    }

    // URI line (segment or playlist)
    const abs = absolutizeMaybe(trimmed, baseUrl);
    if (mode === 'proxy') {
      const kind = classifyUriKind(abs);
      out.push(buildProxyPath(token, kind, abs));
    } else {
      out.push(abs || trimmed);
    }
  }

  return out.join('\n');
}

async function fetchUpstreamText(url, headers) {
  // Use Node's http/https client to avoid undici header parsing errors
  // when upstream returns non-ASCII header values (e.g. Content-Disposition filenames).
  const { res } = await httpRequestFollow(url, { method: 'GET', headers, timeoutMs: DEFAULT_HTTP_TIMEOUT_MS });
  const buf = await readAll(res);
  const text = Buffer.from(buf).toString('utf8');
  return { res, text };
}

function buildUpstreamHeaders(sessionHeaders, request) {
  const out = { ...normalizeHeaders(sessionHeaders) };
  // Forward some safe headers from client (Range/If-Range) at proxy endpoints.
  const h = request && request.headers ? request.headers : {};
  const range = h.range || h.Range || '';
  const ifRange = h['if-range'] || h['If-Range'] || '';
  if (range) out.Range = String(range);
  if (ifRange) out['If-Range'] = String(ifRange);
  return out;
}

function copyUpstreamResponseHeaders(reply, upstreamHeaders, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const stripContentLength = !!options.stripContentLength;
  const stripContentEncoding = !!options.stripContentEncoding;
  const deny = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
  ]);
  const expose = [];
  const iter =
    upstreamHeaders && typeof upstreamHeaders.entries === 'function'
      ? upstreamHeaders.entries()
      : Object.entries((upstreamHeaders && typeof upstreamHeaders === 'object' ? upstreamHeaders : {}) || {});
  for (const [k, v0] of iter) {
    const key = String(k || '').toLowerCase();
    if (!key || deny.has(key)) continue;
    if (stripContentLength && key === 'content-length') continue;
    if (stripContentEncoding && key === 'content-encoding') continue;
    const v = Array.isArray(v0) ? v0.join(', ') : v0;
    try {
      reply.header(k, v);
      if (
        key === 'accept-ranges' ||
        key === 'content-range' ||
        key === 'content-length' ||
        key === 'content-type' ||
        key === 'etag' ||
        key === 'last-modified'
      ) {
        expose.push(k);
      }
    } catch {}
  }
  // Ensure range-related headers are readable by browsers (HLS engines).
  const baseExpose = ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'ETag', 'Last-Modified'];
  const merged = Array.from(new Set([...baseExpose, ...expose]));
  try {
    reply.header('Access-Control-Expose-Headers', merged.join(', '));
  } catch {}
}

function apiError(reply, status, message) {
  reply.code(status);
  return { ok: false, message: String(message || 'error') };
}

const apiPlugins = [
  {
    prefix: '/api/m3u8',
    plugin: async function m3u8Api(fastify) {
      const store = ensureStore(fastify);
      const cfgCache = { t: 0, v: {} };
      const readCfg = () => {
        const now = nowMs();
        if (cfgCache.v && now-cfgCache.t < 1000) return cfgCache.v;
        cfgCache.v = readConfigJsonSafe();
        cfgCache.t = now;
        return cfgCache.v;
      };

      fastify.post('/register', async function (request, reply) {
        const body = request && request.body && typeof request.body === 'object' ? request.body : {};
        const upstreamUrlRaw = safeTrim(body && body.url);
        const upstreamUrl = normalizeHttpUrl(upstreamUrlRaw);
        if (!upstreamUrl) return apiError(reply, 400, 'missing url');
        if (upstreamUrl.length > MAX_URL_LEN) return apiError(reply, 400, 'url too long');
        if (!isHttpUrl(upstreamUrl)) return apiError(reply, 400, 'invalid url');

        const ttl = Number(body && body.ttlSeconds) || DEFAULT_TTL_SECONDS;
        const ttlSeconds = Math.max(30, Math.min(24 * 3600, ttl));
        const headers = normalizeHeaders(body && body.headers);

        const token = crypto.randomBytes(12).toString('hex');
        const createdAt = nowMs();
          store.set(token, {
            token,
            upstreamUrl,
            headers,
            createdAt,
            expiresAt: createdAt + ttlSeconds * 1000,
            goProxyToken: '',
            goProxyBase: '',
          });

        return {
          ok: true,
          token,
          index: `/api/m3u8/${encodeURIComponent(token)}/index.m3u8`,
          proxy: `/api/m3u8/${encodeURIComponent(token)}/proxy.m3u8`,
        };
      });

      // Return "original sources" playlist (not proxied), but normalize all URIs to absolute
      // so hls.js can resolve segments correctly even when this playlist is served from catpawrunner.
      fastify.get('/:token/index.m3u8', async function (request, reply) {
        const token = safeTrim(request && request.params ? request.params.token : '');
        if (!token) return apiError(reply, 404, 'not found');
        const session = getSession(store, token);
        if (!session) return apiError(reply, 404, 'not found');

        const { res, text } = await fetchUpstreamText(session.upstreamUrl, session.headers);
        reply.code(res.statusCode || res.status || 200);
        reply.type('application/vnd.apple.mpegurl; charset=utf-8');
        // Avoid injecting raw upstream URL into headers: non-ASCII characters can crash Node's header validator.
        const normalized = rewritePlaylistText(text, { token, baseUrl: session.upstreamUrl, mode: 'index' });
        return normalized;
      });

      // Return proxied playlist (segments/key/child playlists are rewritten to catpawrunner proxy endpoints).
      fastify.get('/:token/proxy.m3u8', async function (request, reply) {
        const token = safeTrim(request && request.params ? request.params.token : '');
        if (!token) return apiError(reply, 404, 'not found');
        const session = getSession(store, token);
        if (!session) return apiError(reply, 404, 'not found');

        const cfg = readCfg();
        const go = resolveGoProxyBases(request, cfg);
        try {
          reply.header('X-GoProxy-Enabled', go.enabled ? '1' : '0');
        } catch {}
        if (go.enabled && session.goProxyBase && session.goProxyBase !== go.internalBase) {
          session.goProxyToken = '';
        }
        session.goProxyBase = go.enabled ? String(go.internalBase || '') : '';
        if (go.enabled && !session.goProxyToken) {
          try {
            fastify.log.info(
              {
                goProxyApi: typeof cfg.goProxyApi === 'string' ? cfg.goProxyApi : '',
                internalBase: go.internalBase,
                publicBase: go.publicBase,
                registerUrl: `${String(go.internalBase || '').replace(/\/+$/g, '')}/register`,
                requestHost: request && request.headers ? request.headers.host : '',
                forwardedProto: request && request.headers ? request.headers['x-forwarded-proto'] : '',
                forwardedHost: request && request.headers ? request.headers['x-forwarded-host'] : '',
              },
              '[m3u8] goproxy register (proxy.m3u8)'
            );
          } catch {}
          try {
            session.goProxyToken = await registerGoProxy(go.internalBase, session.upstreamUrl, session.headers);
          } catch (_e) {
            try {
              fastify.log.warn({ err: _e }, '[m3u8] goproxy register failed (proxy.m3u8)');
            } catch {}
            session.goProxyToken = '';
          }
        }
        try {
          reply.header('X-GoProxy-Token', session.goProxyToken ? '1' : '0');
        } catch {}

        const { res, text } = await fetchUpstreamText(session.upstreamUrl, session.headers);
        reply.code(res.statusCode || res.status || 200);
        reply.type('application/vnd.apple.mpegurl; charset=utf-8');
        const rewritten = rewritePlaylistProxy(text, { token, baseUrl: session.upstreamUrl, go, goToken: session.goProxyToken });
        return rewritten;
      });

      // Proxy a child playlist (multi-level m3u8). Response is also rewritten.
      fastify.get('/:token/pl', async function (request, reply) {
        const token = safeTrim(request && request.params ? request.params.token : '');
        if (!token) return apiError(reply, 404, 'not found');
        const session = getSession(store, token);
        if (!session) return apiError(reply, 404, 'not found');
        const u = decodeQueryUrl(request && request.query ? request.query.u : '');
        if (!u) return apiError(reply, 400, 'missing u');
        if (u.length > MAX_URL_LEN) return apiError(reply, 400, 'u too long');
        if (!isHttpUrl(u)) return apiError(reply, 400, 'invalid u');

        const cfg = readCfg();
        const go = resolveGoProxyBases(request, cfg);
        try {
          reply.header('X-GoProxy-Enabled', go.enabled ? '1' : '0');
        } catch {}
        if (go.enabled && session.goProxyBase && session.goProxyBase !== go.internalBase) {
          session.goProxyToken = '';
        }
        session.goProxyBase = go.enabled ? String(go.internalBase || '') : '';
        if (go.enabled && !session.goProxyToken) {
          try {
            fastify.log.info(
              {
                goProxyApi: typeof cfg.goProxyApi === 'string' ? cfg.goProxyApi : '',
                internalBase: go.internalBase,
                publicBase: go.publicBase,
                registerUrl: `${String(go.internalBase || '').replace(/\/+$/g, '')}/register`,
                requestHost: request && request.headers ? request.headers.host : '',
                forwardedProto: request && request.headers ? request.headers['x-forwarded-proto'] : '',
                forwardedHost: request && request.headers ? request.headers['x-forwarded-host'] : '',
              },
              '[m3u8] goproxy register (pl)'
            );
          } catch {}
          try {
            session.goProxyToken = await registerGoProxy(go.internalBase, session.upstreamUrl, session.headers);
          } catch (_e) {
            try {
              fastify.log.warn({ err: _e }, '[m3u8] goproxy register failed (pl)');
            } catch {}
            session.goProxyToken = '';
          }
        }
        try {
          reply.header('X-GoProxy-Token', session.goProxyToken ? '1' : '0');
        } catch {}

        const { res, text } = await fetchUpstreamText(u, session.headers);
        reply.code(res.statusCode || res.status || 200);
        reply.type('application/vnd.apple.mpegurl; charset=utf-8');
        const rewritten = rewritePlaylistProxy(text, { token, baseUrl: u, go, goToken: session.goProxyToken });
        return rewritten;
      });

      // Proxy a segment (ts/m4s...) or key file. Supports Range by forwarding request's Range/If-Range.
      const proxyBinary = async (request, reply, kind) => {
        const token = safeTrim(request && request.params ? request.params.token : '');
        if (!token) return apiError(reply, 404, 'not found');
        const session = getSession(store, token);
        if (!session) return apiError(reply, 404, 'not found');
        const u = decodeQueryUrl(request && request.query ? request.query.u : '');
        if (!u) return apiError(reply, 400, 'missing u');
        if (u.length > MAX_URL_LEN) return apiError(reply, 400, 'u too long');
        if (!isHttpUrl(u)) return apiError(reply, 400, 'invalid u');

        const headers = buildUpstreamHeaders(session.headers, request);
        // Avoid transparent decompression by undici (Node fetch) which can cause Content-Length mismatches.
        // For binary segments/keys, always request identity encoding.
        if (!Object.keys(headers).some((k) => String(k).toLowerCase() === 'accept-encoding')) {
          headers['Accept-Encoding'] = 'identity';
        }
        const { res } = await httpRequestFollow(u, { method: 'GET', headers, timeoutMs: DEFAULT_HTTP_TIMEOUT_MS });
        reply.code(res.statusCode || 200);
        // When streaming, do not forward Content-Length/Encoding (Fastify will stream chunked),
        // otherwise browsers may throw ERR_CONTENT_LENGTH_MISMATCH.
        copyUpstreamResponseHeaders(reply, res.headers || {}, { stripContentLength: true, stripContentEncoding: true });
        if (!reply.getHeader || !reply.getHeader('Content-Type')) {
          try {
            if (kind === 'key') reply.type('application/octet-stream');
          } catch {}
        }
        return reply.send(res);
      };

      fastify.get('/:token/seg', async function (request, reply) {
        return await proxyBinary(request, reply, 'seg');
      });
      fastify.get('/:token/key', async function (request, reply) {
        return await proxyBinary(request, reply, 'key');
      });
    },
  },
];

export { apiPlugins };
export default apiPlugins;

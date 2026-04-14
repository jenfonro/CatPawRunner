import * as cfg from './index.config.js';
import {md5} from "./util/crypto-util.js";
import chunkStream from "./util/chunk.js";
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import apiPlugins from './plugins/api/index.js';
import {
    buildSpiderCacheKey,
    getOrCreateSpiderCache,
    isEligibleSpiderCacheRequest,
} from './util/runtimeSpiderCache.js';
import { rewritePanmockDetailPayloadFields } from './util/panmockDetailCodec.js';
import { isSpiderCacheRoutePath } from './util/spiderRouteMatcher.js';

const spiderPrefix = '/spider';

function pickForwardedFirst(value) {
    if (typeof value !== 'string') return '';
    const first = value.split(',')[0];
    return String(first || '').trim();
}

function getExternalOriginFromRequest(request) {
    const headers = (request && request.headers) || {};
    const proto = pickForwardedFirst(headers['x-forwarded-proto']) || '';
    const host = pickForwardedFirst(headers['x-forwarded-host']) || String(headers.host || '').trim();
    if (!host) return '';
    const scheme = proto === 'https' || proto === 'http' ? proto : 'http';
    return `${scheme}://${host}`;
}

function parseCookieHeader(cookieHeader) {
    const out = {};
    const raw = typeof cookieHeader === 'string' ? cookieHeader : '';
    if (!raw) return out;
    raw.split(';').forEach((part) => {
        const p = String(part || '').trim();
        if (!p) return;
        const i = p.indexOf('=');
        if (i <= 0) return;
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        if (!k) return;
        out[k] = v;
    });
    return out;
}

function extractRuntimeIDFromReferer(refererRaw) {
    const raw = typeof refererRaw === 'string' ? refererRaw.trim() : '';
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const p = String(u.pathname || '');
        const m = /^\/([a-f0-9]{10})\/website(?:\/|$)/i.exec(p);
        return m && m[1] ? String(m[1]).toLowerCase() : '';
    } catch (_) {
        return '';
    }
}

function splitRawUrl(rawUrl) {
    const raw = typeof rawUrl === 'string' && rawUrl ? rawUrl : '/';
    const idx = raw.indexOf('?');
    if (idx < 0) return {path: raw, query: ''};
    return {path: raw.slice(0, idx), query: raw.slice(idx)};
}

function stripPrefixFromRawPath(rawPath, prefixPath) {
    const path = typeof rawPath === 'string' && rawPath ? rawPath : '/';
    const prefix = typeof prefixPath === 'string' ? prefixPath : '';
    if (!prefix) return '';
    if (path === prefix) return '';
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
    return '';
}

function rewriteLocalUrlToExternal(url, externalOrigin, idPrefix, allowedPorts) {
    if (!externalOrigin || typeof url !== 'string') return url;
    const raw = url.trim();
    if (!raw) return url;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return url;
    }
    const host = String(parsed.hostname || '').toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0') return url;
    const port = Number(parsed.port || 0);
    if (Array.isArray(allowedPorts) && allowedPorts.length && port) {
        if (!allowedPorts.some((p) => Number(p) === port)) return url;
    }
    const pathName = String(parsed.pathname || '');
    if (!pathName.startsWith('/')) return url;
    const prefix = idPrefix ? `/${String(idPrefix).trim()}` : '';
    const withId = prefix && !pathName.startsWith(`${prefix}/`) && pathName !== prefix ? `${prefix}${pathName}` : pathName;
    return `${externalOrigin}${withId}${parsed.search || ''}${parsed.hash || ''}`;
}

function rewriteLocalUrlsDeep(value, externalOrigin, idPrefix, allowedPorts) {
    const seen = new WeakSet();
    const walk = (node) => {
        if (typeof node === 'string') return rewriteLocalUrlToExternal(node, externalOrigin, idPrefix, allowedPorts);
        if (!node || typeof node !== 'object') return node;
        if (seen.has(node)) return node;
        seen.add(node);
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) node[i] = walk(node[i]);
            return node;
        }
        Object.keys(node).forEach((k) => {
            node[k] = walk(node[k]);
        });
        return node;
    };
    return walk(value);
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

function readConfigJsonSafe(configPath) {
    try {
        if (!configPath || !fs.existsSync(configPath)) return {};
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = raw && raw.trim() ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function isPanMockEnabled() {
    try {
        const runtimeRoot = resolveRuntimeRootDir();
        const cfgPath = path.resolve(runtimeRoot, 'config.json');
        const cfgRoot = readConfigJsonSafe(cfgPath);
        return !!(cfgRoot && cfgRoot.pan_mock);
    } catch (_) {
        return false;
    }
}

function isProxyDisabled() {
    try {
        const runtimeRoot = resolveRuntimeRootDir();
        const cfgPath = path.resolve(runtimeRoot, 'config.json');
        const cfgRoot = readConfigJsonSafe(cfgPath);
        return !!(cfgRoot && cfgRoot.disable_proxy);
    } catch (_) {
        return false;
    }
}

function readPanBuiltinResolverEnabledFromConfigRoot(root) {
    const cfgRoot = root && typeof root === 'object' && !Array.isArray(root) ? root : {};
    if (Object.prototype.hasOwnProperty.call(cfgRoot, 'panResolver') && typeof cfgRoot.panResolver === 'boolean') return cfgRoot.panResolver;
    if (Object.prototype.hasOwnProperty.call(cfgRoot, 'panBuiltinResolverEnabled')) return !!cfgRoot.panBuiltinResolverEnabled;
    return false;
}

function pickFirstHeaderValue(value) {
    if (typeof value !== 'string') return '';
    const first = value.split(',')[0];
    return String(first || '').trim();
}

function getTvUserFromRequest(request) {
    const headers = (request && request.headers) || {};
    const v = headers['x-tv-user'] || headers['X-TV-User'] || '';
    return pickFirstHeaderValue(String(v || '').trim());
}

function parseJsonSafe(text) {
    try {
        const t = typeof text === 'string' ? text : '';
        return t && t.trim() ? JSON.parse(t) : {};
    } catch (_) {
        return null;
    }
}

function extractBuiltinPanFlagToken(flag) {
    const raw = String(flag || '').trim();
    if (!raw || !raw.includes('-')) return '';
    return String(raw.split('-')[0] || '').trim().toLowerCase();
}

function isBaiduFlag(flag) {
    return extractBuiltinPanFlagToken(flag) === '百度';
}

function isQuarkFlag(flag) {
    return extractBuiltinPanFlagToken(flag) === '夸父';
}

function isUcFlag(flag) {
    return extractBuiltinPanFlagToken(flag) === '优夕';
}

function looksLikeHexId32(value) {
    return /^[a-f0-9]{32}$/i.test(String(value || '').trim());
}

function is139Flag(flag) {
    return extractBuiltinPanFlagToken(flag) === '逸动';
}

function is189Flag(flag) {
    return extractBuiltinPanFlagToken(flag) === '天意';
}

function pickStringField(obj, keys) {
    const o = obj && typeof obj === 'object' ? obj : {};
    for (const k of Array.isArray(keys) ? keys : []) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

function extractFirstUrl(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const m = raw.match(/https?:\/\/[^\s"'<>]+/i);
    if (!m) return '';
    let url = String(m[0] || '').trim();
    // Trim trailing punctuation commonly attached in copied text.
    url = url.replace(/[)\],.。;；]+$/g, '');
    return url;
}

function decodeMaybeJsonString(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    if (!(t.startsWith('{') && t.endsWith('}'))) return null;
    try {
        return JSON.parse(t);
    } catch (_) {
        return null;
    }
}

function pickAnyList(node) {
    const n = node && typeof node === 'object' ? node : null;
    if (!n) return [];
    const cands = [
        n.list,
        n.items,
        n.files,
        n.data && n.data.list,
        n.data && n.data.items,
        n.data && n.data.files,
        n.data && n.data.data && n.data.data.list,
        n.data && n.data.data && n.data.data.items,
        n.data && n.data.data && n.data.data.files,
    ];
    for (const c of cands) {
        if (Array.isArray(c)) return c;
    }
    return [];
}

function pickItemName(item) {
    const it = item && typeof item === 'object' ? item : {};
    return (
        String(it.server_filename || it.file_name || it.filename || it.name || it.title || it.display_name || it.displayName || '').trim()
    );
}

function isItemDir(item) {
    const it = item && typeof item === 'object' ? item : {};
    if (it.dir === true) return true;
    if (Number(it.isdir) === 1) return true;
    if (Number(it.file_type) === 0) return true;
    if (String(it.type || '').toLowerCase() === 'folder') return true;
    if (String(it.kind || '').toLowerCase() === 'folder') return true;
    return false;
}

function pickItemId(item) {
    const it = item && typeof item === 'object' ? item : {};
    return String(it.fid || it.file_id || it.fileId || it.id || it.fs_id || it.fsid || '').trim();
}

function pickItemToken(item) {
    const it = item && typeof item === 'object' ? item : {};
    return String(it.fid_token || it.fidToken || it.token || it.file_token || '').trim();
}

function encodeB64Json(obj) {
    try {
        const s = JSON.stringify(obj && typeof obj === 'object' ? obj : {});
        return Buffer.from(s, 'utf8').toString('base64');
    } catch (_) {
        return '';
    }
}

function mergeReplyHeaders(reply, outHeaders, hopByHop) {
    try {
        const existing = reply && typeof reply.getHeaders === 'function' ? reply.getHeaders() : null;
        if (!existing || typeof existing !== 'object') return outHeaders;
        const merged = outHeaders && typeof outHeaders === 'object' ? { ...outHeaders } : {};
        const outLower = new Set(Object.keys(merged).map((k) => String(k || '').toLowerCase()));
        Object.keys(existing).forEach((k) => {
            const key = String(k || '');
            const lower = key.toLowerCase();
            if (!lower || hopByHop.has(lower) || outLower.has(lower)) return;
            merged[key] = existing[k];
            outLower.add(lower);
        });
        return merged;
    } catch (_) {
        return outHeaders && typeof outHeaders === 'object' ? outHeaders : {};
    }
}

function cloneHeaders(headers, hopByHop) {
    const outHeaders = {};
    Object.keys(headers || {}).forEach((k) => {
        const key = String(k || '').toLowerCase();
        if (!key || hopByHop.has(key)) return;
        outHeaders[k] = headers[k];
    });
    return outHeaders;
}

function rewritePanmockDetailPayload(parsed) {
    if (!parsed || typeof parsed !== 'object') return parsed;
    if (!parsed.pan_mock) return parsed;
    const list = Array.isArray(parsed.list) ? parsed.list : null;
    if (!list || !list.length || !list[0] || typeof list[0] !== 'object') return parsed;
    const first = { ...list[0] };
    const rewritten = rewritePanmockDetailPayloadFields(first.vod_play_from, first.vod_play_url);
    first.vod_play_from = rewritten.vod_play_from;
    first.vod_play_url = rewritten.vod_play_url;
    return { ...parsed, list: [first, ...list.slice(1)] };
}

function rewriteSpiderJsonResponse(parsed, { isDetail, cacheHit }) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    let next = { ...parsed, cache: !!cacheHit };
    if (isDetail) {
        next.pan_mock = isPanMockEnabled();
        next = rewritePanmockDetailPayload(next);
    }
    return next;
}

function shouldTryRewriteSpiderResponse(forwardPath, responseHeaders) {
    const pathName = String(forwardPath || '').split('?')[0] || '/';
    const isCacheRoute = isSpiderCacheRoutePath(pathName);
    if (!isCacheRoute) return { shouldRewrite: false, isDetail: false };
    const isDetail = /\/detail$/i.test(pathName);
    const contentType = String((responseHeaders && (responseHeaders['content-type'] || responseHeaders['Content-Type'])) || '');
    const shouldRewrite =
        String(contentType || '').includes('application/json') ||
        String(contentType || '').includes('text/plain') ||
        String(contentType || '').includes('text/json') ||
        !contentType;
    return { shouldRewrite, isDetail };
}

async function fetchBufferedProxyResponse({ request, targetPort, pathToUse, headers, limitBytes }) {
    return await new Promise((resolve, reject) => {
        const proxyReq = http.request(
            {
                hostname: '127.0.0.1',
                port: targetPort,
                method: String(request.method || 'GET').toUpperCase(),
                path: pathToUse,
                headers,
            },
            (proxyRes) => {
                const responseHeaders = cloneHeaders(proxyRes.headers || {}, new Set([
                    'connection',
                    'keep-alive',
                    'proxy-authenticate',
                    'proxy-authorization',
                    'te',
                    'trailer',
                    'transfer-encoding',
                    'upgrade',
                ]));
                const chunks = [];
                let total = 0;
                proxyRes.on('data', (c) => {
                    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                    total += b.length;
                    if (limitBytes > 0 && total > limitBytes) {
                        chunks.push(b);
                        return;
                    }
                    chunks.push(b);
                });
                proxyRes.on('end', () => {
                    resolve({
                        statusCode: proxyRes.statusCode || 502,
                        headers: responseHeaders,
                        body: Buffer.concat(chunks),
                    });
                });
            }
        );
        proxyReq.on('error', reject);
        try {
            const method = String(request.method || 'GET').toUpperCase();
            const body = request && Object.prototype.hasOwnProperty.call(request, 'body') ? request.body : undefined;
            if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
                let buf = null;
                if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
                    buf = Buffer.from(body);
                } else if (typeof body === 'string') {
                    buf = Buffer.from(body, 'utf8');
                } else if (typeof body === 'object') {
                    buf = Buffer.from(JSON.stringify(body), 'utf8');
                    if (!headers['content-type']) headers['content-type'] = 'application/json';
                }
                if (buf) {
                    proxyReq.setHeader('content-length', String(buf.length));
                    proxyReq.end(buf);
                    return;
                }
            }
            if (request && request.raw) request.raw.pipe(proxyReq);
            else proxyReq.end();
        } catch (err) {
            try {
                proxyReq.destroy(err);
            } catch (_) {}
        }
    });
}

function sendBufferedProxyResponse(reply, request, response, { rewriteSpider = false, cacheHit = false, forwardPath = '' } = {}) {
    const hopByHop = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ]);
    const status = response && Number(response.statusCode) > 0 ? Number(response.statusCode) : 502;
    let outHeaders = cloneHeaders((response && response.headers) || {}, hopByHop);
    let outBody = Buffer.isBuffer(response && response.body) ? response.body : Buffer.from(response && response.body ? response.body : '');

    if (rewriteSpider) {
        const parsed = parseJsonSafe(outBody.toString('utf8'));
        const rewriteMeta = shouldTryRewriteSpiderResponse(forwardPath, outHeaders);
        const next = rewriteMeta.shouldRewrite ? rewriteSpiderJsonResponse(parsed, { isDetail: rewriteMeta.isDetail, cacheHit }) : null;
        if (next) {
            outBody = Buffer.from(JSON.stringify(next), 'utf8');
            delete outHeaders['content-length'];
            delete outHeaders['Content-Length'];
            outHeaders['content-length'] = String(outBody.length);
            if (!outHeaders['content-type'] && !outHeaders['Content-Type']) outHeaders['content-type'] = 'application/json; charset=utf-8';
        }
    }

    outHeaders = mergeReplyHeaders(reply, outHeaders, hopByHop);
    try {
        reply.raw.writeHead(status, outHeaders);
    } catch (_) {}
    try {
        reply.raw.end(outBody);
    } catch (_) {
        try {
            reply.raw.end();
        } catch (_) {}
    }
    return request;
}

/**
 * A function to initialize the router.
 *
 * @param {Object} fastify - The Fastify instance
 * @return {Promise<void>} - A Promise that resolves when the router is initialized
 */
export default async function router(fastify) {
    // 0) register builtin api plugins (packaged with this build)
    for (const p of (apiPlugins || [])) {
        fastify.register(p.plugin, {prefix: p.prefix});
        console.log(`Register api plugin: ${p.prefix} (from ${p.fileName || 'builtin'})`);
    }

    // Unified play entrypoint:
    // - if builtin pan resolver enabled: dispatch to /api/{baidu,quark,uc,139,189}/play based on flag
    // - otherwise (or no match): forward to the target runtime play via siteApi + siteId
    fastify.post('/play', async function (request, reply) {
        const body = request && request.body && typeof request.body === 'object' ? request.body : {};
        const flag = typeof body.flag === 'string' ? body.flag : '';
        let playId = typeof body.id === 'string' ? body.id : '';
        const filename = pickStringField(body, ['filename', 'fileName', 'name']);
        if (!flag) return reply.code(400).send({ ok: false, message: 'missing flag' });
        if (!playId && !filename) return reply.code(400).send({ ok: false, message: 'missing id/filename' });

        const externalOrigin = getExternalOriginFromRequest(request);

        const runtimeRoot = resolveRuntimeRootDir();
        const cfgPath = path.resolve(runtimeRoot, 'config.json');
        const cfgRoot = readConfigJsonSafe(cfgPath);
        const panEnabled = readPanBuiltinResolverEnabledFromConfigRoot(cfgRoot);
        const hasUcTvCred = !!(cfgRoot && cfgRoot.account && cfgRoot.account.uc_tv && cfgRoot.account.uc_tv.refresh_token && cfgRoot.account.uc_tv.device_id);
        const hasUcCookie = !!(cfgRoot && cfgRoot.account && cfgRoot.account.uc && cfgRoot.account.uc.cookie);

        const rawUrl = request && request.raw && typeof request.raw.url === 'string' ? request.raw.url : '';
        const queryStr = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
        const tvUser = getTvUserFromRequest(request);
        const baseHeaders = { 'content-type': 'application/json' };

        // 1) builtin pan resolver path
        if (panEnabled) {
            let route = isBaiduFlag(flag)
                ? '/api/baidu/play'
                : isQuarkFlag(flag)
                    ? '/api/quark/play'
                    : isUcFlag(flag)
                        ? '/api/uc/play'
                        : is139Flag(flag)
                            ? '/api/139/play'
                            : is189Flag(flag)
                                ? '/api/189/play'
                                : '';
            const shareUrl =
                pickStringField(body, ['url', 'shareUrl', 'shareURL', 'share_url']) ||
                extractFirstUrl(flag) ||
                '';

            const injectJson = async (url, payload) => {
                const injected = await fastify.inject({
                    method: 'POST',
                    url,
                    headers: { ...baseHeaders, ...(tvUser ? { 'x-tv-user': tvUser } : {}) },
                    payload: payload != null ? payload : {},
                });
                const parsed = parseJsonSafe(injected.payload);
                return { statusCode: injected.statusCode || 0, parsed, raw: injected.payload };
            };

            const resolveBaiduIdByFilename = async () => {
                if (!shareUrl) return { ok: false, message: 'missing share url (from url/shareUrl/flag)' };
                const pwd = pickStringField(body, ['pwd', 'pass', 'passcode', 'code', 'password']);
                const wanted = String(filename || '').trim();
                if (!wanted) return { ok: false, message: 'missing filename' };

                const seenDirs = new Set();
                const q = ['']; // '' = root
                let steps = 0;
                let ctx = null;
                while (q.length && steps < 200) {
                    steps += 1;
                    const dir = q.shift();
                    const payload = { url: shareUrl, ...(pwd ? { pwd } : {}), ...(dir ? { dir } : {}) };
                    const out = await injectJson('/api/baidu/share/list', payload);
                    const resp = out && out.parsed && typeof out.parsed === 'object' ? out.parsed : null;
                    if (!resp || resp.ok !== true) continue;
                    if (!ctx && resp.ctx && typeof resp.ctx === 'object') ctx = resp.ctx;
                    const list = pickAnyList(resp.data);
                    for (const it of list) {
                        const name = pickItemName(it);
                        if (!name) continue;
                        if (isItemDir(it)) {
                            const nextDir = `${dir ? String(dir) : ''}/${name}`.replace(/\/{2,}/g, '/');
                            const normalized = nextDir.startsWith('/') ? nextDir : `/${nextDir}`;
                            if (!seenDirs.has(normalized)) {
                                seenDirs.add(normalized);
                                q.push(normalized);
                            }
                            continue;
                        }
                        if (name !== wanted) continue;
                        const fsid = String((it && (it.fs_id ?? it.fsid)) || '').trim();
                        if (!fsid) continue;
                        const shareid = ctx ? String(ctx.shareid || ctx.share_id || '').trim() : '';
                        const uk = ctx ? String(ctx.uk || ctx.share_uk || '').trim() : '';
                        const surl = ctx ? String(ctx.surl || '').trim() : '';
                        if (!shareid || !uk || !surl) return { ok: false, message: 'missing share ctx (surl/shareid/uk)' };
                        const id = encodeB64Json({ surl, shareid, uk, fs_id: fsid, ...(pwd ? { pwd } : {}) });
                        if (!id) return { ok: false, message: 'failed to encode id' };
                        return { ok: true, id };
                    }
                }
                return { ok: false, message: 'file not found in share list' };
            };

            const resolveQuarkLikeIdByFilename = async (provider) => {
                const base = provider === 'uc' ? '/api/uc' : '/api/quark';
                if (!shareUrl) return { ok: false, message: 'missing share url (from url/shareUrl/flag)' };
                const wanted = String(filename || '').trim();
                if (!wanted) return { ok: false, message: 'missing filename' };
                const passcode = pickStringField(body, ['pwd', 'pass', 'passcode', 'code', 'password']);

                const parsed = await injectJson(`${base}/share/parse`, { url: shareUrl });
                const p = parsed && parsed.parsed && typeof parsed.parsed === 'object' ? parsed.parsed : null;
                const shareId = p && p.ok === true ? String(p.shareId || '').trim() : '';
                if (!shareId) return { ok: false, message: 'invalid share url' };

                const seen = new Set();
                const q = ['0'];
                let steps = 0;
                while (q.length && steps < 300) {
                    steps += 1;
                    const pdirFid = String(q.shift() || '0').trim() || '0';
                    if (seen.has(pdirFid)) continue;
                    seen.add(pdirFid);
                    const detailOut = await injectJson(`${base}/share/detail`, { shareId, ...(passcode ? { passcode } : {}), pdir_fid: pdirFid });
                    const d = detailOut && detailOut.parsed && typeof detailOut.parsed === 'object' ? detailOut.parsed : null;
                    if (!d || d.ok !== true) continue;
                    const stoken = String(d.stoken || '').trim();
                    const detail = d.detail && typeof d.detail === 'object' ? d.detail : {};
                    const list = pickAnyList(detail);
                    for (const it of list) {
                        const name = pickItemName(it);
                        if (!name) continue;
                        if (isItemDir(it)) {
                            const id = pickItemId(it);
                            if (id && id !== '0') q.push(id);
                            continue;
                        }
                        if (name !== wanted) continue;
                        const fid = pickItemId(it);
                        const fidToken = pickItemToken(it);
                        if (!fid) continue;
                        const id = `${shareId}*${stoken}*${fid}*${fidToken}***${wanted}`;
                        return { ok: true, id };
                    }
                }
                return { ok: false, message: 'file not found in share detail' };
            };

            // If caller provided only filename, try resolving it to a provider-specific id first.
            // Note: this might perform multiple share-detail/list requests for nested directories.
            if (!playId && filename && route) {
                if (route === '/api/139/play') {
                    return reply.code(200).send({ ok: false, url: '', playUrl: '', downloadUrl: '', message: 'filename not supported for 139 (missing id)' });
                }
                try {
                    const res =
                        route === '/api/baidu/play'
                            ? await resolveBaiduIdByFilename()
                            : route === '/api/quark/play'
                                ? await resolveQuarkLikeIdByFilename('quark')
                                : route === '/api/uc/play'
                                    ? await resolveQuarkLikeIdByFilename('uc')
                                    : { ok: false, message: 'unsupported provider' };
                    if (!res || res.ok !== true || !res.id) {
                        return reply.code(200).send({ ok: false, url: '', playUrl: '', downloadUrl: '', message: (res && res.message) ? String(res.message) : 'resolve id failed' });
                    }
                    playId = String(res.id || '').trim();
                    body.id = playId;
                } catch (e) {
                    const msg = (e && e.message) ? String(e.message) : String(e);
                    return reply.code(200).send({ ok: false, url: '', playUrl: '', downloadUrl: '', message: msg.slice(0, 400) });
                }
            }

            // If the id is already a Quark file id (32-hex), skip save/transfer and request a direct url.
            if (route === '/api/quark/play' && looksLikeHexId32(playId)) {
                route = '/api/quark/download';
            }
            // If the id is already a UC file id (32-hex), request a direct url (prefer UCTV when configured).
            if (route === '/api/uc/play' && looksLikeHexId32(playId)) {
                route = hasUcTvCred ? '/api/uc/tv/download' : hasUcCookie ? '/api/uc/file/download' : '/api/uc/tv/download';
            }
            if (route) {
                const nextBody = { ...body };
                // Do not leak site routing fields into pan plugins.
                delete nextBody.siteApi;
                delete nextBody.spiderApi;
                delete nextBody.api;
                delete nextBody.siteId;
                delete nextBody.onlineId;
                delete nextBody.runtimeId;
                // Ensure Baidu has a destination folder (plugin requires destPath/destName).
                if (route === '/api/baidu/play') {
                    if (!nextBody.destPath && !nextBody.destName) nextBody.destName = 'MeowFilm';
                }
                if (route === '/api/quark/download') {
                    // Normalize to the download API input shape.
                    nextBody.fid = playId;
                    delete nextBody.id;
                }
                if (route === '/api/uc/tv/download' || route === '/api/uc/file/download') {
                    nextBody.fid = playId;
                    delete nextBody.id;
                    // Keep flag untouched but it's ignored by fid-based UC endpoints.
                }
                const injected = await fastify.inject({
                    method: 'POST',
                    url: `${route}${queryStr}`,
                    headers: { ...baseHeaders, ...(tvUser ? { 'x-tv-user': tvUser } : {}) },
                    payload: nextBody,
                });
                const parsed = parseJsonSafe(injected.payload);
                if (externalOrigin && parsed && typeof parsed === 'object') {
                    try {
                        rewriteLocalUrlsDeep(parsed, externalOrigin, '', []);
                    } catch (_) {}
                }
                return reply.code(injected.statusCode || 200).send(parsed != null ? parsed : injected.payload);
            }
        }

        // If we reached here with only filename, we cannot proceed (either pan resolver is disabled or the flag didn't match).
        if (!playId) return reply.code(400).send({ ok: false, message: 'missing id (pan resolver disabled or unsupported flag)' });

        // 2) fallback: forward to the site runtime play
        const siteApi =
            (typeof body.siteApi === 'string' && body.siteApi.trim()) ||
            (typeof body.spiderApi === 'string' && body.spiderApi.trim()) ||
            (typeof body.api === 'string' && body.api.trim()) ||
            '';
        const siteIdRaw =
            (typeof body.siteId === 'string' && body.siteId.trim()) ||
            (typeof body.onlineId === 'string' && body.onlineId.trim()) ||
            (typeof body.runtimeId === 'string' && body.runtimeId.trim()) ||
            '';

        if (!siteApi) return reply.code(400).send({ ok: false, message: 'missing siteApi' });

        const apiTrimmed = String(siteApi || '').trim();
        const apiHasIdPrefix = /^\/[a-f0-9]{10}\/spider\//.test(apiTrimmed);
        const idFromApi = apiHasIdPrefix ? apiTrimmed.slice(1, 11) : '';
        let siteId = siteIdRaw || idFromApi;

        if (!apiHasIdPrefix && !siteId) {
            const keys =
                fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.keys === 'function'
                    ? Array.from(fastify.onlineRuntimePorts.keys())
                    : [];
            if (keys.length === 1) siteId = String(keys[0] || '').trim();
        }
        if (!apiHasIdPrefix && !siteId) return reply.code(400).send({ ok: false, message: 'missing siteId' });

        const forwardBase = apiHasIdPrefix ? apiTrimmed : `/${siteId}${apiTrimmed.startsWith('/') ? '' : '/'}${apiTrimmed}`;
        const forwardUrl = `${forwardBase.replace(/\/+$/g, '')}/play${queryStr}`;
        const forwardBody = { ...body };
        delete forwardBody.siteApi;
        delete forwardBody.spiderApi;
        delete forwardBody.api;
        delete forwardBody.siteId;
        delete forwardBody.onlineId;
        delete forwardBody.runtimeId;

        const injected = await fastify.inject({
            method: 'POST',
            url: forwardUrl,
            headers: baseHeaders,
            payload: forwardBody,
        });
        const parsed = parseJsonSafe(injected.payload);
        if (externalOrigin && parsed && typeof parsed === 'object') {
            try {
                const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(siteId) : null;
                const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
                rewriteLocalUrlsDeep(parsed, externalOrigin, siteId, p ? [p] : []);
            } catch (_) {}
        }
        return reply.code(injected.statusCode || 200).send(parsed != null ? parsed : injected.payload);
    });

    /**
     * @api {get} /check 检查
     */
    fastify.register(
        /**
         *
         * @param {import('fastify').FastifyInstance} fastify
         */
        async (fastify) => {
            fastify.get(
                '/check',
                /**
                 * check api alive or not
                 * @param {import('fastify').FastifyRequest} _request
                 * @param {import('fastify').FastifyReply} reply
                 */
                async function (_request, reply) {
                    reply.send({run: !fastify.stop});
                }
            );
            fastify.get(
                '/config',
                /**
                 * get catopen format config
                 * @param {import('fastify').FastifyRequest} _request
                 * @param {import('fastify').FastifyReply} reply
                 */
                async function (_request, reply) {
                    const config = {
                        video: {
                            sites: [],
                        },
                        read: {
                            sites: [],
                        },
                        comic: {
                            sites: [],
                        },
                        music: {
                            sites: [],
                        },
                        pan: {
                            sites: [],
                        },
                        color: fastify.config.color || [],
                    };
                    reply.send(config);
                }
            );

            fastify.all('/proxy', async (request, reply) => {
                if (isProxyDisabled()) {
                    reply.code(403).send({error: 'proxy disabled'});
                    return;
                }
                try {
                    const {thread, chunkSize, url, header} = request.query;

                    if (!url) {
                        reply.code(400).send({error: 'url is required'});
                        return;
                    }

                    // 解码 URL 和 Header
                    // const decodedUrl = decodeURIComponent(url);
                    const decodedUrl = url;
                    // const decodedHeader = header ? JSON.parse(decodeURIComponent(header)) : {};
                    const decodedHeader = header ? JSON.parse(header) : {};

                    // 获取当前请求头
                    const currentHeaders = request.headers;

                    // 解析目标 URL
                    const targetUrl = new URL(decodedUrl);

                    // 更新特殊头部
                    const proxyHeaders = {
                        ...currentHeaders,
                        ...decodedHeader,
                        host: targetUrl.host, // 确保 Host 对应目标网站
                        origin: `${targetUrl.protocol}//${targetUrl.host}`, // Origin
                        referer: targetUrl.href, // Referer
                    };

                    // 删除本地无关头部
                    delete proxyHeaders['content-length']; // 避免因修改内容导致不匹配
                    delete proxyHeaders['transfer-encoding'];

                    // 添加缺省值或更新
                    proxyHeaders['user-agent'] =
                        proxyHeaders['user-agent'] ||
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';
                    proxyHeaders['accept'] = proxyHeaders['accept'] || '*/*';
                    proxyHeaders['accept-language'] = proxyHeaders['accept-language'] || 'en-US,en;q=0.9';
                    proxyHeaders['accept-encoding'] = proxyHeaders['accept-encoding'] || 'gzip, deflate, br';


                    // delete proxyHeaders['host'];
                    // delete proxyHeaders['origin'];
                    // delete proxyHeaders['referer'];
                    // delete proxyHeaders['cookie'];
                    // delete proxyHeaders['accept'];

                    delete proxyHeaders['sec-fetch-site'];
                    delete proxyHeaders['sec-fetch-mode'];
                    delete proxyHeaders['sec-fetch-dest'];
                    delete proxyHeaders['sec-ch-ua'];
                    delete proxyHeaders['sec-ch-ua-mobile'];
                    delete proxyHeaders['sec-ch-ua-platform'];
                    // delete proxyHeaders['connection'];
                    // delete proxyHeaders['user-agent'];
                    delete proxyHeaders['range']; // 必须删除，后面chunkStream会从request取出来的
                    // console.log(`proxyHeaders:`, proxyHeaders);

                    // 处理选项
                    const option = {
                        chunkSize: chunkSize ? 1024 * parseInt(chunkSize, 10) : 1024 * 256,
                        poolSize: thread ? parseInt(thread, 10) : 6,
                        timeout: 1000 * 10, // 默认 10 秒超时
                    };

                    // console.log(`option:`, option);
                    // 计算 urlKey (MD5)
                    const urlKey = md5(decodedUrl);

                    // 调用 chunkStream
                    return await chunkStream(request, reply, decodedUrl, urlKey, proxyHeaders, option);
                } catch (err) {
                    reply.code(500).send({error: err.message});
                }
            });
        }
    );

    // If a route is not handled by catpawrunner, proxy it to the online runtime (default: 9988).
    // This allows downloaded scripts in `custom_spider/` to expose their own routes while still being accessed from this port.
    const proxyToPort = async function (request, reply, targetPort, urlPath, runtimeId = '') {
        const pathToUse = typeof urlPath === 'string' && urlPath ? urlPath : '/';
        const wantInjectPanMock = /\/spider\/[^/]+\/\d+\/detail(?:\?|$)/i.test(pathToUse);
        const allowSpiderCache = isEligibleSpiderCacheRequest(request && request.method, pathToUse) && /^[a-f0-9]{10}$/i.test(String(runtimeId || '').trim());

        const hopByHop = new Set([
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'te',
            'trailer',
            'transfer-encoding',
            'upgrade',
        ]);

        const headers = {};
        const inHeaders = (request && request.headers) || {};
        Object.keys(inHeaders).forEach((k) => {
            const key = String(k || '').toLowerCase();
            if (!key || hopByHop.has(key)) return;
            headers[key] = inHeaders[k];
        });
        // If we plan to parse and rewrite JSON, disable compression from upstream.
        if (wantInjectPanMock || allowSpiderCache) headers['accept-encoding'] = 'identity';
        headers.host = `127.0.0.1:${targetPort}`;
        // Fastify may have already consumed the incoming stream to populate `request.body`.
        // Never forward a stale Content-Length (will hang the upstream waiting for bytes).
        delete headers['content-length'];
        delete headers['transfer-encoding'];

        reply.hijack();
        if (allowSpiderCache) {
            const cacheKey = buildSpiderCacheKey({
                runtimeId,
                forwardPath: pathToUse,
                method: request && request.method,
                body: request && Object.prototype.hasOwnProperty.call(request, 'body') ? request.body : {},
            });
            try {
                const { hit, entry } = await getOrCreateSpiderCache(cacheKey, async () => {
                    const buffered = await fetchBufferedProxyResponse({
                        request,
                        targetPort,
                        pathToUse,
                        headers: { ...headers },
                        limitBytes: 0,
                    });
                    if (!buffered) return { entry: null, cacheable: false };
                    const rewriteMeta = shouldTryRewriteSpiderResponse(pathToUse, buffered.headers);
                    const bodySize = Buffer.isBuffer(buffered.body) ? buffered.body.length : 0;
                    const parsed = rewriteMeta.shouldRewrite ? parseJsonSafe(Buffer.from(buffered.body || '').toString('utf8')) : null;
                    const cacheable =
                        buffered.statusCode >= 200 &&
                        buffered.statusCode < 300 &&
                        rewriteMeta.shouldRewrite &&
                        parsed &&
                        typeof parsed === 'object' &&
                        !Array.isArray(parsed) &&
                        bodySize <= 8 * 1024 * 1024;
                    return {
                        entry: buffered,
                        cacheable,
                        ttlMs: 60 * 60 * 1000,
                    };
                });
                if (entry) {
                    sendBufferedProxyResponse(reply, request, entry, {
                        rewriteSpider: true,
                        cacheHit: hit,
                        forwardPath: pathToUse,
                    });
                    return;
                }
            } catch (_) {}
        }
        return await new Promise((resolve) => {
            const proxyReq = http.request(
                {
                    hostname: '127.0.0.1',
                    port: targetPort,
                    method: String(request.method || 'GET').toUpperCase(),
                    path: pathToUse,
                    headers,
                },
                (proxyRes) => {
                    const outHeaders = mergeReplyHeaders(reply, cloneHeaders(proxyRes.headers || {}, hopByHop), hopByHop);
                    const shouldTryInject =
                        wantInjectPanMock &&
                        (String(outHeaders['content-type'] || '').includes('application/json') ||
                            String(outHeaders['content-type'] || '').includes('text/plain') ||
                            String(outHeaders['content-type'] || '').includes('text/json') ||
                            !outHeaders['content-type']);

                    if (!shouldTryInject) {
                        try {
                            reply.raw.writeHead(proxyRes.statusCode || 502, outHeaders);
                        } catch (_) {}
                        proxyRes.pipe(reply.raw);
                        proxyRes.on('end', () => resolve());
                        return;
                    }

                    const chunks = [];
                    let total = 0;
                    const limit = 8 * 1024 * 1024; // 8MB max for rewrite
                    let streaming = false;
                    proxyRes.on('data', (c) => {
                        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                        if (streaming) {
                            try {
                                reply.raw.write(b);
                            } catch (_) {}
                            return;
                        }
                        if (total+b.length > limit) {
                            // Too large to safely buffer/parse; stream through unchanged.
                            streaming = true;
                            try {
                                reply.raw.writeHead(proxyRes.statusCode || 502, outHeaders);
                                if (chunks.length) reply.raw.write(Buffer.concat(chunks));
                                reply.raw.write(b);
                            } catch (_) {}
                            return;
                        }
                        total += b.length;
                        chunks.push(b);
                    });
                    proxyRes.on('end', () => {
                        const status = proxyRes.statusCode || 502;
                        if (streaming) {
                            try {
                                reply.raw.end();
                            } catch (_) {}
                            resolve();
                            return;
                        }
                        try {
                            const raw = Buffer.concat(chunks).toString('utf8');
                            const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
                            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                parsed.pan_mock = isPanMockEnabled();
                                if (parsed.pan_mock) {
                                    const rewritten = rewritePanmockDetailPayload(parsed);
                                    if (rewritten && typeof rewritten === 'object') {
                                        Object.keys(parsed).forEach((k) => {
                                            delete parsed[k];
                                        });
                                        Object.assign(parsed, rewritten);
                                    }
                                }
                                const out = Buffer.from(JSON.stringify(parsed), 'utf8');
                                delete outHeaders['content-length'];
                                outHeaders['content-length'] = String(out.length);
                                if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/json; charset=utf-8';
                                reply.raw.writeHead(status, outHeaders);
                                reply.raw.end(out);
                                resolve();
                                return;
                            }
                        } catch (_) {}

                        // Fallback: stream original response if rewrite fails.
                        try {
                            reply.raw.writeHead(status, outHeaders);
                        } catch (_) {}
                        try {
                            reply.raw.end(Buffer.concat(chunks));
                        } catch (_) {}
                        resolve();
                    });
                }
            );
            proxyReq.on('error', (err) => {
                try {
                    reply.raw.statusCode = 502;
                    reply.raw.setHeader('content-type', 'application/json; charset=utf-8');
                    try {
                        const origin = request && request.headers ? request.headers.origin : '';
                        if (origin) reply.raw.setHeader('Access-Control-Allow-Origin', origin);
                        else reply.raw.setHeader('Access-Control-Allow-Origin', '*');
                    } catch (_) {}
                    reply.raw.end(JSON.stringify({ error: (err && err.message) || 'proxy failed' }));
                } catch (_) {}
                resolve();
            });
            try {
                const method = String(request.method || 'GET').toUpperCase();
                const body = request && Object.prototype.hasOwnProperty.call(request, 'body') ? request.body : undefined;

                if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
                    let buf = null;
                    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
                        buf = Buffer.from(body);
                    } else if (typeof body === 'string') {
                        buf = Buffer.from(body, 'utf8');
                    } else if (typeof body === 'object') {
                        buf = Buffer.from(JSON.stringify(body), 'utf8');
                        if (!headers['content-type']) headers['content-type'] = 'application/json';
                    }
                    if (buf) {
                        proxyReq.setHeader('content-length', String(buf.length));
                        proxyReq.end(buf);
                        return;
                    }
                }

                if (request && request.raw) request.raw.pipe(proxyReq);
                else proxyReq.end();
            } catch (_) {
                try {
                    proxyReq.end();
                } catch (_) {}
            }
        });
    };

    const onlineSpiderInitPromises = new Map(); // key -> Promise<void>
    const onlineSpiderInited = new Set(); // key

    const ensureOnlineSpiderInited = async function (id, targetPort, spiderKey, spiderType) {
        const k = `${id}:${spiderKey}:${spiderType}`;
        if (onlineSpiderInited.has(k)) return;
        if (onlineSpiderInitPromises.has(k)) return await onlineSpiderInitPromises.get(k);

        const run = async () => {
            const initPath = `/spider/${encodeURIComponent(spiderKey)}/${encodeURIComponent(String(spiderType))}/init`;
            const doReq = (method) =>
                new Promise((resolve, reject) => {
                    const req = http.request(
                        {
                            hostname: '127.0.0.1',
                            port: targetPort,
                            method,
                            path: initPath,
                            headers: {
                                host: `127.0.0.1:${targetPort}`,
                                accept: 'application/json, text/plain, */*',
                                'content-type': 'application/json',
                            },
                        },
                        (res) => {
                            const chunks = [];
                            res.on('data', (c) => chunks.push(c));
                            res.on('end', () => {
                                const status = Number(res.statusCode || 0);
                                if (status >= 200 && status < 300) return resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
                                if (status === 404) return resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
                                return reject(
                                    new Error(
                                        `init failed status=${status || 'unknown'} body=${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`
                                    )
                                );
                            });
                        }
                    );
                    req.on('error', reject);
                    if (method === 'POST') req.end('{}');
                    else req.end();
                });

            // Some scripts expose init as GET, some as POST; try POST first.
            const first = await doReq('POST');
            if (first && first.status === 404) await doReq('GET');
        };

        const p = run()
            .then(() => {
                onlineSpiderInited.add(k);
            })
            .finally(() => {
                onlineSpiderInitPromises.delete(k);
            });
        onlineSpiderInitPromises.set(k, p);
        return await p;
    };

    const setRuntimeHintCookie = (reply, id) => {
        const rid = String(id || '').trim().toLowerCase();
        if (!/^[a-f0-9]{10}$/.test(rid)) return;
        try {
            reply.header('Set-Cookie', `catpaw_runtime_id=${rid}; Path=/; SameSite=Lax`);
        } catch (_) {}
    };

    // Compatibility shim for absolute "/website/*" requests from website bundles.
    // Resolve runtime by hint cookie first, then by Referer "/<id>/website/...".
    const proxyWebsiteByRuntimeHint = async function (request, reply) {
        if (String((request && request.method) || '').toUpperCase() === 'OPTIONS') return reply.code(204).send();

        const headers = (request && request.headers) || {};
        const cookies = parseCookieHeader(headers.cookie || headers.Cookie || '');
        const cookieID = String(cookies.catpaw_runtime_id || '').trim().toLowerCase();
        const refererID = extractRuntimeIDFromReferer(headers.referer || headers.referrer || '');
        const id = /^[a-f0-9]{10}$/.test(cookieID) ? cookieID : refererID;
        if (!id) return reply.code(404).send({ error: 'online runtime not found' });

        const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(id) : null;
        const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
        if (!p) return reply.code(404).send({ error: 'online runtime not found', id });

        setRuntimeHintCookie(reply, id);
        const rawUrl = request && request.raw && typeof request.raw.url === 'string' ? request.raw.url : '';
        const parts = splitRawUrl(rawUrl);
        const tail = stripPrefixFromRawPath(parts.path, '/website');
        const query = parts.query || '';
        const forwardPath = `/website${tail ? `/${tail}` : ''}${query}`;
        return proxyToPort(request, reply, p, forwardPath, id);
    };

    fastify.all('/website', proxyWebsiteByRuntimeHint);
    fastify.all('/website/*', proxyWebsiteByRuntimeHint);

    // Explicit id-based proxy: /online/:id/* -> the runtime port for that script id.
    fastify.all('/online/:id', async function (request, reply) {
        if (String(request && request.method || '').toUpperCase() === 'OPTIONS') return reply.code(204).send();
        const id = request && request.params ? String(request.params.id || '').trim() : '';
        const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(id) : null;
        const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
        if (!id || !p) return reply.code(404).send({ error: 'online runtime not found', id });
        setRuntimeHintCookie(reply, id);
        return proxyToPort(request, reply, p, '/', id);
    });
    fastify.all('/online/:id/*', async function (request, reply) {
        if (String(request && request.method || '').toUpperCase() === 'OPTIONS') return reply.code(204).send();
        const id = request && request.params ? String(request.params.id || '').trim() : '';
        const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(id) : null;
        const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
        if (!id || !p) return reply.code(404).send({ error: 'online runtime not found', id });
        setRuntimeHintCookie(reply, id);

        const tail = request && request.params ? String(request.params['*'] || '') : '';
        const normalizedTail = String(tail || '').replace(/^\/+/, '');
        const m = /^spider\/([^/]+)\/(\d+)\//.exec(normalizedTail);
        if (m) {
            const key = m[1];
            const type = m[2];
            const isInit = normalizedTail === `spider/${key}/${type}/init`;
            if (!isInit) {
                try {
                    await ensureOnlineSpiderInited(id, p, key, type);
                } catch (_) {}
            }
        }
        const rawUrl = request && request.raw && typeof request.raw.url === 'string' ? request.raw.url : '';
        const parts = splitRawUrl(rawUrl);
        const encodedTail = stripPrefixFromRawPath(parts.path, `/online/${id}`);
        const forwardPath = `/${encodedTail || ''}${parts.query || ''}`;
        return proxyToPort(request, reply, p, forwardPath, id);
    });

    // Preferred id-based proxy: /:id/spider/...  (avoid catching /api, /admin, etc by using a strict id pattern).
    fastify.all('/:id([a-f0-9]{10})', async function (request, reply) {
        if (String(request && request.method || '').toUpperCase() === 'OPTIONS') return reply.code(204).send();
        const id = request && request.params ? String(request.params.id || '').trim() : '';
        const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(id) : null;
        const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
        if (!id || !p) return reply.code(404).send({ error: 'online runtime not found', id });
        setRuntimeHintCookie(reply, id);
        return proxyToPort(request, reply, p, '/', id);
    });
    fastify.all('/:id([a-f0-9]{10})/*', async function (request, reply) {
        if (String(request && request.method || '').toUpperCase() === 'OPTIONS') return reply.code(204).send();
        const id = request && request.params ? String(request.params.id || '').trim() : '';
        const port = fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts.get(id) : null;
        const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
        if (!id || !p) return reply.code(404).send({ error: 'online runtime not found', id });
        setRuntimeHintCookie(reply, id);

        const tail = request && request.params ? String(request.params['*'] || '') : '';
        const normalizedTail = String(tail || '').replace(/^\/+/, '');
        const m = /^spider\/([^/]+)\/(\d+)\//.exec(normalizedTail);
        if (m) {
            const key = m[1];
            const type = m[2];
            const isInit = normalizedTail === `spider/${key}/${type}/init`;
            if (!isInit) {
                try {
                    await ensureOnlineSpiderInited(id, p, key, type);
                } catch (_) {}
            }
        }
        const rawUrl = request && request.raw && typeof request.raw.url === 'string' ? request.raw.url : '';
        const parts = splitRawUrl(rawUrl);
        const encodedTail = stripPrefixFromRawPath(parts.path, `/${id}`);
        const forwardPath = `/${encodedTail || ''}${parts.query || ''}`;
        return proxyToPort(request, reply, p, forwardPath, id);
    });

    // Online runtime routes must be accessed via an explicit id prefix.
    fastify.setNotFoundHandler(async function (request, reply) {
        // Security: do not leak runtime ids or routing hints for unregistered routes.
        return reply.code(403).send({ error: 'forbidden' });
    });
}

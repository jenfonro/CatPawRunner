import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { findAvailablePortInRange } from '../../util/tool.js';
import { applyOnlineConfigs, promoteOnlineStagedScript, discardOnlineStagedScript } from '../../util/onlineConfigStore.js';
import {
    startOnlineRuntime,
    stopOnlineRuntime,
    stopAllOnlineRuntimes,
    setOnlineRuntimeEntry,
    broadcastOnlineRuntimeMockConfig,
    broadcastOnlineRuntimeProxyConfig,
    broadcastOnlineRuntimePacketCaptureConfig,
    withOnlineRuntimeOpsLock,
} from '../../util/onlineRuntime.js';

const onlineConfigUpdateInFlightIds = new Set();

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
        if (!filePath || !fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function atomicWriteFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.resolve(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

function writeJsonFileAtomic(filePath, obj) {
    const root = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    atomicWriteFile(filePath, `${JSON.stringify(root, null, 2)}\n`);
}

function stableHashShort(input) {
    const s = String(input || '');
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

function sanitizeNameSeedForId(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const base = path.basename(raw);
    return base.replace(/\s+/g, ' ').trim();
}

function buildAutoOnlineRuntimeId(name, urlStr, used) {
    const usedSet = used && typeof used.has === 'function' ? used : new Set();
    const nameSeed = sanitizeNameSeedForId(name).toLowerCase();
    const urlSeed = String(urlStr || '').trim();
    const pick = (seed) => stableHashShort(seed);

    const primary = pick(nameSeed ? `name:${nameSeed}` : `url:${urlSeed}`);
    if (!usedSet.has(primary)) {
        usedSet.add(primary);
        return primary;
    }

    const secondary = pick(`name+url:${nameSeed}:${urlSeed}`);
    if (!usedSet.has(secondary)) {
        usedSet.add(secondary);
        return secondary;
    }

    for (let n = 1; n <= 10000; n += 1) {
        const next = pick(`name+url:${nameSeed}:${urlSeed}#${n}`);
        if (usedSet.has(next)) continue;
        usedSet.add(next);
        return next;
    }

    const fallback = pick(`name+url:${nameSeed}:${urlSeed}:overflow`);
    usedSet.add(fallback);
    return fallback;
}

function save139AuthorizationToConfig(rootDir, authorization) {
    const root = rootDir ? String(rootDir) : '';
    const auth = typeof authorization === 'string' ? authorization.trim() : '';
    if (!root) throw new Error('invalid runtime root');
    if (!auth) throw new Error('missing authorization');

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

    const account =
        next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
    const p139 =
        account['139'] && typeof account['139'] === 'object' && account['139'] && !Array.isArray(account['139'])
            ? { ...account['139'] }
            : {};

    p139.authorization = auth;
    account['139'] = p139;
    next.account = account;

    writeJsonFileAtomic(cfgPath, next);
}

function savePanCredentialToConfig(rootDir, key, value) {
    const root = rootDir ? String(rootDir) : '';
    const panKey = typeof key === 'string' ? key.trim() : '';
    const v = value && typeof value === 'object' ? value : {};
    if (!root) throw new Error('invalid runtime root');
    if (!panKey) throw new Error('invalid pan key');

    const cookie = typeof v.cookie === 'string' ? v.cookie.trim() : '';
    const authorization = typeof v.authorization === 'string' ? v.authorization.trim() : '';
    const username = typeof v.username === 'string' ? v.username : '';
    const password = typeof v.password === 'string' ? v.password : '';

    if (!cookie && !authorization && !(username && password)) throw new Error('empty credential');

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

    const account =
        next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
    const prev =
        account[panKey] && typeof account[panKey] === 'object' && account[panKey] && !Array.isArray(account[panKey])
            ? { ...account[panKey] }
            : {};

    if (cookie) prev.cookie = cookie;
    if (authorization) prev.authorization = authorization;
    if (username && password) {
        prev.username = username;
        prev.password = password;
    }
    account[panKey] = prev;
    next.account = account;

    writeJsonFileAtomic(cfgPath, next);
}

function saveQuarkTvCredentialToConfig(rootDir, value) {
    const root = rootDir ? String(rootDir) : '';
    const v = value && typeof value === 'object' ? value : {};
    if (!root) throw new Error('invalid runtime root');

    const refreshToken =
        typeof v.refresh_token === 'string'
            ? v.refresh_token.trim()
            : typeof v.refreshToken === 'string'
              ? v.refreshToken.trim()
              : '';
    const deviceId =
        typeof v.device_id === 'string'
            ? v.device_id.trim()
            : typeof v.deviceId === 'string'
              ? v.deviceId.trim()
              : '';

    if (!refreshToken || !deviceId) throw new Error('missing quark_tv refresh_token/device_id');

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

    const account =
        next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
    const prev =
        account.quark_tv && typeof account.quark_tv === 'object' && account.quark_tv && !Array.isArray(account.quark_tv)
            ? { ...account.quark_tv }
            : {};

    prev.refresh_token = refreshToken;
    prev.device_id = deviceId;
    // Reset access_token so the next request will refresh using the new refresh_token/device_id.
    prev.access_token = '';
    prev.access_token_exp_at = 0;

    account.quark_tv = prev;
    next.account = account;

    writeJsonFileAtomic(cfgPath, next);
}

function saveUcTvCredentialToConfig(rootDir, value) {
    const root = rootDir ? String(rootDir) : '';
    const v = value && typeof value === 'object' ? value : {};
    if (!root) throw new Error('invalid runtime root');

    const refreshToken =
        typeof v.refresh_token === 'string'
            ? v.refresh_token.trim()
            : typeof v.refreshToken === 'string'
              ? v.refreshToken.trim()
              : '';
    const deviceId =
        typeof v.device_id === 'string'
            ? v.device_id.trim()
            : typeof v.deviceId === 'string'
              ? v.deviceId.trim()
              : '';

    if (!refreshToken || !deviceId) throw new Error('missing uc_tv refresh_token/device_id');

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

    const account =
        next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
    const prev =
        account.uc_tv && typeof account.uc_tv === 'object' && account.uc_tv && !Array.isArray(account.uc_tv) ? { ...account.uc_tv } : {};

    prev.refresh_token = refreshToken;
    prev.device_id = deviceId;
    // Reset access_token so the next request will refresh using the new refresh_token/device_id.
    prev.access_token = '';
    prev.access_token_exp_at = 0;

    account.uc_tv = prev;
    next.account = account;

    writeJsonFileAtomic(cfgPath, next);
}

function normalizeOnlineConfigsInput(body) {
    const b = body && typeof body === 'object' ? body : {};
    const v = Object.prototype.hasOwnProperty.call(b, 'onlineConfigs')
        ? b.onlineConfigs
        : Object.prototype.hasOwnProperty.call(b, 'online_configs')
          ? b.online_configs
          : undefined;
    if (v === undefined) return { provided: false, list: [] };
    if (v == null) return { provided: true, list: [] };
    if (!Array.isArray(v)) return { provided: true, list: null };
    return { provided: true, list: v };
}

function normalizeOnlineConfigItem(raw) {
    if (typeof raw === 'string') {
        const url = raw.trim();
        return { url, name: '', id: '' };
    }
    const it = raw && typeof raw === 'object' ? raw : {};
    const url = typeof it.url === 'string' ? it.url.trim() : '';
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    const id = typeof it.id === 'string' ? it.id.trim() : '';
    return { url, name, id };
}

function parseJsonSafe(text) {
    try {
        const t = typeof text === 'string' ? text : '';
        return t && t.trim() ? JSON.parse(t) : null;
    } catch (_) {
        return null;
    }
}

function readSettingsFromConfig(root) {
    const cfg = root && typeof root === 'object' ? root : {};
    const rawSiteProxy = cfg.siteProxy && typeof cfg.siteProxy === 'object' && !Array.isArray(cfg.siteProxy) ? cfg.siteProxy : {};
    const siteProxy = {};
    for (const k of Object.keys(rawSiteProxy || {})) {
        const key = String(k || '').trim();
        const val = rawSiteProxy[k];
        if (!key) continue;
        if (typeof val !== 'string') continue;
        siteProxy[key] = val;
    }
    return {
        proxy: typeof cfg.proxy === 'string' ? cfg.proxy : '',
        siteProxy,
        disable_proxy: !!cfg.disable_proxy,
        pan_mock: !!cfg.pan_mock,
        packet_capture: !!cfg.packet_capture,
        panBuiltinResolverEnabled: !!cfg.panBuiltinResolverEnabled,
        goProxyApi: typeof cfg.goProxyApi === 'string' ? cfg.goProxyApi : '',
        corsAllowOrigins: Array.isArray(cfg.corsAllowOrigins) ? cfg.corsAllowOrigins : [],
        corsAllowCredentials: !!cfg.corsAllowCredentials,
    };
}

function readOnlineConfigsFromConfig(root) {
    const cfg = root && typeof root === 'object' ? root : {};
    const list = Array.isArray(cfg.onlineConfigs) ? cfg.onlineConfigs : [];
    return list
        .filter((it) => it && typeof it === 'object')
        .map((it) => {
            const url = typeof it.url === 'string' ? it.url : '';
            const name = typeof it.name === 'string' ? it.name : '';
            const id = typeof it.id === 'string' && it.id.trim() ? it.id.trim() : '';
            const status = typeof it.status === 'string' && it.status.trim() ? it.status.trim() : 'unchecked';
            const message = typeof it.message === 'string' && it.message.trim() ? it.message.trim() : '';
            const checkedAt = Number.isFinite(Number(it.checkedAt)) ? Math.trunc(Number(it.checkedAt)) : 0;
            const updateAt = Number.isFinite(Number(it.updateAt)) ? Math.trunc(Number(it.updateAt)) : 0;
            const updateResult = typeof it.updateResult === 'string' && it.updateResult.trim() ? it.updateResult.trim() : '';
            const localMd5 = typeof it.localMd5 === 'string' && it.localMd5.trim() ? it.localMd5.trim() : '';
            const remoteMd5 = typeof it.remoteMd5 === 'string' && it.remoteMd5.trim() ? it.remoteMd5.trim() : '';
            const changed = typeof it.changed === 'boolean' ? it.changed : undefined;
            const updated = typeof it.updated === 'boolean' ? it.updated : undefined;
            return {
                url,
                name,
                ...(id ? { id } : {}),
                status,
                ...(message ? { message } : {}),
                ...(checkedAt > 0 ? { checkedAt } : {}),
                ...(updateAt > 0 ? { updateAt } : {}),
                ...(updateResult ? { updateResult } : {}),
                ...(localMd5 ? { localMd5 } : {}),
                ...(remoteMd5 ? { remoteMd5 } : {}),
                ...(changed === undefined ? {} : { changed }),
                ...(updated === undefined ? {} : { updated }),
            };
        })
        .filter((it) => it.url);
}

function persistOnlineConfigUpdateResults(rootDir, onlineResults = []) {
    const root = rootDir ? String(rootDir) : '';
    if (!root) return [];
    const list = Array.isArray(onlineResults) ? onlineResults : [];
    if (!list.length) return [];

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const prevList = Array.isArray(cfgRoot.onlineConfigs) ? cfgRoot.onlineConfigs : [];
    if (!prevList.length) return [];

    const byId = new Map();
    const byUrl = new Map();
    list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        const id = typeof it.id === 'string' ? it.id.trim() : '';
        const url = typeof it.url === 'string' ? it.url.trim() : '';
        if (id) byId.set(id, it);
        if (url) byUrl.set(url, it);
    });

    let changedAny = false;
    const nextList = prevList.map((raw) => {
        const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : raw;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        const hit = (id && byId.get(id)) || (url && byUrl.get(url)) || null;
        if (!hit || typeof hit !== 'object') return item;

        const checkedAt = Number.isFinite(Number(hit.checkedAt)) ? Math.trunc(Number(hit.checkedAt)) : Date.now();
        const updateAtRaw = Number.isFinite(Number(hit.updateAt)) ? Math.trunc(Number(hit.updateAt)) : checkedAt;
        const updateAt = updateAtRaw > 0 ? updateAtRaw : checkedAt;
        const status = typeof hit.status === 'string' && hit.status.trim() ? hit.status.trim() : 'unchecked';
        const message = typeof hit.message === 'string' ? hit.message.trim() : '';
        const updateResult = typeof hit.updateResult === 'string' ? hit.updateResult.trim() : '';
        const localMd5 = typeof hit.localMd5 === 'string' ? hit.localMd5.trim() : '';
        const remoteMd5 = typeof hit.remoteMd5 === 'string' ? hit.remoteMd5.trim() : '';
        const changed = typeof hit.changed === 'boolean' ? hit.changed : false;
        const updated = typeof hit.updated === 'boolean' ? hit.updated : false;

        item.status = status;
        item.checkedAt = checkedAt > 0 ? checkedAt : Date.now();
        item.updateAt = updateAt > 0 ? updateAt : item.checkedAt;
        item.updateResult = updateResult || '';
        item.changed = !!changed;
        item.updated = !!updated;
        item.localMd5 = localMd5 || '';
        item.remoteMd5 = remoteMd5 || '';
        if (message) item.message = message;
        else delete item.message;

        changedAny = true;
        return item;
    });

    if (changedAny) {
        try {
            writeJsonFileAtomic(cfgPath, { ...cfgRoot, onlineConfigs: nextList });
        } catch (_) {}
    }

    const cfgAfter = readJsonFileSafe(cfgPath) || cfgRoot;
    return readOnlineConfigsFromConfig(cfgAfter);
}

async function readRuntimeHealthById(fastify, items = []) {
    const out = new Map();
    try {
        const list = Array.isArray(items) ? items : [];
        const portsMap =
            fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function'
                ? fastify.onlineRuntimePorts
                : null;
        if (!portsMap) return out;

        const ids = Array.from(
            new Set(
                list
                    .map((it) => (it && typeof it.id === 'string' ? it.id.trim() : ''))
                    .filter(Boolean)
            )
        );
        for (const id of ids) {
            const port = Number(portsMap.get(id) || 0);
            if (!Number.isFinite(port) || port <= 0) continue;
            try {
                // Keep this short; this endpoint is used by dashboard refresh.
                // eslint-disable-next-line no-await-in-loop
                const cfg = await httpGetJson(`http://127.0.0.1:${port}/full-config`, { timeoutMs: 1500 });
                if (cfg && typeof cfg === 'object') out.set(id, true);
            } catch (_) {}
        }
    } catch (_) {}
    return out;
}

async function waitRuntimeReadyById(fastify, runtimeId, options = {}) {
    const id = typeof runtimeId === 'string' ? runtimeId.trim() : '';
    if (!id) return { ok: false, message: 'invalid runtime id', port: 0 };
    const portsMap =
        fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function'
            ? fastify.onlineRuntimePorts
            : null;
    if (!portsMap) return { ok: false, message: 'onlineRuntimePorts not available', port: 0 };

    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(500, Math.trunc(Number(options.timeoutMs))) : 30000;
    const probeTimeoutMs = Number.isFinite(Number(options.probeTimeoutMs))
        ? Math.max(200, Math.trunc(Number(options.probeTimeoutMs)))
        : 2000;
    const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Math.max(100, Math.trunc(Number(options.intervalMs))) : 500;

    const deadline = Date.now() + timeoutMs;
    let lastErr = 'unreachable';
    while (Date.now() < deadline) {
        const port = Number(portsMap.get(id) || 0);
        if (Number.isFinite(port) && port > 0) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const cfg = await httpGetJson(`http://127.0.0.1:${port}/full-config`, { timeoutMs: probeTimeoutMs });
                if (cfg && typeof cfg === 'object') return { ok: true, message: '', port };
                lastErr = 'invalid full-config';
            } catch (e) {
                lastErr = e && e.message ? String(e.message) : 'unreachable';
            }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
    const finalPort = Number(portsMap.get(id) || 0);
    return { ok: false, message: lastErr || 'timeout', port: Number.isFinite(finalPort) ? finalPort : 0 };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(Number(ms) || 0))));
}

function httpGetJson(urlStr, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(100, Math.trunc(Number(opts.timeoutMs))) : 5000;
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(String(urlStr || ''));
        } catch (_) {
            reject(new Error('invalid url'));
            return;
        }
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(
            {
                method: 'GET',
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: `${u.pathname || '/'}${u.search || ''}`,
                headers: {
                    accept: 'application/json',
                    'accept-encoding': 'identity',
                },
            },
            (res) => {
                const status = res ? Number(res.statusCode || 0) : 0;
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (!(status >= 200 && status < 300)) {
                            const e = new Error(`bad status: ${status || 'unknown'}`);
                            e.status = status;
                            e.body = text;
                            reject(e);
                            return;
                        }
                        const parsed = text && text.trim() ? JSON.parse(text) : null;
                        resolve(parsed);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            try {
                req.destroy(new Error('timeout'));
            } catch (_) {}
        });
        req.end();
    });
}

function httpRequestJson(urlStr, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const method = typeof opts.method === 'string' && opts.method.trim() ? opts.method.trim().toUpperCase() : 'GET';
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(100, Math.trunc(Number(opts.timeoutMs))) : 8000;
    const headersIn = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
    const bodyObj = Object.prototype.hasOwnProperty.call(opts, 'body') ? opts.body : undefined;
    const bodyText = bodyObj == null ? '' : typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);

    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(String(urlStr || ''));
        } catch (_) {
            reject(new Error('invalid url'));
            return;
        }
        const mod = u.protocol === 'https:' ? https : http;
        const headers = {
            accept: 'application/json',
            'accept-encoding': 'identity',
            ...headersIn,
        };
        if (bodyText && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
        if (bodyText) headers['content-length'] = Buffer.byteLength(bodyText, 'utf8');

        const req = mod.request(
            {
                method,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: `${u.pathname || '/'}${u.search || ''}`,
                headers,
            },
            (res) => {
                const status = res ? Number(res.statusCode || 0) : 0;
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        const parsed = text && text.trim() ? JSON.parse(text) : null;
                        resolve({ status, data: parsed, raw: text });
                    } catch (e) {
                        resolve({ status, data: null, raw: '' });
                    }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            try {
                req.destroy(new Error('timeout'));
            } catch (_) {}
        });
        if (bodyText && method !== 'GET' && method !== 'HEAD') req.end(bodyText);
        else req.end();
    });
}

function unwrapWebsiteResp(raw) {
    const obj = raw && typeof raw === 'object' ? raw : null;
    if (!obj) return { ok: false, data: null, message: 'empty response' };
    if (Object.prototype.hasOwnProperty.call(obj, 'code')) {
        const code = Number(obj.code);
        if (code === 0) return { ok: true, data: obj.data, message: '' };
        const msg = obj.message || obj.desc || `code=${String(obj.code)}`;
        return { ok: false, data: obj.data, message: String(msg || '') };
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'success')) {
        const ok = !!obj.success;
        return { ok, data: obj, message: ok ? '' : String(obj.message || 'failed') };
    }
    return { ok: true, data: obj, message: '' };
}

async function syncOnlineRuntimesNow(fastify, rootDir, options = {}) {
    return withOnlineRuntimeOpsLock(async () => {
        const forceRemoteCheck = !!(options && options.forceRemoteCheck);
        const res = await applyOnlineConfigs({ rootDir, forceRemoteCheck });

        const desired = Array.isArray(res && res.resolved) ? res.resolved.filter((r) => r && r.id && r.destPath) : [];
        const desiredIds = new Set(desired.map((r) => String(r.id)));

        const portsMap =
            fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function'
                ? fastify.onlineRuntimePorts
                : null;
        if (!portsMap) return { ok: false, message: 'onlineRuntimePorts not available', applied: res };

        if (!desiredIds.size) {
            stopAllOnlineRuntimes();
            portsMap.clear();
            return { ok: true, applied: res, runtimes: [] };
        }

        // Stop removed runtimes.
        for (const [id] of portsMap.entries()) {
            if (!desiredIds.has(id)) {
                stopOnlineRuntime(id);
                portsMap.delete(id);
            }
        }

        // Start/restart desired runtimes.
        const runtimes = [];
        for (const r of desired) {
            const id = String(r.id);
            const curPort = Number(portsMap.get(id) || 0);
            const hasCurrent = Number.isFinite(curPort) && curPort > 0;
            const needPort = !hasCurrent;
            const port = needPort ? await findAvailablePortInRange(30000, 39999) : curPort;
            const stagedPath = typeof r.stagedPath === 'string' && r.stagedPath.trim() ? path.resolve(r.stagedPath.trim()) : '';
            const shouldRestart = needPort || !!r.needsReload || !!stagedPath;
            const entryToStart = stagedPath || path.resolve(r.destPath);

            const started = await startOnlineRuntime({ id, port, entry: entryToStart, entryFn: r.entryFn || '' });
            const switched = !!(started && started.started && Number(started.port) > 0);
            const keptPrevious = !switched && hasCurrent;

            let promoteOk = false;
            let promoteErr = '';
            if (stagedPath) {
                if (switched) {
                    const promoted = promoteOnlineStagedScript({
                        stagedPath,
                        destPath: r.destPath,
                        metaPath: r.metaPath,
                        url: r.url,
                        remoteMd5: r.remoteMd5 || '',
                        checkedAt: r.checkedAt,
                    });
                    if (promoted && promoted.ok) {
                        promoteOk = true;
                        setOnlineRuntimeEntry(id, r.destPath);
                    } else {
                        promoteErr = promoted && promoted.message ? String(promoted.message) : 'promote failed';
                    }
                } else {
                    discardOnlineStagedScript({ stagedPath });
                }
            }

            if (switched) portsMap.set(id, Number(started.port));
            else if (needPort) portsMap.delete(id);
            // If restart failed but previous runtime exists, keep the old port mapping as-is.

            let message = started && started.reason ? String(started.reason) : '';
            if (stagedPath && !switched && keptPrevious) {
                message = message
                    ? `new script start failed, keeping previous runtime (${message})`
                    : 'new script start failed, keeping previous runtime';
            }
            if (promoteErr) {
                message = message ? `${message}; ${promoteErr}` : promoteErr;
            }

            const effectivePort = switched ? Number(started.port) : hasCurrent ? curPort : 0;
            const changed = !!r.changed;
            const updated = stagedPath ? switched && promoteOk : switched && changed;
            const checkedAt = Number.isFinite(Number(r.checkedAt)) ? Math.trunc(Number(r.checkedAt)) : Date.now();

            runtimes.push({
                id,
                port: effectivePort > 0 ? effectivePort : 0,
                entry: path.resolve(r.destPath),
                testEntry: entryToStart,
                ok: switched || keptPrevious,
                restarted: shouldRestart,
                updated,
                changed,
                remoteChecked: !!r.remoteChecked,
                usedStaged: !!stagedPath,
                promoted: stagedPath ? promoteOk : false,
                keptPrevious,
                message,
                lastStage: started && started.lastStage ? String(started.lastStage) : '',
                checkedAt,
                localMd5: typeof r.localMd5 === 'string' ? r.localMd5 : '',
                remoteMd5: typeof r.remoteMd5 === 'string' ? r.remoteMd5 : '',
            });
        }

        return { ok: true, applied: res, runtimes };
    });
}

async function handleAdminFullConfig(fastify, reply) {
    const empty = {
        video: { sites: [] },
        read: { sites: [] },
        comic: { sites: [] },
        music: { sites: [] },
        pan: { sites: [] },
        color: [],
    };

    const ports =
        fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.entries === 'function'
            ? Array.from(fastify.onlineRuntimePorts.entries())
            : [];
    if (!ports.length) return reply.send(empty);

    const merged = JSON.parse(JSON.stringify(empty));
    const seen = new Set();

    for (const [id, port] of ports) {
        const runtimeId = String(id || '').trim();
        const p = Number(port || 0);
        if (!runtimeId || !Number.isFinite(p) || p <= 0) continue;

        let cfg;
        try {
            cfg = await httpGetJson(`http://127.0.0.1:${p}/full-config`, { timeoutMs: 6000 });
        } catch (e) {
            const status = e && Number.isFinite(Number(e.status)) ? Number(e.status) : 0;
            // Some third-party runtimes expose `/config` but not `/full-config`.
            if (status === 404) {
                try {
                    cfg = await httpGetJson(`http://127.0.0.1:${p}/config`, { timeoutMs: 6000 });
                } catch (_) {
                    continue;
                }
            } else {
                continue;
            }
        }
        if (!cfg || typeof cfg !== 'object') continue;

        if (Array.isArray(cfg.color) && cfg.color.length && (!Array.isArray(merged.color) || merged.color.length === 0)) {
            merged.color = cfg.color;
        }

        const mergeSites = (key) => {
            const list = cfg && cfg[key] && Array.isArray(cfg[key].sites) ? cfg[key].sites : [];
            if (!merged[key] || !Array.isArray(merged[key].sites)) merged[key] = { sites: [] };
            list.forEach((site) => {
                if (!site || typeof site !== 'object') return;
                const api = typeof site.api === 'string' ? site.api.trim() : '';
                const rewritten = api ? `/${runtimeId}${api.startsWith('/') ? api : `/${api}`}` : `/${runtimeId}/spider`;
                const skey = `${runtimeId}:${String(site.key || '')}:${String(site.type || '')}:${rewritten}`;
                if (seen.has(skey)) return;
                seen.add(skey);
                merged[key].sites.push({
                    ...site,
                    api: rewritten,
                    runtimeId,
                });
            });
        };

        mergeSites('video');
        mergeSites('read');
        mergeSites('comic');
        mergeSites('music');
        mergeSites('pan');
    }

    return reply.send(merged);
}

export const apiPlugins = [
    {
        prefix: '/admin',
        plugin: async function adminPlugin(fastify) {
            fastify.get('/settings', async function (_request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const cfg = readJsonFileSafe(cfgPath) || {};
                const onlineConfigsRaw = readOnlineConfigsFromConfig(cfg);
                const runtimeHealth = await readRuntimeHealthById(fastify, onlineConfigsRaw);
                const stickyFailedResults = new Set(['download_failed', 'runtime_failed', 'kept_previous', 'promote_failed']);
                const onlineConfigs = onlineConfigsRaw.map((it) => {
                    if (!it || typeof it !== 'object') return it;
                    const id = typeof it.id === 'string' ? it.id.trim() : '';
                    if (!id || !runtimeHealth.get(id)) return it;
                    const status = typeof it.status === 'string' ? it.status.trim() : '';
                    const updateResult = typeof it.updateResult === 'string' ? it.updateResult.trim() : '';
                    if (status === 'error' && stickyFailedResults.has(updateResult)) return it;
                    // If runtime is currently reachable, avoid stale persisted "runtime failed".
                    const next = { ...it, status: 'pass' };
                    try {
                        delete next.message;
                    } catch (_) {}
                    return next;
                });
                return reply.send({
                    success: true,
                    settings: readSettingsFromConfig(cfg),
                    onlineConfigs,
                });
            });

            fastify.put('/settings', async function (request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const prev = readJsonFileSafe(cfgPath) || {};

                const body = request && request.body && typeof request.body === 'object' ? request.body : {};
                const next = { ...prev };

                if (Object.prototype.hasOwnProperty.call(body, 'proxy')) next.proxy = typeof body.proxy === 'string' ? body.proxy : '';
                if (Object.prototype.hasOwnProperty.call(body, 'siteProxy')) {
                    const raw = body.siteProxy;
                    let obj = null;
                    if (raw == null) obj = {};
                    else if (typeof raw === 'string') obj = parseJsonSafe(raw);
                    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) obj = raw;
                    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
                        return reply.code(400).send({ success: false, message: 'siteProxy must be an object or JSON object string' });
                    }
                    const out = {};
                    for (const k of Object.keys(obj)) {
                        const key = String(k || '').trim();
                        const val = obj[k];
                        if (!key) continue;
                        if (typeof val !== 'string') continue;
                        out[key] = val;
                    }
                    next.siteProxy = out;
                }
                if (Object.prototype.hasOwnProperty.call(body, 'disable_proxy')) next.disable_proxy = !!body.disable_proxy;
                if (Object.prototype.hasOwnProperty.call(body, 'pan_mock')) next.pan_mock = !!body.pan_mock;
                if (Object.prototype.hasOwnProperty.call(body, 'packet_capture')) next.packet_capture = !!body.packet_capture;
                if (Object.prototype.hasOwnProperty.call(body, 'panBuiltinResolverEnabled'))
                    next.panBuiltinResolverEnabled = !!body.panBuiltinResolverEnabled;
                if (Object.prototype.hasOwnProperty.call(body, 'goProxyApi'))
                    next.goProxyApi = typeof body.goProxyApi === 'string' ? body.goProxyApi : '';
                if (Object.prototype.hasOwnProperty.call(body, 'corsAllowOrigins'))
                    next.corsAllowOrigins = Array.isArray(body.corsAllowOrigins) ? body.corsAllowOrigins : [];
                if (Object.prototype.hasOwnProperty.call(body, 'corsAllowCredentials')) next.corsAllowCredentials = !!body.corsAllowCredentials;

                const onlineInput = normalizeOnlineConfigsInput(body);
                let requestOnlineConfigIds = [];
                if (onlineInput.provided) {
                    if (onlineInput.list === null) {
                        return reply.code(400).send({ success: false, message: 'onlineConfigs must be an array' });
                    }
                    const prevList = Array.isArray(prev.onlineConfigs) ? prev.onlineConfigs : [];
                    const prevByUrl = new Map(
                        prevList
                            .filter((it) => it && typeof it === 'object')
                            .map((it) => [typeof it.url === 'string' ? it.url.trim() : '', it])
                            .filter(([u]) => u)
                    );
                    const out = [];
                    const usedIds = new Set();
                    for (const raw of onlineInput.list || []) {
                        const norm = normalizeOnlineConfigItem(raw);
                        if (!norm || !norm.url) continue;
                        const prevMatch = prevByUrl.get(norm.url);
                        const prevId = prevMatch && typeof prevMatch.id === 'string' && prevMatch.id.trim() ? prevMatch.id.trim() : '';
                        const incomingId = typeof norm.id === 'string' && norm.id.trim() ? norm.id.trim() : '';
                        let idEff = incomingId || prevId || '';
                        if (idEff) {
                            if (usedIds.has(idEff)) idEff = buildAutoOnlineRuntimeId(norm.name || idEff, norm.url, usedIds);
                            else usedIds.add(idEff);
                        } else {
                            idEff = buildAutoOnlineRuntimeId(norm.name, norm.url, usedIds);
                        }
                        out.push({
                            url: norm.url,
                            name: norm.name || '',
                            id: idEff,
                            status: 'unchecked',
                            checkedAt: 0,
                            updateAt: 0,
                            updateResult: 'pending',
                            changed: false,
                            updated: false,
                            localMd5: '',
                            remoteMd5: '',
                        });
                    }
                    next.onlineConfigs = out;
                    requestOnlineConfigIds = Array.from(
                        new Set(
                            out
                                .map((it) => (it && typeof it.id === 'string' ? it.id.trim() : ''))
                                .filter(Boolean)
                        )
                    );
                }

                const claimedOnlineUpdateIds = [];
                if (onlineInput.provided && requestOnlineConfigIds.length) {
                    const conflictIds = requestOnlineConfigIds.filter((id) => onlineConfigUpdateInFlightIds.has(id));
                    if (conflictIds.length) {
                        const cfgNow = readJsonFileSafe(cfgPath) || prev;
                        return reply.code(202).send({
                            success: true,
                            skipped: true,
                            reason: 'online_update_in_progress',
                            conflictIds,
                            settings: readSettingsFromConfig(cfgNow),
                            onlineConfigs: readOnlineConfigsFromConfig(cfgNow),
                        });
                    }
                    requestOnlineConfigIds.forEach((id) => {
                        onlineConfigUpdateInFlightIds.add(id);
                        claimedOnlineUpdateIds.push(id);
                    });
                }

                try {
                    try {
                        writeJsonFileAtomic(cfgPath, next);
                    } catch (e) {
                        const msg = e && e.message ? String(e.message) : 'config write failed';
                        return reply.code(500).send({ success: false, message: msg });
                    }
                    try {
                        // Allow toggling pan mock without restarting online runtimes.
                        broadcastOnlineRuntimeMockConfig({ rootDir });
                    } catch (_) {}
                    try {
                        // Allow changing proxy settings without restarting online runtimes.
                        broadcastOnlineRuntimeProxyConfig({ rootDir });
                    } catch (_) {}
                    try {
                        // Allow toggling packet capture without restarting online runtimes.
                        broadcastOnlineRuntimePacketCaptureConfig({ rootDir });
                    } catch (_) {}

                    let onlineResults = null;
                    if (onlineInput.provided) {
                        try {
                            const sync = await syncOnlineRuntimesNow(fastify, rootDir, { forceRemoteCheck: true });
                            const applied = sync && sync.applied ? sync.applied : null;
                            const resolved = applied && Array.isArray(applied.resolved) ? applied.resolved : [];
                            const runtimes = sync && Array.isArray(sync.runtimes) ? sync.runtimes : [];
                            const runtimeById = new Map(
                                runtimes
                                    .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim())
                                    .map((r) => [r.id.trim(), r])
                            );

                            onlineResults = [];
                            for (const it of resolved) {
                                const url = typeof it.url === 'string' ? it.url : '';
                                const name = typeof it.name === 'string' ? it.name : '';
                                const id = typeof it.id === 'string' ? it.id : '';
                                if (!url) continue;
                                const checkedAt = Number.isFinite(Number(it.checkedAt)) ? Math.trunc(Number(it.checkedAt)) : Date.now();
                                const localMd5 = typeof it.localMd5 === 'string' ? it.localMd5 : '';
                                const remoteMd5 = typeof it.remoteMd5 === 'string' ? it.remoteMd5 : '';
                                const changed = !!it.changed;
                                const usedStaged = !!(it.stagedPath && String(it.stagedPath).trim());

                                if (!it.ok) {
                                    onlineResults.push({
                                        url,
                                        name,
                                        ...(id ? { id } : {}),
                                        status: 'error',
                                        phase: 'download',
                                        message: typeof it.message === 'string' && it.message.trim() ? it.message.trim() : 'download failed',
                                        checkedAt,
                                        updateAt: checkedAt,
                                        updateResult: 'download_failed',
                                        changed,
                                        updated: false,
                                        localMd5,
                                        remoteMd5,
                                    });
                                    continue;
                                }

                                const rt = id ? runtimeById.get(id) : null;
                                let rtOk = !!(rt && rt.ok);
                                let rtPort = rt && Number.isFinite(Number(rt.port)) ? Math.max(1, Math.trunc(Number(rt.port))) : 0;
                                const entryBase = it.destPath ? path.basename(String(it.destPath)) : '';
                                let rtMessage =
                                    rt && typeof rt.message === 'string' && rt.message.trim()
                                        ? rt.message.trim()
                                        : rt && typeof rt.lastStage === 'string' && rt.lastStage.trim()
                                          ? `runtime not ready (stage=${rt.lastStage.trim()})`
                                          : 'runtime_not_ready';

                                // Restart handoff may report transient SIGTERM on the old child.
                                // Wait for the runtime to settle before declaring failure.
                                const mayBeTransientRestart =
                                    !rtOk &&
                                    !!id &&
                                    !!rt &&
                                    !rt.keptPrevious &&
                                    (rt.restarted ||
                                        rt.updated ||
                                        rtMessage === 'signal:SIGTERM' ||
                                        rtMessage === 'exit:null' ||
                                        rtMessage === 'runtime_not_ready');
                                if (mayBeTransientRestart) {
                                    // eslint-disable-next-line no-await-in-loop
                                    const settled = await waitRuntimeReadyById(fastify, id, {
                                        timeoutMs: 30000,
                                        probeTimeoutMs: 2500,
                                        intervalMs: 500,
                                    });
                                    if (settled.ok) {
                                        rtOk = true;
                                        rtPort = settled.port;
                                        rtMessage = '';
                                    } else if (settled.message) {
                                        rtMessage = settled.message;
                                    }
                                }

                                const keptPrevious = !!(rt && rt.keptPrevious);
                                const updated = !!(rt && rt.updated);
                                let status = rtOk ? 'pass' : 'error';
                                let phase = '';
                                let message = '';
                                let updateResult = 'unchanged';

                                if (usedStaged) {
                                    if (updated) {
                                        status = 'pass';
                                        updateResult = 'updated';
                                    } else if (keptPrevious) {
                                        status = 'error';
                                        phase = 'runtime';
                                        message = rtMessage || 'new script start failed, keeping previous runtime';
                                        updateResult = 'kept_previous';
                                    } else if (!rtOk) {
                                        status = 'error';
                                        phase = 'runtime';
                                        message = rtMessage;
                                        updateResult = 'runtime_failed';
                                    } else {
                                        status = 'pass';
                                        updateResult = 'updated';
                                    }
                                } else if (changed) {
                                    if (rtOk) {
                                        status = 'pass';
                                        updateResult = 'updated';
                                    } else {
                                        status = 'error';
                                        phase = 'runtime';
                                        message = rtMessage;
                                        updateResult = 'runtime_failed';
                                    }
                                } else {
                                    updateResult = rtOk ? 'unchanged' : 'runtime_failed';
                                    if (!rtOk) {
                                        phase = 'runtime';
                                        message = rtMessage;
                                    }
                                }

                                onlineResults.push({
                                    url,
                                    name,
                                    ...(id ? { id } : {}),
                                    status,
                                    ...(phase ? { phase } : {}),
                                    ...(message ? { message } : {}),
                                    checkedAt,
                                    updateAt: checkedAt,
                                    updateResult,
                                    changed,
                                    updated: updateResult === 'updated',
                                    localMd5,
                                    remoteMd5,
                                    runtime: { id, port: rtPort, entry: entryBase },
                                });
                            }
                            if (Array.isArray(onlineResults) && onlineResults.length) {
                                const persisted = persistOnlineConfigUpdateResults(rootDir, onlineResults);
                                if (Array.isArray(persisted) && persisted.length) onlineResults = persisted;
                            }
                        } catch (e) {
                            const msg = e && e.message ? String(e.message) : 'online sync failed';
                            onlineResults = [
                                {
                                    url: '',
                                    name: '',
                                    status: 'error',
                                    message: msg,
                                    checkedAt: Date.now(),
                                    updateAt: Date.now(),
                                    updateResult: 'runtime_failed',
                                    changed: false,
                                    updated: false,
                                },
                            ];
                        }
                    }

                    const cfgAfter = readJsonFileSafe(cfgPath) || next;
                    return reply.send({
                        success: true,
                        settings: readSettingsFromConfig(cfgAfter),
                        onlineConfigs: onlineResults || readOnlineConfigsFromConfig(cfgAfter),
                    });
                } finally {
                    claimedOnlineUpdateIds.forEach((id) => onlineConfigUpdateInFlightIds.delete(id));
                }
            });

            fastify.get('/full-config', async function (_request, reply) {
                return handleAdminFullConfig(fastify, reply);
            });

            // Sync pan credentials from MeowFilm into the running online runtime(s).
            // Payload: { pans: { [key]: { cookie? } | { username?, password? } | { refresh_token?, device_id? } } }
            fastify.post('/pan/sync', async function (request, reply) {
                const ports =
                    fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.entries === 'function'
                        ? Array.from(fastify.onlineRuntimePorts.entries())
                        : [];
                if (!ports.length) return reply.send({ success: true, okCount: 0, failCount: 0, results: [] });

                const body = request && request.body && typeof request.body === 'object' ? request.body : {};
                const store =
                    body && typeof body.pans === 'object' && body.pans && !Array.isArray(body.pans)
                        ? body.pans
                        : body && typeof body.settings === 'object' && body.settings && !Array.isArray(body.settings)
                          ? body.settings
                          : {};
                const keys = Object.keys(store || {}).filter(Boolean);
                if (!keys.length) return reply.send({ success: true, okCount: 0, failCount: 0, results: [] });

                // Build a panKey -> runtime map using `/website/pans/list` for deterministic routing.
                const panKeyToRuntime = new Map();
                for (const [runtimeIdRaw, portRaw] of ports) {
                    const runtimeId = String(runtimeIdRaw || '').trim();
                    const port = Number(portRaw || 0);
                    if (!runtimeId || !Number.isFinite(port) || port <= 0) continue;
                    let resp;
                    try {
                        resp = await httpGetJson(`http://127.0.0.1:${port}/website/pans/list`, { timeoutMs: 6000 });
                    } catch (_) {
                        continue;
                    }
                    const unwrapped = unwrapWebsiteResp(resp);
                    const list = Array.isArray(unwrapped.data)
                        ? unwrapped.data
                        : unwrapped.data && typeof unwrapped.data === 'object' && Array.isArray(unwrapped.data.list)
                          ? unwrapped.data.list
                          : [];
                    list.forEach((it) => {
                        if (!it || typeof it !== 'object') return;
                        const key = typeof it.key === 'string' ? it.key.trim() : '';
                        if (!key || panKeyToRuntime.has(key)) return;
                        panKeyToRuntime.set(key, { runtimeId, port });
                    });
                }

                const results = [];
                let okCount = 0;
                let failCount = 0;

                for (const keyRaw of keys) {
                    const key = String(keyRaw || '').trim();
                    if (!key) continue;
                    const websiteKey = key === '189' ? 'tianyi' : key;
                    const val = store && typeof store[key] === 'object' && store[key] ? store[key] : {};
                    const cookie = typeof val.cookie === 'string' ? val.cookie : '';
                    const authorization = typeof val.authorization === 'string' ? val.authorization : '';
                    const username = typeof val.username === 'string' ? val.username : '';
                    const password = typeof val.password === 'string' ? val.password : '';
                    const refreshToken =
                        typeof val.refresh_token === 'string'
                            ? val.refresh_token
                            : typeof val.refreshToken === 'string'
                              ? val.refreshToken
                              : '';
                    const deviceId =
                        typeof val.device_id === 'string'
                            ? val.device_id
                            : typeof val.deviceId === 'string'
                              ? val.deviceId
                              : '';

                    // Builtin 139 (移动云盘/和彩云) resolver:
                    // - not managed by `/website/{key}/...` routes
                    // - persisted into config.json so `/api/139/play` can read it.
                    if (key === '139') {
                        const nextAuth = (authorization || cookie || '').trim();
                        if (!nextAuth) {
                            results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                            continue;
                        }
                        try {
                            save139AuthorizationToConfig(resolveRuntimeRootDir(), nextAuth);
                            okCount += 1;
                            results.push({ key, ok: true, skipped: false, message: '' });
                        } catch (e) {
                            failCount += 1;
                            const msg = e && e.message ? String(e.message) : 'save failed';
                            results.push({ key, ok: false, skipped: false, message: msg });
                        }
                        continue;
                    }

                    // Builtin QuarkTV/UCTV (open-api-drive) resolver:
                    // - not managed by `/website/{key}/...` routes
                    // - persisted into config.json under account.{quark_tv|uc_tv} so `/api/{quark|uc}/*` can read it.
                    if (key === 'quark_tv') {
                        const rt = String(refreshToken || '').trim();
                        const dev = String(deviceId || '').trim();
                        if (!rt || !dev) {
                            results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                            continue;
                        }
                        try {
                            saveQuarkTvCredentialToConfig(resolveRuntimeRootDir(), { refresh_token: rt, device_id: dev });
                            okCount += 1;
                            results.push({ key, ok: true, skipped: false, message: '' });
                        } catch (e) {
                            failCount += 1;
                            const msg = e && e.message ? String(e.message) : 'save failed';
                            results.push({ key, ok: false, skipped: false, message: msg });
                        }
                        continue;
                    }

                    if (key === 'uc_tv') {
                        const rt = String(refreshToken || '').trim();
                        const dev = String(deviceId || '').trim();
                        if (!rt || !dev) {
                            results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                            continue;
                        }
                        try {
                            saveUcTvCredentialToConfig(resolveRuntimeRootDir(), { refresh_token: rt, device_id: dev });
                            okCount += 1;
                            results.push({ key, ok: true, skipped: false, message: '' });
                        } catch (e) {
                            failCount += 1;
                            const msg = e && e.message ? String(e.message) : 'save failed';
                            results.push({ key, ok: false, skipped: false, message: msg });
                        }
                        continue;
                    }

                    // Builtin baidu/quark/uc credentials are read from config.json; online scripts still use db.json.
                    if (key === 'baidu' || key === 'quark' || key === 'uc') {
                        const hasCredential = !!((username && password) || cookie);
                        if (!hasCredential) {
                            results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                            continue;
                        }
                        // Best-effort write config.json first; final status still depends on both.
                        // (Do not early-return here; keep `/website/{key}/{cookie|account}` sync for db.json.)
                    }

                    const type =
                        key === '189' ? 'account' : username && password ? 'account' : cookie ? 'cookie' : '';
                    if (!type) {
                        results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                        continue;
                    }
                    if (key === '189' && !(username && password)) {
                        results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                        continue;
                    }

                    const preferred = panKeyToRuntime.has(websiteKey) ? [panKeyToRuntime.get(websiteKey)] : [];
                    const candidates = preferred.length
                        ? preferred
                        : ports
                              .map(([rid, p]) => ({ runtimeId: String(rid || '').trim(), port: Number(p || 0) }))
                              .filter((r) => r.runtimeId && Number.isFinite(r.port) && r.port > 0);

                    let lastErr = '';
                    let saved = false;

                    // For builtin baidu/quark/uc/189: persist to config.json, but still sync to website for db.json.
                    let configOk = true;
                    let configErr = '';
                    if (key === 'baidu' || key === 'quark' || key === 'uc' || key === '189') {
                        try {
                            savePanCredentialToConfig(resolveRuntimeRootDir(), key, { cookie, username, password });
                        } catch (e) {
                            configOk = false;
                            configErr = e && e.message ? String(e.message) : 'config save failed';
                        }
                    }

                    for (const r of candidates) {
                        const endpoint = `http://127.0.0.1:${r.port}/website/${encodeURIComponent(websiteKey)}/${type}`;
                        const payload =
                            key === '189' ? { username, password } : type === 'account' ? { username, password } : { cookie };
                        let out;
                        try {
                            // eslint-disable-next-line no-await-in-loop
                            out = await httpRequestJson(endpoint, { method: 'PUT', body: payload, timeoutMs: 12000 });
                        } catch (e) {
                            lastErr = e && e.message ? String(e.message) : 'request failed';
                            continue;
                        }
                        if (!out || !(out.status >= 200 && out.status < 300)) {
                            lastErr = `http ${out && out.status ? out.status : 'unknown'}`;
                            continue;
                        }
                        const unwrapped = unwrapWebsiteResp(out.data);
                        if (unwrapped.ok) {
                            saved = true;
                            break;
                        }
                        lastErr = unwrapped.message || 'save failed';
                    }

                    if (saved && configOk) {
                        okCount += 1;
                        results.push({ key, ok: true, skipped: false, message: '' });
                    } else {
                        failCount += 1;
                        const msg = !configOk ? configErr || 'config save failed' : lastErr || 'save failed';
                        results.push({ key, ok: false, skipped: false, message: msg });
                    }
                }


                return reply.send({
                    success: true,
                    okCount,
                    failCount,
                    results,
                });
            });
        },
    },
];

export default apiPlugins;

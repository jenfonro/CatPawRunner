import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { findAvailablePortInRange } from '../../util/tool.js';
import { applyOnlineConfigs } from '../../util/onlineConfigStore.js';
import { startOnlineRuntime, stopOnlineRuntime, stopAllOnlineRuntimes } from '../../util/onlineRuntime.js';

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
        return { url, name: '' };
    }
    const it = raw && typeof raw === 'object' ? raw : {};
    const url = typeof it.url === 'string' ? it.url.trim() : '';
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    return { url, name };
}

function readSettingsFromConfig(root) {
    const cfg = root && typeof root === 'object' ? root : {};
    return {
        proxy: typeof cfg.proxy === 'string' ? cfg.proxy : '',
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
            return {
                url,
                name,
                ...(id ? { id } : {}),
                status,
                ...(message ? { message } : {}),
                ...(checkedAt > 0 ? { checkedAt } : {}),
            };
        })
        .filter((it) => it.url);
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

async function checkRuntimeHealthy(port, runtimeId, entryBaseName) {
    const p = Number.isFinite(Number(port)) ? Math.max(1, Math.trunc(Number(port))) : 0;
    if (!p) return { ok: false, message: 'invalid port' };

    const totalTimeoutMs = 30000;
    const perTryTimeoutMs = 2500;
    const retryDelayMs = 500;

    // Wait for the child server to start accepting connections.
    // Keep total wait bounded to avoid blocking the dashboard too long.
    const deadline = Date.now() + totalTimeoutMs;
    let lastErrMsg = 'unreachable';
    while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            return {
                ok: false,
                message: lastErrMsg || 'timeout',
                runtime: { id: runtimeId, port: p, entry: entryBaseName },
            };
        }

        const tryTimeoutMs = Math.max(100, Math.min(perTryTimeoutMs, remainingMs - 100));
        try {
            // eslint-disable-next-line no-await-in-loop
            const cfg = await httpGetJson(`http://127.0.0.1:${p}/full-config`, { timeoutMs: tryTimeoutMs });
            if (cfg && typeof cfg === 'object') {
                return { ok: true, message: '', runtime: { id: runtimeId, port: p, entry: entryBaseName } };
            }
        } catch (e) {
            lastErrMsg = e && e.message ? String(e.message) : 'unreachable';
        }

        const sleepMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
        // eslint-disable-next-line no-await-in-loop
        await sleep(sleepMs);
    }
}

async function syncOnlineRuntimesNow(fastify, rootDir) {
    const res = await applyOnlineConfigs({ rootDir });

    const desired = Array.isArray(res && res.resolved) ? res.resolved.filter((r) => r && r.id) : [];
    const desiredIds = new Set(desired.map((r) => String(r.id)));

    const portsMap =
        fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function' ? fastify.onlineRuntimePorts : null;
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
        const curPort = portsMap.get(id);
        const needPort = !curPort;
        const port = needPort ? await findAvailablePortInRange(30000, 39999) : curPort;
        const shouldRestart = needPort || !!r.downloaded;
        if (shouldRestart) {
            try {
                stopOnlineRuntime(id);
            } catch (_) {}
        }
        const started = await startOnlineRuntime({ id, port, entry: r.destPath });
        if (started && started.port) portsMap.set(id, started.port);
        else portsMap.delete(id);
        runtimes.push({ id, port: started && started.port ? started.port : port, entry: r.destPath, ok: !!(started && started.port) });
    }

    return { ok: true, applied: res, runtimes };
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
        } catch (_) {
            continue;
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
                return reply.send({
                    success: true,
                    settings: readSettingsFromConfig(cfg),
                    onlineConfigs: readOnlineConfigsFromConfig(cfg),
                });
            });

            fastify.put('/settings', async function (request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const prev = readJsonFileSafe(cfgPath) || {};

                const body = request && request.body && typeof request.body === 'object' ? request.body : {};
                const next = { ...prev };

                if (Object.prototype.hasOwnProperty.call(body, 'proxy')) next.proxy = typeof body.proxy === 'string' ? body.proxy : '';
                if (Object.prototype.hasOwnProperty.call(body, 'panBuiltinResolverEnabled'))
                    next.panBuiltinResolverEnabled = !!body.panBuiltinResolverEnabled;
                if (Object.prototype.hasOwnProperty.call(body, 'goProxyApi'))
                    next.goProxyApi = typeof body.goProxyApi === 'string' ? body.goProxyApi : '';
                if (Object.prototype.hasOwnProperty.call(body, 'corsAllowOrigins'))
                    next.corsAllowOrigins = Array.isArray(body.corsAllowOrigins) ? body.corsAllowOrigins : [];
                if (Object.prototype.hasOwnProperty.call(body, 'corsAllowCredentials')) next.corsAllowCredentials = !!body.corsAllowCredentials;

                const onlineInput = normalizeOnlineConfigsInput(body);
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
                    for (const raw of onlineInput.list || []) {
                        const norm = normalizeOnlineConfigItem(raw);
                        if (!norm || !norm.url) continue;
                        const prevMatch = prevByUrl.get(norm.url);
                        const prevId = prevMatch && typeof prevMatch.id === 'string' && prevMatch.id.trim() ? prevMatch.id.trim() : '';
                        const prevStatus =
                            prevMatch && typeof prevMatch.status === 'string' && prevMatch.status.trim()
                                ? prevMatch.status.trim()
                                : '';
                        const prevMessage =
                            prevMatch && typeof prevMatch.message === 'string' && prevMatch.message.trim()
                                ? prevMatch.message.trim()
                                : '';
                        const prevCheckedAt =
                            prevMatch && Number.isFinite(Number(prevMatch.checkedAt)) ? Math.trunc(Number(prevMatch.checkedAt)) : 0;
                        out.push({
                            url: norm.url,
                            name: norm.name || '',
                            ...(prevId ? { id: prevId } : {}),
                            ...(prevStatus ? { status: prevStatus } : { status: 'unchecked' }),
                            ...(prevMessage ? { message: prevMessage } : {}),
                            ...(prevCheckedAt > 0 ? { checkedAt: prevCheckedAt } : {}),
                        });
                    }
                    next.onlineConfigs = out;
                }

                try {
                    writeJsonFileAtomic(cfgPath, next);
                } catch (e) {
                    const msg = e && e.message ? String(e.message) : 'config write failed';
                    return reply.code(500).send({ success: false, message: msg });
                }

                let onlineResults = null;
                if (onlineInput.provided) {
                    try {
                        const sync = await syncOnlineRuntimesNow(fastify, rootDir);
                        const applied = sync && sync.applied ? sync.applied : null;
                        const resolved = applied && Array.isArray(applied.resolved) ? applied.resolved : [];

                        onlineResults = [];
                        for (const it of resolved) {
                            const url = typeof it.url === 'string' ? it.url : '';
                            const name = typeof it.name === 'string' ? it.name : '';
                            const id = typeof it.id === 'string' ? it.id : '';
                            if (!url) continue;

                            if (!it.ok) {
                                onlineResults.push({
                                    url,
                                    name,
                                    ...(id ? { id } : {}),
                                    status: 'error',
                                    phase: 'download',
                                    message: 'download failed',
                                });
                                continue;
                            }

                            const port =
                                fastify && fastify.onlineRuntimePorts && typeof fastify.onlineRuntimePorts.get === 'function'
                                    ? fastify.onlineRuntimePorts.get(id)
                                    : null;
                            const entryBase = it.destPath ? path.basename(String(it.destPath)) : '';
                            const health = await checkRuntimeHealthy(port, id, entryBase);
                            onlineResults.push({
                                url,
                                name,
                                ...(id ? { id } : {}),
                                status: health.ok ? 'pass' : 'error',
                                ...(health.ok ? {} : { phase: 'runtime', message: 'runtime failed' }),
                                ...(health.runtime ? { runtime: health.runtime } : {}),
                            });
                        }

                        // Persist validation status so UIs keep the last result across refresh.
                        try {
                            const after = readJsonFileSafe(cfgPath) || {};
                            const list = Array.isArray(after.onlineConfigs) ? after.onlineConfigs : [];
                            const byUrl = new Map(
                                (onlineResults || [])
                                    .filter((r) => r && typeof r === 'object' && typeof r.url === 'string' && r.url.trim())
                                    .map((r) => [r.url.trim(), r])
                            );
                            const nextList = list.map((it) => {
                                if (!it || typeof it !== 'object' || Array.isArray(it)) return it;
                                const url = typeof it.url === 'string' ? it.url.trim() : '';
                                if (!url) return it;
                                const r = byUrl.get(url);
                                if (!r) return it;
                                const status = typeof r.status === 'string' && r.status.trim() ? r.status.trim() : 'unchecked';
                                const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim() : '';
                                const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : '';
                                const merged = { ...it, status, checkedAt: Date.now() };
                                if (message) merged.message = message;
                                else {
                                    try {
                                        delete merged.message;
                                    } catch (_) {}
                                }
                                if (id && (!merged.id || String(merged.id).trim() !== id)) merged.id = id;
                                return merged;
                            });
                            writeJsonFileAtomic(cfgPath, { ...after, onlineConfigs: nextList });
                        } catch (_) {}
                    } catch (e) {
                        const msg = e && e.message ? String(e.message) : 'online sync failed';
                        onlineResults = [{ url: '', name: '', status: 'error', message: msg }];
                    }
                }

                const cfgAfter = readJsonFileSafe(cfgPath) || next;
                return reply.send({
                    success: true,
                    settings: readSettingsFromConfig(cfgAfter),
                    onlineConfigs: onlineResults || readOnlineConfigsFromConfig(cfgAfter),
                });
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

                    const type = username && password ? 'account' : cookie ? 'cookie' : '';
                    if (!type) {
                        results.push({ key, ok: true, skipped: true, message: 'empty credential' });
                        continue;
                    }

                    const preferred = panKeyToRuntime.has(key) ? [panKeyToRuntime.get(key)] : [];
                    const candidates = preferred.length
                        ? preferred
                        : ports
                              .map(([rid, p]) => ({ runtimeId: String(rid || '').trim(), port: Number(p || 0) }))
                              .filter((r) => r.runtimeId && Number.isFinite(r.port) && r.port > 0);

                    let lastErr = '';
                    let saved = false;

                    // For builtin baidu/quark/uc: persist to config.json, but still sync to website for db.json.
                    let configOk = true;
                    let configErr = '';
                    if (key === 'baidu' || key === 'quark' || key === 'uc') {
                        try {
                            savePanCredentialToConfig(resolveRuntimeRootDir(), key, { cookie, username, password });
                        } catch (e) {
                            configOk = false;
                            configErr = e && e.message ? String(e.message) : 'config save failed';
                        }
                    }

                    for (const r of candidates) {
                        const endpoint = `http://127.0.0.1:${r.port}/website/${encodeURIComponent(key)}/${type}`;
                        const payload = type === 'account' ? { username, password } : { cookie };
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

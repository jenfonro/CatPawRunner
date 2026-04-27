import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {
    persistOnlineConfigStatePatchesByPath,
    readJsonObjectSafe,
    writeJsonObjectAtomic,
    resolveRuntimeRootDir,
    buildAutoOnlineRuntimeId,
} from '../../util/onlineConfigStore.js';
import {
    broadcastOnlineRuntimeMockConfig,
    broadcastOnlineRuntimeProxyConfig,
    broadcastOnlineRuntimePacketCaptureConfig,
} from '../../util/onlineRuntime.js';
import { runOnlineSyncInBackground } from '../../util/onlineConfigSyncService.js';

const onlineConfigUpdateInFlightIds = new Set();

function save139AuthorizationToConfig(rootDir, authorization) {
    const root = rootDir ? String(rootDir) : '';
    const auth = typeof authorization === 'string' ? authorization.trim() : '';
    if (!root) throw new Error('invalid runtime root');
    if (!auth) throw new Error('missing authorization');

    const cfgPath = path.resolve(root, 'config.json');
    const cfgRoot = readJsonObjectSafe(cfgPath) || {};
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

    writeJsonObjectAtomic(cfgPath, next);
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
    const cfgRoot = readJsonObjectSafe(cfgPath) || {};
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

    writeJsonObjectAtomic(cfgPath, next);
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
    const cfgRoot = readJsonObjectSafe(cfgPath) || {};
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

    writeJsonObjectAtomic(cfgPath, next);
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
    const cfgRoot = readJsonObjectSafe(cfgPath) || {};
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

    writeJsonObjectAtomic(cfgPath, next);
}

function normalizeOnlineConfigsInput(body) {
    const b = body && typeof body === 'object' ? body : {};
    const v = Object.prototype.hasOwnProperty.call(b, 'onlineConfigs') ? b.onlineConfigs : undefined;
    if (v === undefined) return { provided: false, list: [] };
    if (v == null) return { provided: true, list: [] };
    if (!Array.isArray(v)) return { provided: true, list: null };
    return { provided: true, list: v };
}

function normalizeOnlineConfigItem(raw) {
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
                const cfg = readJsonObjectSafe(cfgPath) || {};
                return reply.send({
                    success: true,
                    settings: readSettingsFromConfig(cfg),
                    onlineConfigs: readOnlineConfigsFromConfig(cfg),
                });
            });

            fastify.put('/settings', async function (request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const prev = readJsonObjectSafe(cfgPath) || {};

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
                    const prevById = new Map(
                        prevList
                            .filter((it) => it && typeof it === 'object')
                            .map((it) => [typeof it.id === 'string' ? it.id.trim() : '', it])
                            .filter(([id]) => id)
                    );
                    const prevByUrl = new Map(
                        prevList
                            .filter((it) => it && typeof it === 'object')
                            .map((it) => [typeof it.url === 'string' ? it.url.trim() : '', it])
                            .filter(([u]) => u)
                    );
                    const out = [];
                    const usedIds = new Set();
                    const now = Date.now();
                    const loadingIds = [];
                    for (const raw of onlineInput.list || []) {
                        const norm = normalizeOnlineConfigItem(raw);
                        if (!norm || !norm.url) continue;
                        const incomingId = typeof norm.id === 'string' && norm.id.trim() ? norm.id.trim() : '';
                        const prevByIncomingId = incomingId ? prevById.get(incomingId) : null;
                        const prevByCurrentUrl = prevByUrl.get(norm.url);
                        const prevRef = prevByIncomingId || prevByCurrentUrl || null;
                        const prevId = prevRef && typeof prevRef.id === 'string' && prevRef.id.trim() ? prevRef.id.trim() : '';

                        let idEff = incomingId || prevId || '';
                        if (idEff) {
                            if (usedIds.has(idEff)) idEff = buildAutoOnlineRuntimeId(norm.name || idEff, norm.url, usedIds);
                            else usedIds.add(idEff);
                        } else {
                            idEff = buildAutoOnlineRuntimeId(norm.name, norm.url, usedIds);
                        }

                        const prevByEffId = prevById.get(idEff) || prevByIncomingId || prevByCurrentUrl || null;
                        const prevUrlByEffId =
                            prevByEffId && typeof prevByEffId.url === 'string' ? prevByEffId.url.trim() : '';
                        const needsLoad = !prevByEffId || prevUrlByEffId !== norm.url;
                        if (needsLoad) loadingIds.push(idEff);

                        const prevStatus =
                            prevByEffId && typeof prevByEffId.status === 'string' && prevByEffId.status.trim()
                                ? prevByEffId.status.trim()
                                : 'unchecked';
                        const prevCheckedAt =
                            prevByEffId && Number.isFinite(Number(prevByEffId.checkedAt)) && Number(prevByEffId.checkedAt) > 0
                                ? Math.trunc(Number(prevByEffId.checkedAt))
                                : 0;
                        const prevUpdateAt =
                            prevByEffId && Number.isFinite(Number(prevByEffId.updateAt)) && Number(prevByEffId.updateAt) > 0
                                ? Math.trunc(Number(prevByEffId.updateAt))
                                : 0;
                        const prevUpdateResult =
                            prevByEffId && typeof prevByEffId.updateResult === 'string' ? prevByEffId.updateResult : '';
                        const prevChanged = !!(prevByEffId && prevByEffId.changed);
                        const prevUpdated = !!(prevByEffId && prevByEffId.updated);
                        const prevLocalMd5 =
                            prevByEffId && typeof prevByEffId.localMd5 === 'string' ? prevByEffId.localMd5 : '';
                        const prevRemoteMd5 =
                            prevByEffId && typeof prevByEffId.remoteMd5 === 'string' ? prevByEffId.remoteMd5 : '';
                        const prevMessage = prevByEffId && typeof prevByEffId.message === 'string' ? prevByEffId.message : '';

                        out.push({
                            url: norm.url,
                            name: norm.name || '',
                            id: idEff,
                            status: needsLoad ? 'checking' : prevStatus,
                            checkedAt: needsLoad ? now : prevCheckedAt,
                            updateAt: needsLoad ? 0 : prevUpdateAt,
                            updateResult: needsLoad ? '' : prevUpdateResult,
                            changed: prevChanged,
                            updated: needsLoad ? false : prevUpdated,
                            localMd5: prevLocalMd5,
                            remoteMd5: prevRemoteMd5,
                            message: needsLoad ? '' : prevMessage,
                        });
                    }
                    next.onlineConfigs = out;
                    requestOnlineConfigIds = Array.from(
                        new Set(
                            loadingIds
                                .map((v) => String(v || '').trim())
                                .filter(Boolean)
                        )
                    );
                }

                const claimedOnlineUpdateIds = [];
                if (onlineInput.provided && requestOnlineConfigIds.length) {
                    const conflictIds = requestOnlineConfigIds.filter((id) => onlineConfigUpdateInFlightIds.has(id));
                    if (conflictIds.length) {
                        const cfgNow = readJsonObjectSafe(cfgPath) || prev;
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

                let backgroundScheduled = false;
                try {
                    writeJsonObjectAtomic(cfgPath, next);
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

                    if (onlineInput.provided && requestOnlineConfigIds.length) {
                        backgroundScheduled = true;
                        void runOnlineSyncInBackground({
                            rootDir,
                            portsMap: fastify.onlineRuntimePorts,
                            targetIds: requestOnlineConfigIds,
                            operation: 'loading',
                            onFinishId: (id) => {
                                onlineConfigUpdateInFlightIds.delete(id);
                            },
                        });
                    }

                    const cfgAfter = readJsonObjectSafe(cfgPath) || next;
                    return reply.send({
                        success: true,
                        ...(requestOnlineConfigIds.length ? { pending: true, processingIds: requestOnlineConfigIds } : {}),
                        settings: readSettingsFromConfig(cfgAfter),
                        onlineConfigs: readOnlineConfigsFromConfig(cfgAfter),
                    });
                } catch (e) {
                    const msg = e && e.message ? String(e.message) : 'settings save failed';
                    return reply.code(500).send({ success: false, message: msg });
                } finally {
                    if (!backgroundScheduled) {
                        claimedOnlineUpdateIds.forEach((id) => onlineConfigUpdateInFlightIds.delete(id));
                    }
                }
            });

            // Trigger remote file update check for existing online configs (by id).
            // This API only manages update state:
            // - updateResult: updating -> pass/error
            // - does not overwrite config status, so old status detection remains intact.
            fastify.post('/online-configs/update', async function (request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const cfg = readJsonObjectSafe(cfgPath) || {};
                const onlineConfigs = readOnlineConfigsFromConfig(cfg);
                const allIds = Array.from(
                    new Set(
                        onlineConfigs
                            .map((it) => (it && typeof it.id === 'string' ? it.id.trim() : ''))
                            .filter(Boolean)
                    )
                );
                if (!allIds.length) {
                    return reply.code(400).send({ success: false, message: 'no online config id available' });
                }

                const body = request && request.body && typeof request.body === 'object' ? request.body : {};
                const useAll = !!body.all;
                const requested = [];
                if (!useAll) {
                    if (typeof body.id === 'string' && body.id.trim()) requested.push(body.id.trim());
                    if (typeof body.onlineConfigId === 'string' && body.onlineConfigId.trim()) requested.push(body.onlineConfigId.trim());
                    if (Array.isArray(body.ids)) {
                        body.ids.forEach((v) => {
                            const id = String(v || '').trim();
                            if (id) requested.push(id);
                        });
                    }
                }
                const requestedSet = new Set((useAll || !requested.length ? allIds : requested).map((id) => String(id || '').trim()).filter(Boolean));
                const targetIds = allIds.filter((id) => requestedSet.has(id));
                if (!targetIds.length) {
                    return reply.code(400).send({ success: false, message: 'no matched online config id' });
                }

                const conflictIds = targetIds.filter((id) => onlineConfigUpdateInFlightIds.has(id));
                if (conflictIds.length) {
                    const cfgNow = readJsonObjectSafe(cfgPath) || cfg;
                    return reply.code(202).send({
                        success: true,
                        skipped: true,
                        reason: 'online_update_in_progress',
                        conflictIds,
                        settings: readSettingsFromConfig(cfgNow),
                        onlineConfigs: readOnlineConfigsFromConfig(cfgNow),
                    });
                }

                const claimedIds = [];
                let backgroundScheduled = false;
                try {
                    targetIds.forEach((id) => {
                        onlineConfigUpdateInFlightIds.add(id);
                        claimedIds.push(id);
                    });

                    const now = Date.now();
                    persistOnlineConfigStatePatchesByPath(
                        cfgPath,
                        targetIds.map((id) => ({ id, updateResult: 'updating', updateAt: now }))
                    );

                    backgroundScheduled = true;
                    void runOnlineSyncInBackground({
                        rootDir,
                        portsMap: fastify.onlineRuntimePorts,
                        targetIds,
                        operation: 'updating',
                        onFinishId: (id) => {
                            onlineConfigUpdateInFlightIds.delete(id);
                        },
                    });

                    const cfgAfter = readJsonObjectSafe(cfgPath) || cfg;
                    return reply.send({
                        success: true,
                        pending: true,
                        processingIds: targetIds,
                        settings: readSettingsFromConfig(cfgAfter),
                        onlineConfigs: readOnlineConfigsFromConfig(cfgAfter),
                    });
                } catch (e) {
                    const msg = e && e.message ? String(e.message) : 'online update start failed';
                    return reply.code(500).send({ success: false, message: msg });
                } finally {
                    if (!backgroundScheduled) {
                        claimedIds.forEach((id) => onlineConfigUpdateInFlightIds.delete(id));
                    }
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

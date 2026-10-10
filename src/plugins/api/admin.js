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
    getOnlineRuntimeScriptProtocol,
    getOnlineRuntimeScriptType,
    withOnlineRuntimeOpsLock,
} from '../../util/onlineRuntime.js';
import { restartOnlineConfigNow, runOnlineSyncInBackground } from '../../util/onlineConfigSyncService.js';
import { syncOnlineScriptCredential } from '../../util/onlineScriptAdapters.js';

const onlineConfigUpdateInFlightIds = new Set();
const onlineConfigRestartInFlightIds = new Set();

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

function normalizePanSyncCredential(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const text = (v) => typeof v === 'string' ? v : '';
    return {
        cookie: text(value.cookie),
        username: text(value.username),
        password: text(value.password),
        authorization: text(value.authorization),
        refresh_token: text(value.refresh_token || value.refreshToken),
        device_id: text(value.device_id || value.deviceId),
    };
}

function syncBuiltinPanCredential(rootDir, key, value) {
    let save;
    let present;
    if (key === '139') {
        const authorization = (value.authorization || value.cookie).trim();
        present = !!authorization;
        save = () => save139AuthorizationToConfig(rootDir, authorization);
    } else if (key === 'quark_tv' || key === 'uc_tv') {
        present = !!(value.refresh_token.trim() && value.device_id.trim());
        save = () => key === 'quark_tv' ? saveQuarkTvCredentialToConfig(rootDir, value) : saveUcTvCredentialToConfig(rootDir, value);
    } else if (['baidu', 'quark', 'uc', '189'].includes(key)) {
        present = !!(value.username.trim() && value.password.trim()) || (key !== '189' && !!value.cookie.trim());
        save = () => savePanCredentialToConfig(rootDir, key, value);
    } else {
        return null;
    }
    if (!present) return { ok: true, skipped: true, message: 'empty credential' };
    try {
        save();
        return { ok: true, skipped: false, message: '' };
    } catch (error) {
        return { ok: false, skipped: false, message: error.message || 'config save failed' };
    }
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
                scriptType: getOnlineRuntimeScriptType(id),
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
                // Supported shares are always handled; pan_mock only selects
                // Runner vs MeowFilm as the list/play owner.
                delete next.panBuiltinResolverEnabled;
                delete next.panResolver;
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

            fastify.post('/online-configs/restart', async function (request, reply) {
                const rootDir = resolveRuntimeRootDir();
                const cfgPath = path.resolve(rootDir, 'config.json');
                const cfg = readJsonObjectSafe(cfgPath) || {};
                const id = typeof request.body?.id === 'string' ? request.body.id.trim() : '';
                if (!id) return reply.code(400).send({ success: false, message: 'online config id required' });
                if (!readOnlineConfigsFromConfig(cfg).some((item) => item.id === id)) {
                    return reply.code(404).send({ success: false, message: 'online config not found' });
                }
                if (!fastify.onlineRuntimePorts) {
                    return reply.code(503).send({ success: false, message: 'onlineRuntimePorts not available' });
                }
                const skipped = onlineConfigRestartInFlightIds.has(id);
                if (!skipped) {
                    onlineConfigRestartInFlightIds.add(id);
                    persistOnlineConfigStatePatchesByPath(cfgPath, [{ id, status: 'checking', checkedAt: Date.now(), message: '' }]);
                    void restartOnlineConfigNow({ rootDir, portsMap: fastify.onlineRuntimePorts, id })
                        .catch((error) => fastify.log.error(error))
                        .finally(() => onlineConfigRestartInFlightIds.delete(id));
                }
                const latest = readJsonObjectSafe(cfgPath) || cfg;
                return reply.code(202).send({
                    success: true,
                    pending: true,
                    skipped,
                    processingIds: [id],
                    settings: readSettingsFromConfig(latest),
                    onlineConfigs: readOnlineConfigsFromConfig(latest),
                });
            });

            fastify.get('/full-config', async function (_request, reply) {
                return handleAdminFullConfig(fastify, reply);
            });

            // Builtin credentials stay in our config; script credentials are saved
            // exclusively through each protocol's native management endpoints.
            fastify.post('/pan/sync', async function (request, reply) {
                const result = await withOnlineRuntimeOpsLock(async () => {
                    const body = request.body && typeof request.body === 'object' ? request.body : {};
                    const raw = body.pans || body.settings;
                    const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
                    const keys = Object.keys(store).filter(Boolean);
                    const rootDir = resolveRuntimeRootDir();
                    const ports = fastify.onlineRuntimePorts ? Array.from(fastify.onlineRuntimePorts.entries()) : [];
                    const runtimes = keys.length ? await Promise.all(ports.map(async ([runtimeId, port]) => ({
                        runtimeId, port, protocol: await getOnlineRuntimeScriptProtocol(runtimeId, port),
                    }))) : [];
                    const results = [];
                    let okCount = 0;
                    let failCount = 0;
                    for (const key of keys) {
                        const value = normalizePanSyncCredential(store[key]);
                        const builtin = syncBuiltinPanCredential(rootDir, key, value);
                        const scripts = await Promise.all(runtimes.map(async ({ runtimeId, port, protocol }) => ({
                            runtimeId,
                            scriptType: protocol.type,
                            ...await syncOnlineScriptCredential({ port, protocol, key, value }),
                        })));
                        const failed = builtin?.ok === false || scripts.some((item) => !item.ok);
                        const saved = (builtin?.ok && !builtin.skipped) || scripts.some((item) => item.ok && !item.skipped);
                        const errors = scripts.filter((item) => !item.ok).map((item) => `${item.runtimeId}: ${item.message}`);
                        if (builtin?.ok === false) errors.unshift(builtin.message);
                        if (failed) failCount += 1;
                        else if (saved) okCount += 1;
                        results.push({
                            key, ok: !failed, skipped: !failed && !saved,
                            message: errors.join('; ') || (saved ? '' : '没有可同步的账号或脚本保存接口'),
                            builtin, scripts,
                        });
                    }
                    return { success: true, okCount, failCount, results };
                });
                return reply.send(result);
            });

        },
    },
];

export default apiPlugins;

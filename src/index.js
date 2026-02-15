import fastify from 'fastify';
import router from './router.js';
import {JsonDB, Config} from 'node-json-db';
import axios from 'axios';
import {findAvailablePortInRange} from './util/tool.js';
import {startOnlineRuntime, stopOnlineRuntime, stopAllOnlineRuntimes} from './util/onlineRuntime.js';
import path from 'node:path';
import fs from 'node:fs';
import {applyOnlineConfigs} from './util/onlineConfigStore.js';
import {fileURLToPath} from 'node:url';

let server = null;
let configWatchTimer = null;
let configWatchLastMtime = 0;
let onlineLastEntry = '';
const onlineRuntimePorts = new Map(); // id -> port

let shutdownHooksInstalled = false;
let shutdownInProgress = false;
function installShutdownHooks() {
    if (shutdownHooksInstalled) return;
    shutdownHooksInstalled = true;

    const graceful = async (reason) => {
        if (shutdownInProgress) return;
        shutdownInProgress = true;
        try {
            if (reason) {
                // eslint-disable-next-line no-console
                console.log(`[catpawopen] shutting down (${reason})...`);
            }
        } catch (_) {}
        try {
            await stop();
        } catch (err) {
            try {
                // eslint-disable-next-line no-console
                console.error(err && err.stack ? err.stack : err);
            } catch (_) {}
        } finally {
            try {
                process.exit(0);
            } catch (_) {}
        }
    };

    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'];
    for (const sig of signals) {
        try {
            process.once(sig, () => {
                void graceful(sig);
            });
        } catch (_) {}
    }

    try {
        process.once('uncaughtException', (err) => {
            try {
                // eslint-disable-next-line no-console
                console.error(err && err.stack ? err.stack : err);
            } catch (_) {}
            void graceful('uncaughtException');
        });
    } catch (_) {}

    try {
        process.once('unhandledRejection', (err) => {
            try {
                // eslint-disable-next-line no-console
                console.error(err && err.stack ? err.stack : err);
            } catch (_) {}
            void graceful('unhandledRejection');
        });
    } catch (_) {}

    // Best-effort sync cleanup for hard exits.
    try {
        process.once('exit', () => {
            try {
                stopAllOnlineRuntimes();
            } catch (_) {}
            try {
                if (configWatchTimer) clearInterval(configWatchTimer);
            } catch (_) {}
        });
    } catch (_) {}
}

let cachedCatPawOpenVersion = '';
const DEV_BUILD_STAMP = Date.now();
function resolveCatPawOpenVersion() {
    // In local dev (`npm run dev`), prefer a beta version so API responses don't look like a release build.
    // Keep it stable per process (not per request).
    try {
        const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
        if (!(process && process.pkg) && env !== 'production') {
            return `beta-${DEV_BUILD_STAMP}`;
        }
    } catch (_) {}
    // Prefer build-time injected version (set by the build pipeline).
    // See `esbuild.js` which defines `globalThis.__CATPAWOPEN_BUILD_VERSION__`.
    try {
        const v = globalThis && typeof globalThis.__CATPAWOPEN_BUILD_VERSION__ === 'string' ? globalThis.__CATPAWOPEN_BUILD_VERSION__ : '';
        if (v && String(v).trim()) return String(v).trim();
    } catch (_) {}
    if (cachedCatPawOpenVersion) return cachedCatPawOpenVersion;
    try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const pkgPath = path.resolve(here, '..', 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
        const v = parsed && typeof parsed.version === 'string' ? parsed.version.trim() : '';
        if (v) cachedCatPawOpenVersion = v;
    } catch (_) {}
    return cachedCatPawOpenVersion || '';
}

/**
 * Start the server with the given configuration.
 *
 * Be careful that start will be called multiple times when
 * work with catvodapp. If the server is already running,
 * the stop will be called by engine before start, make sure
 * to return new server every time.
 *
 * @param {Map} config - the config of the server
 * @return {void}
 */
export async function start(config) {
    installShutdownHooks();
    /**
     * @type {import('fastify').FastifyInstance}
     */
    server = fastify({
        serverFactory: catServerFactory,
        forceCloseConnections: true,
        logger: !!(process.env.NODE_ENV !== 'development'),
        maxParamLength: 10240,
    });

	    const applyCors = (request, reply) => {
	        try {
	            const origin = request && request.headers ? request.headers.origin : '';
	            const reqHeaders = request && request.headers ? request.headers : {};
	            const acrh = reqHeaders['access-control-request-headers'] || reqHeaders['Access-Control-Request-Headers'] || '';
	            const acpn =
	                reqHeaders['access-control-request-private-network'] ||
	                reqHeaders['Access-Control-Request-Private-Network'] ||
	                '';
	            if (origin) {
	                reply.header('Access-Control-Allow-Origin', origin);
	                reply.header('Vary', 'Origin');
	            } else {
	                reply.header('Access-Control-Allow-Origin', '*');
	            }
	            reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	            reply.header('Access-Control-Max-Age', '600');
	            reply.header('Access-Control-Allow-Headers', String(acrh || '').trim() || 'content-type,authorization,x-tv-user');
	            // Chrome Private Network Access (public -> localhost) preflight support.
	            if (String(acpn || '').trim().toLowerCase() === 'true') {
	                reply.header('Access-Control-Allow-Private-Network', 'true');
	            }
	        } catch (_) {}
	    };

    server.addHook('onRequest', (request, reply, done) => {
        applyCors(request, reply);
        done();
    });

    // Inject version into JSON responses.
    // - Objects: add `version` field (if not already present)
    // - Arrays: wrap as `{ version, data: [...] }`
    server.addHook('preSerialization', async (_request, _reply, payload) => {
        try {
            const version = resolveCatPawOpenVersion();
            if (!version) return payload;
            if (payload == null) return payload;
            if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) return payload;
            // Do not touch streams (proxy endpoints, file downloads, etc).
            if (payload && typeof payload === 'object' && typeof payload.pipe === 'function') return payload;
            if (typeof payload !== 'object') return payload;
            if (Array.isArray(payload)) return {version, data: payload};
            if (Object.prototype.hasOwnProperty.call(payload, 'version')) return payload;
            return {...payload, version};
        } catch (_) {
            return payload;
        }
    });
    server.options('/*', async (request, reply) => {
        applyCors(request, reply);
        reply.code(204).send();
    });

    // Parse JSON as Buffer so Content-Length is checked in bytes.
    server.addContentTypeParser(
        ['application/json', 'application/*+json'],
        { parseAs: 'buffer' },
        function (_req, body, done) {
            try {
                const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
                done(null, text && text.trim() ? JSON.parse(text) : {});
            } catch (e) {
                done(e);
            }
        }
    );
    server.messageToDart = async (data, inReq) => {
        try {
            if (!data.prefix) {
                data.prefix = inReq ? inReq.server.prefix : '';
            }
            console.log(data);
            const port = catDartServerPort();
            if (port == 0) {
                return null;
            }
            const resp = await axios.post(`http://127.0.0.1:${port}/msg`, data);
            return resp.data;
        } catch (error) {
            return null;
        }
    };
    server.address = function () {
        const result = this.server.address();
        result.url = `http://${result.address}:${result.port}`;
        result.dynamic = 'js2p://_WEB_';
        return result;
    };
    server.addHook('onError', async (_request, _reply, error) => {
        console.error(error);
        if (!error.statusCode) error.statusCode = 500;
        return error;
    });
    server.stop = false;
    server.config = config;
    // Persist db.json in the runtime root:
    // - pkg: next to the executable
    // - dev: NODE_PATH or current working directory
    const runtimeRoot = (() => {
        try {
            if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
                return path.dirname(process.execPath);
            }
        } catch (_) {}
        const p = typeof process.env.NODE_PATH === 'string' && process.env.NODE_PATH.trim() ? process.env.NODE_PATH.trim() : '';
        return p ? path.resolve(p) : process.cwd();
    })();
    server.db = new JsonDB(new Config(path.resolve(runtimeRoot, 'db.json'), true, true, '/', true));
    server.onlineRuntimePorts = onlineRuntimePorts;
    server.register(router);

    const syncAndMaybeRestartOnline = async (reason) => {
        try {
            const res = await applyOnlineConfigs({rootDir: runtimeRoot});
            if (res && res.skipped) {
                // Config does not manage online scripts; keep legacy behavior (run whatever exists in custom_spider/).
                const p = await findAvailablePortInRange(30000, 39999);
                const started = await startOnlineRuntime({id: 'default', port: p});
                if (started && started.port) onlineRuntimePorts.set('default', started.port);
                else onlineRuntimePorts.delete('default');
                onlineLastEntry = started && started.entry ? started.entry : onlineLastEntry;
                return;
            }
            const nextEntry = res && typeof res.entry === 'string' ? res.entry : '';

            // Stop runtime when no configs remain.
            if (!nextEntry) {
                stopAllOnlineRuntimes();
                onlineRuntimePorts.clear();
                onlineLastEntry = '';
                return;
            }

            const desired = Array.isArray(res.resolved) ? res.resolved.filter((r) => r && r.ok && r.id && r.destPath) : [];
            const desiredIds = new Set(desired.map((r) => String(r.id)));

            // Stop removed runtimes.
            for (const [id] of onlineRuntimePorts.entries()) {
                if (!desiredIds.has(id)) {
                    stopOnlineRuntime(id);
                    onlineRuntimePorts.delete(id);
                }
            }

            // Start/restart desired runtimes.
            for (const r of desired) {
                const id = String(r.id);
                const curPort = onlineRuntimePorts.get(id);
                const needPort = !curPort;
                const port = needPort ? await findAvailablePortInRange(30000, 39999) : curPort;
                const shouldRestart = needPort || !!r.downloaded;
                if (shouldRestart) {
                    try {
                        stopOnlineRuntime(id);
                    } catch (_) {}
                    const started = await startOnlineRuntime({id, port, entry: r.destPath});
                    if (started && started.port) onlineRuntimePorts.set(id, started.port);
                    else onlineRuntimePorts.delete(id);
                } else {
                    // Ensure it is running (best-effort).
                    const started = await startOnlineRuntime({id, port, entry: r.destPath});
                    if (started && started.port) onlineRuntimePorts.set(id, started.port);
                    else onlineRuntimePorts.delete(id);
                }
            }

            onlineLastEntry = nextEntry;
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            console.log(`[online] sync failed${reason ? ` (${reason})` : ''}: ${msg}`);
        }
    };

    // Apply once on startup.
    await syncAndMaybeRestartOnline('startup');

    // Watch config.json for onlineConfigs changes (so manual edits or /api/server/settings take effect).
    const cfgPath = path.resolve(runtimeRoot, 'config.json');
    const pollMs = 1500;
    try {
        const st = fs.existsSync(cfgPath) ? fs.statSync(cfgPath) : null;
        configWatchLastMtime = st ? Number(st.mtimeMs || 0) : 0;
    } catch (_) {
        configWatchLastMtime = 0;
    }
    configWatchTimer = setInterval(async () => {
        try {
            if (!fs.existsSync(cfgPath)) return;
            const st = fs.statSync(cfgPath);
            const m = Number(st.mtimeMs || 0);
            if (!m || m === configWatchLastMtime) return;
            configWatchLastMtime = m;
            await syncAndMaybeRestartOnline('config changed');
        } catch (_) {}
    }, pollMs);

    const startPortRaw =
        typeof process.env.DEV_HTTP_PORT === 'string' && process.env.DEV_HTTP_PORT.trim()
            ? process.env.DEV_HTTP_PORT
            : typeof process.env.PORT === 'string'
              ? process.env.PORT
              : '';
    const trimmedPort = String(startPortRaw || '').trim();
    // Important: Number('') === 0, so treat empty env as "not set".
    const parsedPort = trimmedPort ? Math.trunc(Number(trimmedPort)) : 0;
    const startPort = parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 9988;
    // 注意：优先监听 ipv4，避免部分环境下 ipv6-mapped 地址带来的兼容问题。
    // 固定端口：不再自动选择下一个可用端口，避免端口“跳来跳去”导致客户端配置失效。
    await server.listen({port: startPort, host: '0.0.0.0'});
}

/**
 * Stop the server if it exists.
 *
 */
export async function stop() {
    if (server) {
        try {
            await server.close();
        } catch (_) {
            try {
                server.close();
            } catch (_) {}
        }
        server.stop = true;
    }
    try {
        stopAllOnlineRuntimes();
    } catch (_) {}
    try {
        if (configWatchTimer) clearInterval(configWatchTimer);
    } catch (_) {}
    configWatchTimer = null;
    configWatchLastMtime = 0;
    onlineLastEntry = '';
    onlineRuntimePorts.clear();
    server = null;
}

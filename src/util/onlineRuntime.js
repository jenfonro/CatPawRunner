import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { findAvailablePortInRange } from './tool.js';

const children = new Map(); // id -> { child, entry, port }
const starting = new Map(); // id -> Promise<startResult>
let runtimeOpsQueue = Promise.resolve();

function getRootDir() {
    // Prefer the executable directory for pkg builds so `db.json` can sit next to the exe.
    try {
        if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
            return path.dirname(process.execPath);
        }
    } catch (_) {}
    const p = typeof process.env.NODE_PATH === 'string' && process.env.NODE_PATH.trim() ? process.env.NODE_PATH.trim() : '';
    if (p) return path.resolve(p);
    return process.cwd();
}

function findOnlineEntry(onlineDir) {
    try {
        if (!onlineDir || !fs.existsSync(onlineDir)) return '';
        const preferred = path.resolve(onlineDir, '0119.js');
        if (fs.existsSync(preferred)) return preferred;
        const files = fs
            .readdirSync(onlineDir, { withFileTypes: true })
            .filter(
                (d) =>
                    d &&
                    d.isFile() &&
                    typeof d.name === 'string' &&
                    d.name &&
                    !d.name.startsWith('.') &&
                    d.name !== 'node_modules' &&
                    d.name !== '.catpaw_online_runtime_bootstrap.cjs' &&
                    /\.(js|cjs|mjs)$/i.test(d.name)
            )
            .map((d) => path.resolve(onlineDir, d.name))
            .sort((a, b) => a.localeCompare(b, 'en'));
        return files[0] || '';
    } catch (_) {
        return '';
    }
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

const DEFAULT_MOCK_PROVIDERS = ['quark', 'uc', '139', 'baidu', 'tianyi'];
const DEFAULT_PACKET_CAPTURE_BODY_LIMIT = 16 * 1024;
const MAX_PACKET_CAPTURE_BODY_LIMIT = 1024 * 1024;

function isRuntimeDebugEnabled() {
    try {
        return String(process.env.CATPAW_DEBUG || '').trim() === '1';
    } catch (_) {
        return false;
    }
}

function readPanMockConfigFromRuntimeRoot(rootDir) {
    try {
        const cfgPath = path.resolve(rootDir, 'config.json');
        const cfg = readJsonFileSafe(cfgPath);
        const enabled = !!cfg.pan_mock;
        return { enabled, debug: enabled && isRuntimeDebugEnabled(), providers: DEFAULT_MOCK_PROVIDERS };
    } catch (_) {
        return { enabled: false, debug: false, providers: DEFAULT_MOCK_PROVIDERS };
    }
}

function sendMockConfigToChild(childProc, mockCfg) {
    try {
        if (!childProc || typeof childProc.send !== 'function') return;
        if (childProc.killed) return;
        childProc.send({ type: 'mock_config', ...mockCfg });
    } catch (_) {}
}

export function broadcastOnlineRuntimeMockConfig({ rootDir } = {}) {
    try {
        const dir = rootDir ? path.resolve(String(rootDir)) : getRootDir();
        const cfg = readPanMockConfigFromRuntimeRoot(dir);
        for (const { child } of children.values()) {
            sendMockConfigToChild(child, cfg);
        }
    } catch (_) {}
}

function readProxyConfigFromRuntimeRoot(rootDir) {
    try {
        const cfgPath = path.resolve(rootDir, 'config.json');
        const cfg = readJsonFileSafe(cfgPath);
        const proxy = typeof cfg.proxy === 'string' ? cfg.proxy.trim() : '';
        const rawSiteProxy = cfg && cfg.siteProxy && typeof cfg.siteProxy === 'object' && !Array.isArray(cfg.siteProxy) ? cfg.siteProxy : {};
        const siteProxy = {};
        for (const k of Object.keys(rawSiteProxy || {})) {
            try {
                const key = String(k || '').trim();
                const val = rawSiteProxy[k];
                if (!key) continue;
                if (typeof val !== 'string') continue;
                siteProxy[key] = val;
            } catch (_) {}
        }
        return { proxy, siteProxy };
    } catch (_) {
        return { proxy: '', siteProxy: {} };
    }
}

function sendProxyConfigToChild(childProc, proxyCfg) {
    try {
        if (!childProc || typeof childProc.send !== 'function') return;
        if (childProc.killed) return;
        const cfg = proxyCfg && typeof proxyCfg === 'object' ? proxyCfg : {};
        childProc.send({ type: 'proxy_config', proxy: typeof cfg.proxy === 'string' ? cfg.proxy : '', siteProxy: cfg.siteProxy || {} });
    } catch (_) {}
}

export function broadcastOnlineRuntimeProxyConfig({ rootDir } = {}) {
    try {
        const dir = rootDir ? path.resolve(String(rootDir)) : getRootDir();
        const cfg = readProxyConfigFromRuntimeRoot(dir);
        for (const { child } of children.values()) {
            sendProxyConfigToChild(child, cfg);
        }
    } catch (_) {}
}

function normalizePacketCaptureBodyLimit(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PACKET_CAPTURE_BODY_LIMIT;
    const i = Math.trunc(n);
    if (i <= 0) return 0;
    return Math.min(i, MAX_PACKET_CAPTURE_BODY_LIMIT);
}

function readPacketCaptureConfigFromRuntimeRoot(rootDir) {
    try {
        const cfgPath = path.resolve(rootDir, 'config.json');
        const cfg = readJsonFileSafe(cfgPath);
        const enabled = !!(cfg && cfg.packet_capture);
        const bodyLimit = normalizePacketCaptureBodyLimit(
            cfg && Object.prototype.hasOwnProperty.call(cfg, 'packet_capture_body_limit')
                ? cfg.packet_capture_body_limit
                : DEFAULT_PACKET_CAPTURE_BODY_LIMIT
        );
        const dir = typeof (cfg && cfg.packet_capture_dir) === 'string' ? cfg.packet_capture_dir.trim() : '';
        return { enabled, bodyLimit, dir };
    } catch (_) {
        return { enabled: false, bodyLimit: DEFAULT_PACKET_CAPTURE_BODY_LIMIT, dir: '' };
    }
}

function sendPacketCaptureConfigToChild(childProc, captureCfg) {
    try {
        if (!childProc || typeof childProc.send !== 'function') return;
        if (childProc.killed) return;
        const cfg = captureCfg && typeof captureCfg === 'object' ? captureCfg : {};
        childProc.send({
            type: 'packet_capture_config',
            enabled: !!cfg.enabled,
            bodyLimit: normalizePacketCaptureBodyLimit(cfg.bodyLimit),
            dir: typeof cfg.dir === 'string' ? cfg.dir : '',
        });
    } catch (_) {}
}

export function broadcastOnlineRuntimePacketCaptureConfig({ rootDir } = {}) {
    try {
        const dir = rootDir ? path.resolve(String(rootDir)) : getRootDir();
        const cfg = readPacketCaptureConfigFromRuntimeRoot(dir);
        for (const { child } of children.values()) {
            sendPacketCaptureConfigToChild(child, cfg);
        }
    } catch (_) {}
}

export async function startOnlineRuntime({
    id = 'default',
    port,
    logPrefix = '[online]',
    entry: entryOverride = '',
    entryFn = '',
} = {}) {
    const rootDir = getRootDir();
    const onlineDir = path.resolve(rootDir, 'custom_spider');
    const entry =
        entryOverride && typeof entryOverride === 'string' && entryOverride.trim()
            ? path.resolve(entryOverride.trim())
            : findOnlineEntry(onlineDir);
    if (!entry) return { started: false, port: 0, entry: '' };

    // Online runtime port must not default to the main server port (commonly 9988).
    // If caller does not provide a port, auto-pick a free port in the online range.
    const parsedPort = Number.isFinite(Number(port)) ? Math.max(0, Math.trunc(Number(port))) : 0;
    if (!parsedPort) {
        try {
            // eslint-disable-next-line no-console
            console.warn(`${logPrefix} port not provided; auto-picking one`);
        } catch (_) {}
    }
    const p = parsedPort || (await findAvailablePortInRange(30000, 39999));

    const isPkg = (() => {
        try {
            return !!(process && process.pkg);
        } catch (_) {
            return false;
        }
    })();

    const key = typeof id === 'string' && id.trim() ? id.trim() : 'default';

    // Coalesce concurrent start attempts for the same id.
    const inflight = starting.get(key);
    if (inflight) {
        try {
            return await inflight;
        } catch (_) {
            // fallthrough
        }
    }

    const startPromise = (async () => {
    const prev = children.get(key) || null;

    // Avoid duplicate processes across hot restarts.
    if (prev && prev.child && !prev.child.killed && prev.entry === entry && prev.port === p) {
        return { started: true, port: prev.port, entry: prev.entry, reused: true, id: key };
    }

    try {
        if (prev && prev.child && !prev.child.killed) prev.child.kill();
    } catch (_) {}

				const bootstrap = `
					(() => {
					  const __send = (m) => { try { if (typeof process.send === 'function') process.send(m); } catch (_) {} };
					  const __dbg = String(process.env.CATPAW_DEBUG || '').trim() === '1';
					  let __logToFile = null;
					  const __early = [];
					  const __stringify = (v) => {
					    try {
					      if (typeof v === 'string') return v;
					      if (v == null) return '';
					      if (v instanceof Error) return v.stack ? String(v.stack) : String(v.message || v);
					      if (typeof v === 'object') return JSON.stringify(v);
					      return String(v);
					    } catch (_) {
					      try { return String(v); } catch (_) { return ''; }
					    }
						  };
						  const __log = (...args) => {
						    try {
						      if (!__dbg) return;
						      const line = ['[online-child]'].concat(args.map(__stringify)).join(' ');
						      try { console.error(line); } catch (_) {}
						      try {
						        if (__logToFile) __logToFile(line);
						        else if (__early.length < 200) __early.push(line);
						      } catch (_) {}
						    } catch (_) {}
						  };
						  const __stage = (s) => { try { const v = String(s || '').trim(); if (!v) return; __send({ type: 'stage', stage: v, t: Date.now() }); __log('stage', v); } catch (_) {} };
						  try {
						    globalThis.__catpaw_online_send = __send;
						    globalThis.__catpaw_online_log = __log;
						    globalThis.__catpaw_online_stage = __stage;
						  } catch (_) {}

				  try {
				    process.on('uncaughtException', (e) => {
				      try { __log('uncaughtException', e && e.stack ? e.stack : String(e)); } catch (_) {}
				      try { __send({ type: 'fatal', kind: 'uncaughtException', message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' }); } catch (_) {}
				      try { process.exit(1); } catch (_) {}
				    });
				    process.on('unhandledRejection', (e) => {
				      try { __log('unhandledRejection', e && e.stack ? e.stack : String(e)); } catch (_) {}
				      try { __send({ type: 'fatal', kind: 'unhandledRejection', message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' }); } catch (_) {}
				    });
				  } catch (_) {}

				  __stage('boot');
				  // Exit when parent process disappears.
				  // This is important on Windows (and some service managers) where child processes
				  // can outlive the parent if the parent is force-killed.
				  try {
			    if (process.stdin && typeof process.stdin.on === 'function') {
			      process.stdin.resume();
			      const exitIfClosed = () => {
			        try { process.exit(0); } catch (_) {}
			      };
			      process.stdin.once('end', exitIfClosed);
			      process.stdin.once('close', exitIfClosed);
			      process.stdin.once('error', exitIfClosed);
			    }
			  } catch (_) {}

				  const http = require('http');
					  const https = require('https');
					  const fs = require('fs');
					  const path = require('path');
					  const Module = require('module');
				  const nodeCrypto = require('crypto');
				  let CryptoJS = null;
				  try { CryptoJS = require('crypto-js'); } catch (_) { CryptoJS = null; }
				  const vm = require('vm');

				  try {
					    const lp = String(process.env.CATPAW_DEBUG_LOG || '').trim();
				    if (__dbg && lp) {
				      __logToFile = (line) => {
				        try {
				          fs.appendFileSync(lp, String(line || '') + String.fromCharCode(10));
				        } catch (_) {}
				      };
				      try {
				        for (const l of __early.splice(0, __early.length)) __logToFile(l);
				      } catch (_) {}
				      __log('debug log file', lp);
				    }
				  } catch (_) {}

				  try { if (process.env.ONLINE_CWD) process.chdir(process.env.ONLINE_CWD); } catch (_) {}
				  __log('node', process.version, 'cwd', process.cwd());
				  __log('env ports', { DEV_HTTP_PORT: process.env.DEV_HTTP_PORT, PORT: process.env.PORT, HTTP_PORT: process.env.HTTP_PORT });

			  // Some bundled spiders expect CryptoJS-style helpers on crypto (e.g. crypto.MD5),
			  // while others expect Node crypto (e.g. crypto.createHash). Provide a compatible object
			  // for require('crypto') and also ensure globalThis.crypto has MD5/SHA* while preserving WebCrypto methods.
			  try {
		    const webcrypto = (() => {
		      try {
		        const c = globalThis && globalThis.crypto;
		        return c && typeof c === 'object' ? c : null;
		      } catch (_) {
		        return null;
		      }
		    })();

		    const md5Hex = (s) =>
		      nodeCrypto.createHash('md5').update(String(s == null ? '' : s), 'utf8').digest('hex');
		    const sha1Hex = (s) =>
		      nodeCrypto.createHash('sha1').update(String(s == null ? '' : s), 'utf8').digest('hex');
		    const sha256Hex = (s) =>
		      nodeCrypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');

		    const wordArrayFromHex = (hex) => ({
		      __hex: String(hex || ''),
		      toString(enc) {
		        if (enc && typeof enc.stringify === 'function') return enc.stringify(this);
		        return this.__hex;
		      },
		    });

		    const cryptoCompat =
		      CryptoJS && typeof CryptoJS === 'object'
		        ? CryptoJS
		        : {
		            enc: {
		              Hex: {
		                stringify(wa) {
		                  if (wa && typeof wa.__hex === 'string') return wa.__hex;
		                  if (wa && typeof wa.toString === 'function') return wa.toString();
		                  return String(wa == null ? '' : wa);
		                },
		              },
		            },
		            MD5(s) {
		              return wordArrayFromHex(md5Hex(s));
		            },
		            SHA1(s) {
		              return wordArrayFromHex(sha1Hex(s));
		            },
		            SHA256(s) {
		              return wordArrayFromHex(sha256Hex(s));
		            },
		          };

		    if (cryptoCompat && typeof cryptoCompat === 'object') {
		      if (typeof cryptoCompat.md5 !== 'function') cryptoCompat.md5 = cryptoCompat.MD5;
		      if (typeof cryptoCompat.sha1 !== 'function') cryptoCompat.sha1 = cryptoCompat.SHA1;
		      if (typeof cryptoCompat.sha256 !== 'function') cryptoCompat.sha256 = cryptoCompat.SHA256;
		    }

		    const composite = new Proxy(cryptoCompat || {}, {
		      get(target, prop) {
		        if (target && prop in target) return target[prop];
		        if (nodeCrypto && prop in nodeCrypto) return nodeCrypto[prop];
		        return undefined;
		      },
		    });

		    // Expose CryptoJS (or a minimal substitute) for scripts that reference it directly.
		    globalThis.CryptoJS = cryptoCompat;

		    // Preserve WebCrypto methods on the object scripts see as global crypto.
		    try {
		      if (webcrypto && typeof webcrypto === 'object') {
		        if (!composite.subtle && webcrypto.subtle) composite.subtle = webcrypto.subtle;
		        if (typeof composite.getRandomValues !== 'function' && typeof webcrypto.getRandomValues === 'function') {
		          composite.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
		        }
		        if (typeof composite.randomUUID !== 'function' && typeof webcrypto.randomUUID === 'function') {
		          composite.randomUUID = webcrypto.randomUUID.bind(webcrypto);
		        }
		      }
		    } catch (_) {}

		    // Make sure scripts that use the global crypto variable can call crypto.MD5(...).
		    // Some bundles overwrite global crypto; we keep it pinned to the composite but still accept WebCrypto updates.
		    try {
		      Object.defineProperty(globalThis, 'crypto', {
		        configurable: true,
		        enumerable: true,
		        get() {
		          return composite;
		        },
		        set(v) {
		          try {
		            if (v && typeof v === 'object') {
		              if (!composite.subtle && v.subtle) composite.subtle = v.subtle;
		              if (typeof composite.getRandomValues !== 'function' && typeof v.getRandomValues === 'function') {
		                composite.getRandomValues = v.getRandomValues.bind(v);
		              }
		              if (typeof composite.randomUUID !== 'function' && typeof v.randomUUID === 'function') {
		                composite.randomUUID = v.randomUUID.bind(v);
		              }
		            }
		          } catch (_) {}
		        },
		      });
		    } catch (_) {
		      try {
		        globalThis.crypto = composite;
		      } catch (_) {}
		    }

		    // Ensure any require('crypto') within the online script resolves to our composite.
		    const axiosCompat = (() => {
		      const normalizeHeaders = (h) => {
		        const out = {};
		        try {
		          if (!h) return out;
		          if (typeof h.forEach === 'function') {
		            h.forEach((v, k) => {
		              const kk = String(k || '').trim();
		              const vv = String(v == null ? '' : v).trim();
		              if (kk && vv) out[kk] = vv;
		            });
		            return out;
		          }
		          if (typeof h === 'object') {
		            for (const k of Object.keys(h)) {
		              const kk = String(k || '').trim();
		              const vv = String(h[k] == null ? '' : h[k]).trim();
		              if (kk && vv) out[kk] = vv;
		            }
		          }
		        } catch (_) {}
		        return out;
		      };
		      const buildURL = (baseURL, path, params) => {
		        try {
		          const p = String(path == null ? '' : path).trim();
		          const b = String(baseURL == null ? '' : baseURL).trim();
		          const full = b ? new URL(p || '', b).toString() : String(new URL(p).toString());
		          const u = new URL(full);
		          if (params && typeof params === 'object') {
		            const usp = new URLSearchParams(u.search || '');
		            for (const k of Object.keys(params)) {
		              const v = params[k];
		              if (v == null) continue;
		              if (Array.isArray(v)) {
		                for (const it of v) usp.append(String(k), String(it));
		              } else {
		                usp.set(String(k), String(v));
		              }
		            }
		            const s = usp.toString();
		            u.search = s ? '?' + s : '';
		          }
		          return u.toString();
		        } catch (_) {
		          return String(path || '');
		        }
		      };
		      const parseData = (txt, responseType, contentType) => {
		        const rt = String(responseType || '').trim().toLowerCase();
		        if (rt === 'text') return String(txt || '');
		        if (rt === 'json' || (!rt && String(contentType || '').toLowerCase().includes('application/json'))) {
		          try { return txt ? JSON.parse(txt) : null; } catch (_) { return txt; }
		        }
		        if (!rt) {
		          try { return txt ? JSON.parse(txt) : null; } catch (_) { return txt; }
		        }
		        return txt;
		      };
		      const makeErr = (msg, cfg, code, req, resp) => {
		        const e = new Error(String(msg || 'axios error'));
		        e.isAxiosError = true;
		        e.name = 'AxiosError';
		        if (code) e.code = String(code);
		        e.config = cfg || {};
		        if (req) e.request = req;
		        if (resp) e.response = resp;
		        e.toJSON = function () {
		          return {
		            message: this.message,
		            name: this.name,
		            code: this.code || '',
		            status: this.response && this.response.status ? this.response.status : null,
		          };
		        };
		        return e;
		      };
		      const create = (defaults) => {
		        const dft = defaults && typeof defaults === 'object' ? { ...defaults } : {};
		        const reqInts = [];
		        const resInts = [];
		        const runRequest = async (cfgIn) => {
		          let cfg = { ...dft, ...(cfgIn && typeof cfgIn === 'object' ? cfgIn : {}) };
		          if (cfg.baseURL == null && dft.baseURL != null) cfg.baseURL = dft.baseURL;
		          if (cfg.headers == null && dft.headers != null) cfg.headers = dft.headers;
		          for (const fn of reqInts) {
		            try {
		              const n = await fn(cfg);
		              if (n && typeof n === 'object') cfg = n;
		            } catch (_) {}
		          }
		          const method = String((cfg.method || 'get')).toUpperCase();
		          const timeout = Math.max(0, Math.trunc(Number(cfg.timeout || 0)) || 0);
		          const url = buildURL(cfg.baseURL, cfg.url, cfg.params);
		          const headers = normalizeHeaders(cfg.headers);
		          let body = cfg.data;
		          if (body != null && typeof body === 'object' && !(body instanceof Buffer) && !(body instanceof Uint8Array)) {
		            if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
		            try { body = JSON.stringify(body); } catch (_) {}
		          }
		          const reqMeta = { method, url, headers };
		          let resObj = null;
		          try {
		            if (typeof globalThis.fetch !== 'function') throw new Error('fetch unavailable');
		            const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		            const timer = ctrl && timeout > 0 ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeout) : null;
		            try {
		              const res = await globalThis.fetch(url, {
		                method,
		                headers,
		                body: method === 'GET' || method === 'HEAD' ? undefined : body,
		                redirect: 'follow',
		                signal: ctrl ? ctrl.signal : undefined,
		              });
		              const hs = normalizeHeaders(res.headers);
		              const ct = hs['content-type'] || hs['Content-Type'] || '';
		              const rt = String(cfg.responseType || '').trim().toLowerCase();
		              let data;
		              if (rt === 'arraybuffer') {
		                const ab = await res.arrayBuffer();
		                data = Buffer.from(ab);
		              } else {
		                const txt = await res.text();
		                data = parseData(txt, rt, ct);
		              }
		              resObj = {
		                data,
		                status: Number(res.status || 0),
		                statusText: String(res.statusText || ''),
		                headers: hs,
		                config: cfg,
		                request: reqMeta,
		              };
		            } finally {
		              if (timer) clearTimeout(timer);
		            }
		          } catch (err) {
		            const em = err && err.message ? String(err.message) : String(err);
		            const code = String(em || '').toLowerCase().includes('abort') ? 'ECONNABORTED' : 'ERR_NETWORK';
		            throw makeErr(em || 'network error', cfg, code, reqMeta, resObj);
		          }
		          const validateStatus = typeof cfg.validateStatus === 'function' ? cfg.validateStatus : ((s) => s >= 200 && s < 300);
		          if (!validateStatus(resObj.status)) {
		            throw makeErr('Request failed with status code ' + String(resObj.status), cfg, 'ERR_BAD_REQUEST', reqMeta, resObj);
		          }
		          let out = resObj;
		          for (const fn of resInts) {
		            try {
		              const n = await fn(out);
		              if (n !== undefined) out = n;
		            } catch (_) {}
		          }
		          return out;
		        };
		        const ax = function axiosLike(urlOrCfg, maybeCfg) {
		          if (typeof urlOrCfg === 'string') {
		            const cfg = maybeCfg && typeof maybeCfg === 'object' ? { ...maybeCfg } : {};
		            cfg.url = urlOrCfg;
		            return runRequest(cfg);
		          }
		          return runRequest(urlOrCfg && typeof urlOrCfg === 'object' ? urlOrCfg : {});
		        };
		        ax.defaults = dft;
		        ax.interceptors = {
		          request: { use(fn) { if (typeof fn === 'function') reqInts.push(fn); return reqInts.length - 1; } },
		          response: { use(fn) { if (typeof fn === 'function') resInts.push(fn); return resInts.length - 1; } },
		        };
		        ax.request = (cfg) => runRequest(cfg || {});
		        ax.get = (u, cfg) => ax({ ...(cfg || {}), method: 'GET', url: u });
		        ax.delete = (u, cfg) => ax({ ...(cfg || {}), method: 'DELETE', url: u });
		        ax.head = (u, cfg) => ax({ ...(cfg || {}), method: 'HEAD', url: u });
		        ax.options = (u, cfg) => ax({ ...(cfg || {}), method: 'OPTIONS', url: u });
		        ax.post = (u, data, cfg) => ax({ ...(cfg || {}), method: 'POST', url: u, data });
		        ax.put = (u, data, cfg) => ax({ ...(cfg || {}), method: 'PUT', url: u, data });
		        ax.patch = (u, data, cfg) => ax({ ...(cfg || {}), method: 'PATCH', url: u, data });
		        ax.create = (cfg) => create({ ...dft, ...(cfg || {}) });
		        ax.isAxiosError = (e) => !!(e && e.isAxiosError);
		        ax.AxiosError = function AxiosError(message, code, config, request, response) {
		          return makeErr(message, config, code, request, response);
		        };
		        ax.default = ax;
		        return ax;
		      };
		      return create({});
		    })();

		    // Ensure any require('crypto') / require('axios') within the online script resolves to compat modules.
		    try {
		      const origLoad = Module._load;
		      Module._load = function patchedLoad(request, parent, isMain) {
		        try {
		          if (request === 'crypto' || request === 'node:crypto') return composite;
		          if (request === 'crypto-js') return cryptoCompat;
		          if (request === 'axios') return axiosCompat;
		        } catch (_) {}
		        return origLoad.apply(this, arguments);
		      };
		    } catch (_) {}

		    try {
		      const origRequire = require;
		      globalThis.require = function patchedRequire(name) {
		        try {
		          const mod = String(name || '').trim();
		          if (mod === 'crypto' || mod === 'node:crypto') return composite;
		          if (mod === 'crypto-js') return cryptoCompat;
		          if (mod === 'axios') return axiosCompat;
		        } catch (_) {}
		        return origRequire(name);
		      };
		    } catch (_) {}
		  } catch (_) {}
				  globalThis.catServerFactory = (handle) => {
				    const wrapped = (req, res) => {
				      try {
				        const site = __extractSiteFromReqUrl(req && req.url ? req.url : '');
				        if (__siteAls && typeof __siteAls.run === 'function') {
				          return __siteAls.run({ site }, () => handle(req, res));
				        }
				      } catch (_) {}
				      return handle(req, res);
				    };
				    const srv = http.createServer((req, res) => wrapped(req, res));
				    __stage('server_factory');
				    try {
				      srv.on('listening', () => {
				        try {
				          const a = srv.address && typeof srv.address === 'function' ? srv.address() : null;
				          try { globalThis.__catpaw_online_listen_port = a && a.port ? a.port : 0; } catch (_) {}
				          __log('listening', a);
				          __send({ type: 'listening', port: a && a.port ? a.port : 0 });
				        } catch (_) {}
				      });
				    } catch (_) {}
				    try {
				      srv.on('error', (e) => {
				        try {
				          __log('listen_error', e && e.stack ? e.stack : String(e));
				          __send({
				            type: 'listen_error',
				            code: e && e.code ? String(e.code) : '',
				            message: e && e.message ? String(e.message) : '',
				          });
				        } catch (_) {}
				        try { process.exit(1); } catch (_) {}
				      });
				    } catch (_) {}
				    return srv;
				  };
				  globalThis.catDartServerPort = () => 0;

	  const entry = process.env.ONLINE_ENTRY;
	  if (!entry) throw new Error('missing ONLINE_ENTRY');
	  __log('entry', entry);
	  __stage('entry_loaded');

	  globalThis.module = globalThis.module && typeof globalThis.module === 'object' ? globalThis.module : { exports: {} };
	  globalThis.exports = globalThis.module.exports;
	  globalThis.require = typeof globalThis.require === 'function' ? globalThis.require : require;
	  globalThis.__filename = entry;
		  const __onlineCwd = (typeof process.env.ONLINE_CWD === 'string' && process.env.ONLINE_CWD.trim()) ? process.env.ONLINE_CWD.trim() : process.cwd();
		  const __logRoot = (() => {
		    try {
		      const v = String(process.env.CATPAW_LOG_ROOT || '').trim();
		      if (!v) return path.resolve(__onlineCwd);
		      return path.isAbsolute(v) ? v : path.resolve(__onlineCwd, v);
		    } catch (_) {
		      return path.resolve(__onlineCwd);
		    }
		  })();
		  globalThis.__dirname = path.resolve(__onlineCwd);

  try {
    const md5hex = (s) => nodeCrypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex');
    const dbPath = path.resolve(__onlineCwd, 'db.json');
    const readDb = () => {
      try {
        if (!fs.existsSync(dbPath)) return null;
        const raw = fs.readFileSync(dbPath, 'utf8');
        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    };
	    const pickCookie = (provider) => {
	      const db = readDb();
	      if (!db) return '';
	      const bucket = db[provider];
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return '';
      const byKey = (k) => (typeof bucket[k] === 'string' ? String(bucket[k] || '').trim() : '');
      const val = byKey(md5hex('default')) || byKey(md5hex('')) || '';
      if (val) return val;
      const keys = Object.keys(bucket).filter((k) => k !== 'qktime');
      for (const k of keys) {
        const v = byKey(k);
        if (v) return v;
	      }
	      return '';
	    };
			    // Mock interceptors (disabled by default).
			    // Runtime-toggle support: parent process can update this state via IPC (process.send).
			    const __mockState = (() => {
			      const enabled = String(process.env.CATPAW_MOCK || '').trim() === '1';
			      const debug = String(process.env.CATPAW_MOCK_DEBUG || '').trim() === '1';
			      const targets = (() => {
			        try {
			          const raw = String(process.env.CATPAW_MOCK_PROVIDERS || process.env.CATPAW_MOCK_PROVIDER || '').trim();
			          if (!raw) return new Set();
			          const parts = raw.split(',').map((s) => String(s || '').trim()).filter(Boolean);
			          return new Set(parts);
			        } catch (_) {
			          return new Set();
			        }
			      })();
			      return { enabled, debug, targets };
			    })();

			    // Per-site proxy support:
			    // - CATPAW_PROXY: global proxy (applies to all sites by default)
			    // - CATPAW_SITE_PROXY: JSON object mapping { "<site>": "<proxyUrl|''>", "*": "<proxyUrl|''>" }
			    // Runtime-toggle support: parent can update this state via IPC message { type: 'proxy_config', proxy, siteProxy }.
			    const { AsyncLocalStorage } = (() => {
			      try {
			        return require('node:async_hooks');
			      } catch (_) {
			        return {};
			      }
			    })();
			    const __siteAls = (() => {
			      try {
			        return AsyncLocalStorage ? new AsyncLocalStorage() : null;
			      } catch (_) {
			        return null;
			      }
			    })();

			    const __proxyState = (() => {
			      const parseJson = (t) => {
			        try {
			          const s = typeof t === 'string' ? t.trim() : '';
			          if (!s) return null;
			          const obj = JSON.parse(s);
			          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
			        } catch (_) {
			          return null;
			        }
			      };
			      const normalizeProxy = (raw) => {
			        try {
			          let v = String(raw == null ? '' : raw).trim();
			          if (!v) return '';
			          // Allow shorthand "127.0.0.1:7890"
			          const __schemeIdx = v.indexOf('://');
			          const __hasScheme =
			            __schemeIdx > 0 && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(v.slice(0, __schemeIdx));
			          if (!__hasScheme) v = 'http://' + v;
			          return v;
			        } catch (_) {
			          return '';
			        }
			      };
			      const globalProxy = normalizeProxy(process.env.CATPAW_PROXY || '');
			      const bySiteRaw = parseJson(process.env.CATPAW_SITE_PROXY || '') || {};
			      const bySite = {};
			      for (const k of Object.keys(bySiteRaw || {})) {
			        try {
			          const key = String(k || '').trim();
			          if (!key) continue;
			          const val = bySiteRaw[k];
			          if (typeof val !== 'string') continue;
			          bySite[key] = normalizeProxy(val);
			        } catch (_) {}
			      }
			      return { globalProxy, bySite };
			    })();

			    const __applyProxyConfig = (cfg) => {
			      try {
			        if (!cfg || typeof cfg !== 'object') return;
			        const normalizeProxy = (raw) => {
			          try {
			            let v = String(raw == null ? '' : raw).trim();
			            if (!v) return '';
			            const __schemeIdx = v.indexOf('://');
			            const __hasScheme =
			              __schemeIdx > 0 && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(v.slice(0, __schemeIdx));
			            if (!__hasScheme) v = 'http://' + v;
			            return v;
			          } catch (_) {
			            return '';
			          }
			        };
			        if (Object.prototype.hasOwnProperty.call(cfg, 'proxy')) __proxyState.globalProxy = normalizeProxy(cfg.proxy);
			        if (Object.prototype.hasOwnProperty.call(cfg, 'siteProxy')) {
			          const raw = cfg.siteProxy;
			          const next = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
			          const out = {};
			          for (const k of Object.keys(next)) {
			            const key = String(k || '').trim();
			            if (!key) continue;
			            const val = next[k];
			            if (typeof val !== 'string') continue;
			            out[key] = normalizeProxy(val);
			          }
			          __proxyState.bySite = out;
			        }
			      } catch (_) {}
			    };

			    try {
			      process.on('message', (msg) => {
			        try {
			          if (!msg || typeof msg !== 'object') return;
			          if (msg.type !== 'proxy_config') return;
			          __applyProxyConfig(msg);
			        } catch (_) {}
			      });
			    } catch (_) {}

			    const __currentSite = () => {
			      try {
			        const st = __siteAls && typeof __siteAls.getStore === 'function' ? __siteAls.getStore() : null;
			        return st && st.site ? String(st.site || '') : '';
			      } catch (_) {
			        return '';
			      }
			    };

			    const __extractSiteFromReqUrl = (urlLike) => {
			      try {
			        const raw = String(urlLike || '');
			        if (!raw) return '';
			        const u = (() => {
			          try {
			            return new URL(raw, 'http://127.0.0.1');
			          } catch (_) {
			            return null;
			          }
			        })();
			        const p = u ? String(u.pathname || '') : raw;
			        if (!p.startsWith('/spider/')) return '';
			        const parts = p.split('/');
			        if (parts.length < 3) return '';
			        const seg = parts[2] || '';
			        try {
			          return decodeURIComponent(seg);
			        } catch (_) {
			          return String(seg);
			        }
			      } catch (_) {
			        return '';
			      }
			    };

			    const __isLocalHostForProxy = (hostLike) => {
			      try {
			        const h = String(hostLike || '').trim().toLowerCase();
			        return h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === '::1';
			      } catch (_) {
			        return false;
			      }
			    };

			    const __pickProxyForHost = (host) => {
			      try {
			        const h = String(host || '').trim().toLowerCase();
			        if (!h || __isLocalHostForProxy(h)) return '';
			        const site = __currentSite();
			        const map = __proxyState && __proxyState.bySite ? __proxyState.bySite : {};
			        if (site && Object.prototype.hasOwnProperty.call(map, site)) return String(map[site] || '');
			        if (Object.prototype.hasOwnProperty.call(map, '*')) return String(map['*'] || '');
			        return __proxyState && typeof __proxyState.globalProxy === 'string' ? __proxyState.globalProxy : '';
			      } catch (_) {
			        return '';
			      }
			    };

			    const __nodeProxyAgents = new Map();
			    const __getNodeProxyAgent = (proxyUrl) => {
			      try {
			        const p = String(proxyUrl || '').trim();
			        if (!p) return null;
			        const cached = __nodeProxyAgents.get(p);
			        if (cached) return cached;
			        const mod = require('https-proxy-agent');
			        const HttpsProxyAgent = mod && (mod.HttpsProxyAgent || mod);
			        if (typeof HttpsProxyAgent !== 'function') return null;
			        const agent = new HttpsProxyAgent(p);
			        __nodeProxyAgents.set(p, agent);
			        return agent;
			      } catch (_) {
			        return null;
			      }
			    };

			    const __fetchProxyDispatchers = new Map();
			    const __getFetchProxyDispatcher = (proxyUrl) => {
			      try {
			        const p = String(proxyUrl || '').trim();
			        if (!p) return null;
			        const cached = __fetchProxyDispatchers.get(p);
			        if (cached) return cached;
			        const undici = (() => {
			          try {
			            return require('undici');
			          } catch (_) {
			            return null;
			          }
			        })();
			        const ProxyAgent = undici && undici.ProxyAgent ? undici.ProxyAgent : null;
			        if (typeof ProxyAgent !== 'function') return null;
			        const dispatcher = new ProxyAgent(p);
			        __fetchProxyDispatchers.set(p, dispatcher);
			        return dispatcher;
			      } catch (_) {
			        return null;
			      }
			    };
			    const __mockEnabled = () => {
			      try {
			        return !!(__mockState && __mockState.enabled);
			      } catch (_) {
			        return false;
			      }
			    };
			    const __mockDebug = () => {
			      try {
			        return !!(__mockState && __mockState.debug);
			      } catch (_) {
			        return false;
			      }
			    };
			    const __mockHasTarget = (name) => {
			      try {
			        const n = String(name || '').trim();
			        if (!n) return false;
			        return !!(__mockState && __mockState.targets && typeof __mockState.targets.has === 'function' && __mockState.targets.has(n));
			      } catch (_) {
			        return false;
			      }
			    };
			    const __applyMockConfig = (cfg) => {
			      try {
			        if (!cfg || typeof cfg !== 'object') return;
			        if (Object.prototype.hasOwnProperty.call(cfg, 'enabled')) __mockState.enabled = !!cfg.enabled;
			        if (Object.prototype.hasOwnProperty.call(cfg, 'debug')) __mockState.debug = !!cfg.debug;
			        if (Object.prototype.hasOwnProperty.call(cfg, 'providers')) {
			          const raw = cfg.providers;
			          const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
			          const next = new Set(list.map((s) => String(s || '').trim()).filter(Boolean));
			          __mockState.targets = next;
			        }
			      } catch (_) {}
			    };
			    const __mockVersion = 'catpaw-runtime';
			    const __normalizeHost = (raw) => {
			      try {
			        let h = String(raw == null ? '' : raw).trim().toLowerCase();
		        if (!h) return '';
	        // If the caller passed a full URL string, extract hostname.
	        try {
	          const sep = h.indexOf('://');
	          if (sep > 0) {
	            const scheme = h.slice(0, sep);
	            if (/^[a-z0-9.+-]+$/i.test(scheme)) {
	              try { h = String(new URL(h).hostname || '').trim().toLowerCase(); } catch (_) {}
	            }
	          }
	        } catch (_) {}
	        // Handle IPv6 literals like "[::1]:443".
	        if (h.startsWith('[')) {
	          const end = h.indexOf(']');
	          if (end > 0) return h.slice(1, end);
	        }
	        // Strip ":port" from "example.com:443".
	        const lastColon = h.lastIndexOf(':');
	        if (lastColon > -1) {
	          const portPart = h.slice(lastColon + 1);
	          if (/^\d+$/.test(portPart)) h = h.slice(0, lastColon);
	        }
	        return h;
	      } catch (_) {
	        return '';
	      }
	    };
		    const __isQuarkHost = (host) => {
		      const h = __normalizeHost(host);
		      return !!(h && (h === 'quark.cn' || h.endsWith('.quark.cn')));
		    };
			    const __isUcHost = (host) => {
			      const h = __normalizeHost(host);
			      // UC APIs / share pages:
			      // - drive.uc.cn
			      // - pc-api.uc.cn
			      // - open-api-drive.uc.cn
			      return !!(h && (h === 'uc.cn' || h.endsWith('.uc.cn')));
			    };
			    const __is139Host = (host) => {
			      const h = __normalizeHost(host);
			      // 139Yun (移动云盘/和彩云):
			      // - yun.139.com
			      // - share-kd-njs.yun.139.com
			      return !!(h && (h === 'yun.139.com' || h.endsWith('.yun.139.com')));
			    };
				    const __isBaiduPanHost = (host) => {
				      const h = __normalizeHost(host);
				      // Baidu Netdisk share endpoints (script side):
				      // - pan.baidu.com
				      // Some flows may also touch other subdomains, but start with the share domain.
				      return !!(h && (h === 'pan.baidu.com' || h.endsWith('.pan.baidu.com')));
				    };
				    const __isTianyiHost = (host) => {
				      const h = __normalizeHost(host);
				      // Tianyi Cloud (天翼云盘/189):
				      // - cloud.189.cn
				      // - content.21cn.com
				      // Some flows also hit other *.189.cn / *.21cn.com hosts, so match broadly.
				      return !!(
				        h &&
				        (
				          h === 'cloud.189.cn' ||
				          h.endsWith('.cloud.189.cn') ||
				          h === 'content.21cn.com' ||
				          h.endsWith('.content.21cn.com') ||
				          h === '189.cn' ||
				          h.endsWith('.189.cn') ||
				          h === '21cn.com' ||
				          h.endsWith('.21cn.com')
				        )
				      );
				    };
				    const __providerForHost = (host) => {
				      try {
				        const h = __normalizeHost(host);
				        if (!h) return '';
			        if (__isQuarkHost(h)) return 'quark';
			        if (__isUcHost(h) || h.includes('open-api-drive.uc.cn')) return 'uc';
			        if (__is139Host(h)) return '139';
			        if (__isBaiduPanHost(h) || h.endsWith('baidu.com')) return 'baidu';
				        // Tianyi hosts vary; allow broad suffix match.
				        if (__isTianyiHost(h)) return 'tianyi';
				        return '';
				      } catch (_) {
				        return '';
				      }
				    };
				    const __mkInterceptLogPath = (name) => {
				      try {
				        const id = String(process.env.ONLINE_ID || '').trim() || 'online';
				        const n = String(name || '').trim() || 'pan';
				        const file = String(n) + '-intercept.' + String(id) + '.log';
				        const dirRaw = String(process.env.CATPAW_MOCK_DIR || '').trim();
				        const dir = dirRaw
				          ? (path.isAbsolute(dirRaw) ? dirRaw : path.resolve(__logRoot, dirRaw))
				          : path.resolve(__logRoot, 'debug_log');
				        const full = dir ? path.resolve(dir, file) : path.resolve(file);
				        return path.isAbsolute(full) ? full : path.resolve(__logRoot, full);
				      } catch (_) {
				        return '';
				      }
			    };
			    const __appendInterceptLog = (enabled, logPath, obj) => {
			      try {
			        if (!enabled) return;
			        const p = String(logPath || '').trim();
			        if (!p) return;
			        try {
			          const dir = path.dirname(p);
			          if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			        } catch (_) {}
			        const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { value: obj };
			        if (!Object.prototype.hasOwnProperty.call(o, 't')) o.t = Date.now();
			        fs.appendFileSync(p, JSON.stringify(o) + String.fromCharCode(10));
			      } catch (_) {}
			    };
			    const __wantMockStack = false;

			    const __safeSlice = (s, limit) => {
			      try {
			        const t = typeof s === 'string' ? s : s == null ? '' : String(s);
			        const n = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 0;
			        if (n <= 0) return t;
			        return t.length > n ? t.slice(0, n) : t;
			      } catch (_) {
			        return '';
			      }
			    };

			    const __packetCaptureState = (() => {
			      const parseBool = (v) => {
			        try {
			          const s = String(v == null ? '' : v).trim().toLowerCase();
			          return s === '1' || s === 'true' || s === 'yes' || s === 'on';
			        } catch (_) {
			          return false;
			        }
			      };
			      const parseLimit = (v) => {
			        try {
			          const n = Number(v);
			          if (!Number.isFinite(n)) return 16 * 1024;
			          const i = Math.trunc(n);
			          if (i <= 0) return 0;
			          return Math.min(i, 1024 * 1024);
			        } catch (_) {
			          return 16 * 1024;
			        }
			      };
			      return {
			        enabled: parseBool(process.env.CATPAW_PACKET_CAPTURE || ''),
			        bodyLimit: parseLimit(process.env.CATPAW_PACKET_CAPTURE_BODY_LIMIT || ''),
			        dir: String(process.env.CATPAW_PACKET_CAPTURE_DIR || '').trim(),
			        seq: 0,
			      };
			    })();

			    const __packetCaptureEnabled = () => {
			      try {
			        return !!(__packetCaptureState && __packetCaptureState.enabled);
			      } catch (_) {
			        return false;
			      }
			    };

			    const __packetCaptureBodyLimit = () => {
			      try {
			        const n = Number(__packetCaptureState && __packetCaptureState.bodyLimit);
			        if (!Number.isFinite(n)) return 16 * 1024;
			        const i = Math.trunc(n);
			        if (i <= 0) return 0;
			        return Math.min(i, 1024 * 1024);
			      } catch (_) {
			        return 16 * 1024;
			      }
			    };

			    const __applyPacketCaptureConfig = (cfg) => {
			      try {
			        if (!cfg || typeof cfg !== 'object') return;
			        if (Object.prototype.hasOwnProperty.call(cfg, 'enabled')) {
			          __packetCaptureState.enabled = !!cfg.enabled;
			        }
			        if (Object.prototype.hasOwnProperty.call(cfg, 'bodyLimit')) {
			          const n = Number(cfg.bodyLimit);
			          if (Number.isFinite(n)) {
			            const i = Math.trunc(n);
			            __packetCaptureState.bodyLimit = i <= 0 ? 0 : Math.min(i, 1024 * 1024);
			          }
			        }
			        if (Object.prototype.hasOwnProperty.call(cfg, 'dir')) {
			          __packetCaptureState.dir = typeof cfg.dir === 'string' ? cfg.dir.trim() : '';
			        }
			      } catch (_) {}
			    };

			    const __sanitizeFileSeg = (raw) => {
			      try {
			        let s = String(raw == null ? '' : raw).trim().toLowerCase();
			        if (!s) return 'unknown';
			        s = s.replace(/[^a-z0-9._-]+/g, '_');
			        s = s.replace(/^_+|_+$/g, '');
			        return s || 'unknown';
			      } catch (_) {
			        return 'unknown';
			      }
			    };

			    const __mkPacketCaptureLogPath = (hostLike) => {
			      try {
			        const host = __normalizeHost(hostLike) || 'unknown';
			        const file = __sanitizeFileSeg(host) + '.net';
			        const dirRaw =
			          (__packetCaptureState && typeof __packetCaptureState.dir === 'string' && __packetCaptureState.dir.trim())
			            ? __packetCaptureState.dir.trim()
			            : 'net';
			        const dir = path.isAbsolute(dirRaw) ? dirRaw : path.resolve(__logRoot, dirRaw);
			        return path.resolve(dir, file);
			      } catch (_) {
			        return '';
			      }
			    };

			    const __nextPacketCaptureId = () => {
			      try {
			        if (!__packetCaptureState || typeof __packetCaptureState !== 'object') return '';
			        __packetCaptureState.seq = (Number(__packetCaptureState.seq || 0) + 1) % 1000000000;
			        const seq = Math.max(1, Math.trunc(Number(__packetCaptureState.seq || 1)));
			        return String(Date.now()) + '-' + String(seq);
			      } catch (_) {
			        return String(Date.now());
			      }
			    };

			    const __normalizeCaptureHeaders = (headersLike) => {
			      const out = {};
			      try {
			        if (!headersLike) return out;
			        if (typeof headersLike.forEach === 'function') {
			          headersLike.forEach((v, k) => {
			            try {
			              const key = String(k == null ? '' : k).trim().toLowerCase();
			              if (!key) return;
			              if (Array.isArray(v)) out[key] = v.map((it) => String(it == null ? '' : it)).join(', ');
			              else out[key] = String(v == null ? '' : v);
			            } catch (_) {}
			          });
			          return out;
			        }
			        if (Array.isArray(headersLike)) {
			          for (const pair of headersLike) {
			            if (!Array.isArray(pair) || pair.length < 2) continue;
			            const key = String(pair[0] == null ? '' : pair[0]).trim().toLowerCase();
			            if (!key) continue;
			            out[key] = String(pair[1] == null ? '' : pair[1]);
			          }
			          return out;
			        }
			        if (typeof headersLike === 'object') {
			          for (const k of Object.keys(headersLike)) {
			            const key = String(k == null ? '' : k).trim().toLowerCase();
			            if (!key) continue;
			            const v = headersLike[k];
			            if (v == null) continue;
			            if (Array.isArray(v)) out[key] = v.map((it) => String(it == null ? '' : it)).join(', ');
			            else out[key] = String(v);
			          }
			        }
			      } catch (_) {}
			      return out;
			    };

			    const __toCaptureBuffer = (value, encoding) => {
			      try {
			        if (value == null) return Buffer.alloc(0);
			        if (Buffer.isBuffer(value)) return value;
			        if (value instanceof Uint8Array) return Buffer.from(value);
			        if (typeof value === 'string') return Buffer.from(value, typeof encoding === 'string' ? encoding : 'utf8');
			        if (typeof value === 'object') {
			          try {
			            return Buffer.from(JSON.stringify(value), 'utf8');
			          } catch (_) {
			            return Buffer.from(String(value), 'utf8');
			          }
			        }
			        return Buffer.from(String(value), 'utf8');
			      } catch (_) {
			        return Buffer.alloc(0);
			      }
			    };

			    const __parseContentEncodings = (headersLike) => {
			      try {
			        const headers = __normalizeCaptureHeaders(headersLike);
			        const raw = String((headers && headers['content-encoding']) || '').trim().toLowerCase();
			        if (!raw) return [];
			        return raw
			          .split(',')
			          .map((s) => String(s || '').trim().toLowerCase())
			          .filter((s) => s && s !== 'identity');
			      } catch (_) {
			        return [];
			      }
			    };

			    const __decodeBufferByEncodings = (bufLike, encodingsLike) => {
			      const rawBuf = __toCaptureBuffer(bufLike);
			      let out = rawBuf;
			      let used = false;
			      let ok = false;
			      try {
			        const list = Array.isArray(encodingsLike) ? encodingsLike : [];
			        if (!list.length) {
			          return { buffer: rawBuf, used: false, decoded: false };
			        }
			        const zlib = require('node:zlib');
			        for (let i = list.length - 1; i >= 0; i -= 1) {
			          const enc = String(list[i] || '').trim().toLowerCase();
			          if (!enc || enc === 'identity') continue;
			          used = true;
			          if (enc === 'gzip' || enc === 'x-gzip') {
			            out = zlib.gunzipSync(out);
			            ok = true;
			            continue;
			          }
			          if (enc === 'deflate') {
			            try {
			              out = zlib.inflateSync(out);
			            } catch (_) {
			              out = zlib.inflateRawSync(out);
			            }
			            ok = true;
			            continue;
			          }
			          if (enc === 'br') {
			            if (typeof zlib.brotliDecompressSync === 'function') {
			              out = zlib.brotliDecompressSync(out);
			              ok = true;
			              continue;
			            }
			            continue;
			          }
			        }
			      } catch (_) {
			        return { buffer: rawBuf, used, decoded: false };
			      }
			      return { buffer: out, used, decoded: ok };
			    };

			    const __captureBodyPreview = (value, maxBytes, headersLike) => {
			      try {
			        const limitRaw = Number.isFinite(Number(maxBytes)) ? Math.trunc(Number(maxBytes)) : __packetCaptureBodyLimit();
			        const limit = limitRaw <= 0 ? 0 : limitRaw;
			        const buf = __toCaptureBuffer(value);
			        const bytes = buf.length;
			        if (limit <= 0 || !bytes) return { text: '', bytes, truncated: false };
			        const clipped = bytes > limit ? buf.subarray(0, limit) : buf;
			        const encodings = __parseContentEncodings(headersLike);
			        const decoded = __decodeBufferByEncodings(clipped, encodings);
			        const printable = decoded && decoded.buffer ? decoded.buffer : clipped;
			        let text = '';
			        try {
			          text = printable.toString('utf8');
			        } catch (_) {
			          text = '';
			        }
			        return {
			          text: __safeSlice(text, Math.max(0, limit * 2)),
			          bytes,
			          truncated: bytes > limit,
			          encoding: encodings.join(','),
			          decoded: !!(decoded && decoded.decoded),
			        };
			      } catch (_) {
			        return { text: '', bytes: 0, truncated: false };
			      }
			    };

			    const __captureFetchResponseBody = async (responseLike, maxBytes, headersLike) => {
			      try {
			        const limitRaw = Number.isFinite(Number(maxBytes)) ? Math.trunc(Number(maxBytes)) : __packetCaptureBodyLimit();
			        const limit = limitRaw <= 0 ? 0 : limitRaw;
			        if (limit <= 0) return { text: '', bytes: 0, truncated: false };
			        const encodings = __parseContentEncodings(headersLike);
			        const cloned = responseLike && typeof responseLike.clone === 'function' ? responseLike.clone() : null;
			        if (!cloned) return { text: '', bytes: 0, truncated: false };
			        if (cloned.body && typeof cloned.body.getReader === 'function') {
			          const reader = cloned.body.getReader();
			          const chunks = [];
			          let total = 0;
			          let stored = 0;
			          let truncated = false;
			          while (true) {
			            const step = await reader.read();
			            if (!step || step.done) break;
			            const chunk = __toCaptureBuffer(step.value);
			            if (!chunk.length) continue;
			            total += chunk.length;
			            if (stored < limit) {
			              const remain = Math.max(0, limit - stored);
			              const take = Math.min(remain, chunk.length);
			              if (take > 0) {
			                chunks.push(chunk.subarray(0, take));
			                stored += take;
			              }
			            }
			            if (total > limit) {
			              truncated = true;
			              try {
			                await reader.cancel();
			              } catch (_) {}
			              break;
			            }
			          }
			          const previewBuf = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
			          const decoded = __decodeBufferByEncodings(previewBuf, encodings);
			          const printable = decoded && decoded.buffer ? decoded.buffer : previewBuf;
			          let text = '';
			          try {
			            text = printable.toString('utf8');
			          } catch (_) {
			            text = '';
			          }
			          return {
			            text: __safeSlice(text, Math.max(0, limit * 2)),
			            bytes: total,
			            truncated,
			            encoding: encodings.join(','),
			            decoded: !!(decoded && decoded.decoded),
			          };
			        }
			        if (typeof cloned.arrayBuffer === 'function') {
			          const ab = await cloned.arrayBuffer();
			          return __captureBodyPreview(Buffer.from(ab), limit, headersLike);
			        }
			      } catch (_) {}
			      return { text: '', bytes: 0, truncated: false };
			    };

			    const __pathFromUrl = (rawUrl) => {
			      try {
			        const u = new URL(String(rawUrl || ''));
			        return String(u.pathname || '') + String(u.search || '');
			      } catch (_) {
			        return '';
			      }
			    };

			    const __composeUrl = (protocolLike, hostLike, portLike, pathLike) => {
			      try {
			        const protocol = String(protocolLike || '').trim() || 'http:';
			        const host = __normalizeHost(hostLike);
			        if (!host) return '';
			        const p = Number(portLike || 0);
			        const defaultPort =
			          protocol === 'https:' ? 443 : protocol === 'http:' ? 80 : 0;
			        const suffix = p > 0 && p !== defaultPort ? ':' + String(p) : '';
			        const pth = String(pathLike || '').trim() || '/';
			        const normalizedPath = pth.startsWith('/') ? pth : '/' + pth;
			        return protocol + '//' + host + suffix + normalizedPath;
			      } catch (_) {
			        return '';
			      }
			    };

			    const __formatCaptureHeadersText = (headersObj) => {
			      try {
			        const h = headersObj && typeof headersObj === 'object' ? headersObj : {};
			        const keys = Object.keys(h);
			        if (!keys.length) return '(empty)';
			        return keys
			          .sort((a, b) => String(a).localeCompare(String(b), 'en'))
			          .map((k) => String(k) + ': ' + String(h[k] == null ? '' : h[k]))
			          .join(String.fromCharCode(10));
			      } catch (_) {
			        return '(empty)';
			      }
			    };

			    const __fmtCaptureBodyText = (text, bytes, truncated, encoding, decoded) => {
			      try {
			        const s = typeof text === 'string' ? text : text == null ? '' : String(text);
			        const b = Number.isFinite(Number(bytes)) ? Math.max(0, Math.trunc(Number(bytes))) : s.length;
			        const t = !!truncated;
			        const enc = String(encoding || '').trim();
			        const head =
			          '[bytes=' +
			          String(b) +
			          (enc ? ', encoding=' + enc : '') +
			          (enc ? ', decoded=' + String(!!decoded) : '') +
			          (t ? ', truncated=true' : '') +
			          ']';
			        if (!s) return head + String.fromCharCode(10) + '(empty)';
			        return head + String.fromCharCode(10) + s;
			      } catch (_) {
			        return '[bytes=0]' + String.fromCharCode(10) + '(empty)';
			      }
			    };

			    const __toCaptureTextBlock = (record) => {
			      try {
			        const r = record && typeof record === 'object' ? record : {};
			        const req = r.request && typeof r.request === 'object' ? r.request : {};
			        const resp = r.response && typeof r.response === 'object' ? r.response : null;
			        const err = r.error && typeof r.error === 'object' ? r.error : null;
			        const nowIso = (() => {
			          try {
			            return new Date(Number.isFinite(Number(r.at)) ? Number(r.at) : Date.now()).toISOString();
			          } catch (_) {
			            return new Date().toISOString();
			          }
			        })();
			        const id = r.id ? String(r.id) : '';
			        const runtimeId = String(process.env.ONLINE_ID || '').trim() || 'online';
			        const reqMethod = String(req.method || '').trim().toUpperCase() || 'GET';
			        const reqUrl = String(req.url || '').trim();
			        const reqPath = String(req.path || '').trim();
			        const reqHost = __normalizeHost(req.host || reqUrl) || 'unknown';
			        const reqPayload = __fmtCaptureBodyText(
			          req.body,
			          req.body_bytes,
			          req.body_truncated,
			          req.body_encoding,
			          req.body_decoded
			        );
			        const reqHeaders = __formatCaptureHeadersText(req.headers);
			        const lines = [];
			        lines.push('='.repeat(78));
			        lines.push('Time: ' + nowIso + '  ID: ' + id + '  Runtime: ' + runtimeId);
			        lines.push('Type: ' + String(r.type || '') + '  DurationMs: ' + String(Number.isFinite(Number(r.duration_ms)) ? Math.max(0, Math.trunc(Number(r.duration_ms))) : 0));
			        lines.push('PanMockIntercepted: ' + String(!!r.pan_mock_intercepted));
			        lines.push('');
			        lines.push('[Request]');
			        lines.push('Method: ' + reqMethod);
			        lines.push('Host: ' + reqHost);
			        lines.push('Path: ' + reqPath);
			        lines.push('URL: ' + reqUrl);
			        lines.push('Headers:');
			        lines.push(reqHeaders);
			        lines.push('Payload:');
			        lines.push(reqPayload);
			        lines.push('');
			        if (resp) {
			          const respHeaders = __formatCaptureHeadersText(resp.headers);
			          const respBody = __fmtCaptureBodyText(
			            resp.body,
			            resp.body_bytes,
			            resp.body_truncated,
			            resp.body_encoding,
			            resp.body_decoded
			          );
			          lines.push('[Response]');
			          lines.push('Status: ' + String(Number.isFinite(Number(resp.status)) ? Math.max(0, Math.trunc(Number(resp.status))) : 0));
			          lines.push('Headers:');
			          lines.push(respHeaders);
			          lines.push('Content:');
			          lines.push(respBody);
			          lines.push('');
			        }
			        if (err) {
			          lines.push('[Error]');
			          lines.push('Name: ' + String(err.name || ''));
			          lines.push('Code: ' + String(err.code || ''));
			          lines.push('Message: ' + String(err.message || ''));
			          lines.push('');
			        }
			        if (r.aborted) lines.push('[Lifecycle] aborted=true');
			        if (r.closed) lines.push('[Lifecycle] closed=true');
			        lines.push('');
			        return lines.join(String.fromCharCode(10));
			      } catch (_) {
			        return '';
			      }
			    };

			    const __appendPacketCaptureLog = (obj) => {
			      try {
			        if (!__packetCaptureEnabled()) return;
			        const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? { ...obj } : { value: obj };
			        const req = o && o.request && typeof o.request === 'object' ? o.request : {};
			        const host = __normalizeHost(req.host || req.url || '') || 'unknown';
			        const p = __mkPacketCaptureLogPath(host);
			        if (!p) return;
			        try {
			          const dir = path.dirname(p);
			          if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			        } catch (_) {}
			        if (!Object.prototype.hasOwnProperty.call(o, 't')) o.t = Date.now();
			        const block = __toCaptureTextBlock(o);
			        if (!block) return;
			        fs.appendFileSync(p, block, 'utf8');
			      } catch (_) {}
			    };

			    try {
			      process.on('message', (msg) => {
			        try {
			          if (!msg || typeof msg !== 'object') return;
			          if (msg.type !== 'packet_capture_config') return;
			          __applyPacketCaptureConfig(msg);
			        } catch (_) {}
			      });
			    } catch (_) {}

			    const __parseUrlEncoded = (raw) => {
			      try {
			        const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
			        const out = {};
			        for (const part of s.split('&')) {
			          const p = String(part || '').trim();
			          if (!p) continue;
			          const idx = p.indexOf('=');
			          const k = idx >= 0 ? p.slice(0, idx) : p;
			          const v = idx >= 0 ? p.slice(idx + 1) : '';
			          if (!k) continue;
			          const key = decodeURIComponent(k.replace(/\\+/g, '%20'));
			          const val = decodeURIComponent(v.replace(/\\+/g, '%20'));
			          out[key] = val;
			        }
			        return out;
			      } catch (_) {
			        return {};
			      }
			    };

			    const __extractInterceptCreds = (provider, host, pathLike, headersObj, bodyStr) => {
			      try {
			        const prov = String(provider || '').trim();
			        const pth = String(pathLike || '').trim();
			        const hdrs = headersObj && typeof headersObj === 'object' ? headersObj : {};
			        const body = typeof bodyStr === 'string' ? bodyStr : bodyStr == null ? '' : String(bodyStr);
			        const bodyLower = body.toLowerCase();

			        const qs = (() => {
			          try {
			            const u = new URL('https://x.invalid' + pth);
			            const m = {};
			            for (const [k, v] of u.searchParams.entries()) m[k] = v;
			            return m;
			          } catch (_) {
			            return {};
			          }
			        })();

			        const jsonBody = (() => {
			          try {
			            const j = __tryParseJson(body);
			            return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
			          } catch (_) {
			            return null;
			          }
			        })();
			        const formBody = (() => {
			          try {
			            // Only parse as form when it looks like k=v&k2=v2.
			            if (!body || !body.includes('=') || body.trim().startsWith('{') || body.trim().startsWith('[')) return {};
			            return __parseUrlEncoded(body);
			          } catch (_) {
			            return {};
			          }
			        })();

			        if (prov === 'quark' || prov === 'uc') {
			          const pwd_id =
			            String(qs.pwd_id || '').trim() ||
			            String((jsonBody && (jsonBody.pwd_id || jsonBody.share_id || jsonBody.shareId)) || '').trim();
			          const passcode =
			            String(qs.passcode || qs.pwd || '').trim() ||
			            String((jsonBody && (jsonBody.passcode || jsonBody.pwd || jsonBody.password)) || '').trim();
			          const hasPassword = !!passcode || bodyLower.includes('passcode=') || bodyLower.includes('pwd=');
			          return { pwd_id, passcode, hasPassword };
			        }

			        if (prov === 'tianyi') {
			          const shareCode = String(qs.shareCode || qs.sharecode || '').trim();
			          const accessCode =
			            String(qs.accessCode || qs.accesscode || '').trim() ||
			            String((jsonBody && (jsonBody.accessCode || jsonBody.accesscode)) || '').trim() ||
			            String((formBody && (formBody.accessCode || formBody.accesscode || formBody.pwd || formBody.pass)) || '').trim();
			          const hasPassword = !!accessCode || bodyLower.includes('accesscode=') || bodyLower.includes('pwd=');
			          return { shareCode, accessCode, hasPassword };
			        }

			        if (prov === 'baidu') {
			          const shorturl = String(qs.shorturl || '').trim();
			          const pwd =
			            String(qs.pwd || qs.pass || '').trim() ||
			            String((jsonBody && (jsonBody.pwd || jsonBody.pass || jsonBody.password)) || '').trim() ||
			            String((formBody && (formBody.pwd || formBody.pass || formBody.password)) || '').trim();
			          const hasPassword = !!pwd || bodyLower.includes('pwd=');
			          return { shorturl, pwd, hasPassword };
			        }

			        if (prov === '139') {
			          const looksLikeOutlink = pth.includes('/IOutLink/');
			          if (!looksLikeOutlink) return {};
			          const __key = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8');
			          const __b64Normalize = (s) => {
			            try {
			              let t = String(s == null ? '' : s).trim();
			              if (!t) return '';
			              t = t.replace(/\s+/g, '');
			              t = t.replace(/-/g, '+').replace(/_/g, '/');
			              const mod = t.length % 4;
			              if (mod === 2) t += '==';
			              else if (mod === 3) t += '=';
			              return t;
			            } catch (_) {
			              return '';
			            }
			          };
			          const __aesDec = (b64) => {
			            try {
			              const raw = Buffer.from(__b64Normalize(b64), 'base64');
			              if (!raw || raw.length < 17) return '';
			              const iv = raw.subarray(0, 16);
			              const ct = raw.subarray(16);
			              const decipher = nodeCrypto.createDecipheriv('aes-128-cbc', __key, iv);
			              decipher.setAutoPadding(true);
			              const out = Buffer.concat([decipher.update(ct), decipher.final()]);
			              return out.toString('utf8');
			            } catch (_) {
			              return '';
			            }
			          };
			          const encBody = (() => {
			            try {
			              if (jsonBody && typeof jsonBody === 'string') return String(jsonBody);
			              if (typeof body === 'string') {
			                const j = __tryParseJson(body);
			                if (typeof j === 'string') return String(j);
			              }
			            } catch (_) {}
			            return typeof body === 'string' ? body.trim() : '';
			          })();
			          const dec = __aesDec(encBody);
			          const obj = __tryParseJson(dec) || {};
			          const req = obj && typeof obj === 'object' ? (obj.getOutLinkInfoReq || obj.dlFromOutLinkReq || obj.dlFromOutLinkReqV3 || null) : null;
			          const linkID = req && typeof req === 'object' ? String(req.linkID || '').trim() : '';
			          const pCaID = req && typeof req === 'object' ? String(req.pCaID || '').trim() : '';
			          const contentId = req && typeof req === 'object' ? String(req.contentId || '').trim() : '';
			          const passwd =
			            req && typeof req === 'object'
			              ? String(req.passwd || req.passwdStr || req.password || req.pwd || '').trim()
			              : '';
			          const hasPassword = !!passwd;
			          return { linkID, pCaID, contentId, passwd, hasPassword };
			        }

			        void host;
			        void hdrs;
			        return { hasPassword: false };
			      } catch (_) {
			        return { hasPassword: false };
			      }
			    };

			    const __placeholderCache = (() => {
			      try {
			        const existing = globalThis.__catpaw_placeholder_cache;
			        if (existing && typeof existing === 'object') return existing;
			      } catch (_) {}
			      const created = { quark: new Map(), uc: new Map(), baidu: new Map(), tianyi: new Map(), '139': new Map() };
			      try { globalThis.__catpaw_placeholder_cache = created; } catch (_) {}
			      return created;
			    })();

			    const __sanitizeSeg = (raw, maxLen) => {
			      try {
			        let s = String(raw == null ? '' : raw).trim();
			        if (!s) return '';
			        // Keep only safe ASCII for filenames; replace others to underscore.
			        s = s.replace(/[^a-zA-Z0-9]+/g, '_');
			        s = s.replace(/^_+|_+$/g, '');
			        const n = Number.isFinite(Number(maxLen)) ? Math.max(1, Math.trunc(Number(maxLen))) : 64;
			        if (s.length > n) s = s.slice(0, n);
			        return s;
			      } catch (_) {
			        return '';
			      }
			    };

			    const __mkPlaceholderFileName = (provider, shareCode, password) => {
			      const prov = String(provider || '').trim();
			      const pw = __sanitizeSeg(password, 64);
			      if (prov === 'tianyi') {
			        const sc = __sanitizeSeg(shareCode, 80) || 'share';
			        const tail = pw || 'nopass';
			        return sc + '-' + tail + '.MP4';
			      }
			      // Other providers: encode only whether a passcode exists.
			      return (pw || 'nopass') + '.mp4';
			    };

				    /* Tape (record/replay) support removed (keep only CATPAW_MOCK* intercept logging).
				    // - CATPAW_TAPE=record|replay|off
				    // - CATPAW_TAPE_PROVIDER=tianyi|quark|uc|139|baidu (single) or CATPAW_TAPE_PROVIDERS=a,b,c
				    // - CATPAW_TAPE_DIR=/path/to/dir (optional)
				    // - CATPAW_TAPE_PATH=/path/to/file.jsonl (optional, single file for all providers)
				    // - CATPAW_TAPE_<PROVIDER>_PATH=/path/to/file.jsonl (optional, per provider)
				    // - CATPAW_TAPE_STRICT=1 (replay: throw if missing; default passthrough)
				    // - CATPAW_TAPE_REQ_LIMIT_BYTES (default 262144; 0 => unlimited)
				    // - CATPAW_TAPE_RES_LIMIT_BYTES (default 2097152; 0 => unlimited)
			    const __tapeMode = 'off';
			    const __tapeStrict = false;
			    const __tapeReqLimit = 262144;
			    const __tapeResLimit = 2097152;
			    const __tapeTargets = new Set();
			    const __mkTapePath = (provider) => {
			      try {
			        const id = String(process.env.ONLINE_ID || '').trim() || 'online';
			        const up = String(provider || '').trim().toUpperCase();
			        const dirRaw = String(process.env.CATPAW_TAPE_DIR || '').trim();
			        const dir = dirRaw
			          ? (path.isAbsolute(dirRaw) ? dirRaw : path.resolve(__logRoot, dirRaw))
			          : __logRoot;
			        const globalPath = String(process.env.CATPAW_TAPE_PATH || '').trim();
			        const perPath = String(process.env['CATPAW_TAPE_' + up + '_PATH'] || '').trim();
			        const chosen = perPath || globalPath || (dir ? path.resolve(dir, String(provider || 'pan') + '-tape.' + id + '.jsonl') : '');
			        if (!chosen) return '';
			        return path.isAbsolute(chosen) ? chosen : path.resolve(__logRoot, chosen);
			      } catch (_) {
			        return '';
			      }
			    };
			    const __stableQuery = (pathLike) => {
			      try {
			        const u = new URL('https://x.invalid' + String(pathLike || ''));
			        const ignore = new Set(
			          String(process.env.CATPAW_TAPE_IGNORE_QS || 'noCache,_,t,ts,timestamp,rand,random,r,cacheBust')
			            .split(',')
			            .map((s) => String(s || '').trim())
			            .filter(Boolean)
			        );
			        const pairs = [];
			        for (const [k, v] of u.searchParams.entries()) {
			          if (ignore.has(k)) continue;
			          pairs.push([k, v]);
			        }
			        pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
			        const qs = pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
			        return String(u.pathname || '') + (qs ? '?' + qs : '');
			      } catch (_) {
			        return String(pathLike || '');
			      }
			    };
			    const __tapeKey = (provider, method, host, pathLike, bodyStr) => {
			      try {
			        const p = String(provider || '');
			        const m = String(method || 'GET').toUpperCase();
			        const h = __normalizeHost(host);
			        const pth = __stableQuery(pathLike);
			        let bodySig = '';
			        try {
			          const b = typeof bodyStr === 'string' ? bodyStr : '';
			          if (b && b.length <= 8192) bodySig = nodeCrypto.createHash('sha256').update(b, 'utf8').digest('hex');
			        } catch (_) {}
			        return [p, m, h, pth, bodySig].join('|');
			      } catch (_) {
			        return '';
			      }
			    };
			    const __loadTape = (provider) => {
			      const tapePath = __mkTapePath(provider);
			      if (!tapePath) return null;
			      try {
			        if (!fs.existsSync(tapePath)) return { tapePath, map: new Map() };
			        const raw = fs.readFileSync(tapePath, 'utf8');
			        // NOTE: This code is embedded into a generated bootstrap template string.
			        // Avoid backslash escape sequences here; they are easy to break when embedded.
			        const nl = String.fromCharCode(10);
			        const cr = String.fromCharCode(13);
			        const lines = raw
			          .split(nl)
			          .map((line) => (line && line.endsWith(cr) ? line.slice(0, -1) : line))
			          .filter(Boolean);
			        const map = new Map();
			        for (const line of lines) {
			          let obj = null;
			          try { obj = JSON.parse(line); } catch (_) { obj = null; }
			          if (!obj || typeof obj !== 'object') continue;
			          const key = typeof obj.key === 'string' ? obj.key : '';
			          if (!key) continue;
			          const arr = map.get(key) || [];
			          arr.push(obj);
			          map.set(key, arr);
			        }
			        return { tapePath, map };
			      } catch (_) {
			        return { tapePath, map: new Map() };
			      }
			    };
			    const __tapeState = (() => {
			      try {
			        if (__tapeMode !== 'replay') return null;
			        const state = new Map();
			        for (const p of Array.from(__tapeTargets)) state.set(p, __loadTape(p));
			        return state;
			      } catch (_) {
			        return null;
			      }
			    })();
				    const __appendTape = (provider, entry) => {
				      try {
				        const tapePath = __mkTapePath(provider);
				        if (!tapePath) return;
				        const line = JSON.stringify(entry);
				        fs.appendFileSync(tapePath, line + String.fromCharCode(10));
				      } catch (_) {}
				    };
				    */
				    const __tryParseJson = (text) => {
				      try {
				        const t = typeof text === 'string' ? text.trim() : '';
				        if (!t) return null;
		        return JSON.parse(t);
		      } catch (_) {
		        return null;
		      }
		    };
				    const __mkMockStoken = (pwdId) => {
				      try {
				        const raw = String(pwdId || '').trim();
				        // Many bundles treat stoken as a base64-like string; generate one deterministically.
				        const seed = raw ? 'mock_stoken:' + raw : 'mock_stoken:' + String(Date.now());
				        return nodeCrypto.createHash('sha256').update(seed, 'utf8').digest('base64');
			      } catch (_) {
			        return 'bW9ja19zdG9rZW4='; // "mock_stoken"
			      }
			    };
		    const __isQuarkTokenPath = (pathLike) => {
		      try {
		        const p = String(pathLike || '');
		        return p.startsWith('/1/clouddrive/share/sharepage/token');
		      } catch (_) {
		        return false;
		      }
		    };
			    const __isQuarkShareDetailPath = (pathLike) => {
			      try {
			        const p = String(pathLike || '');
			        return p.startsWith('/1/clouddrive/share/sharepage/detail');
			      } catch (_) {
			        return false;
			      }
			    };
				    // Note: mock() returns { kind, payload, statusCode?, headers? }.
				    // - payload must be a string
				    // - headers should be a plain object; prefer 'set-cookie' as an array (axios-friendly)
				    const __quarkMockPayloadFor = (meta) => {
				      try {
				        const pathLike = meta && meta.path ? String(meta.path) : '';
				        const bodyLike = meta && meta.body ? String(meta.body) : '';
				        const nowS = () => Math.floor(Date.now() / 1000);
			        if (__isQuarkTokenPath(pathLike)) {
			          const parsed = __tryParseJson(bodyLike) || {};
			          const pwdId = parsed && typeof parsed === 'object' ? (parsed.pwd_id || parsed.pwdId || '') : '';
			          const passcode = parsed && typeof parsed === 'object' ? (parsed.passcode || parsed.pwd || parsed.password || '') : '';
			          try {
			            const k = String(pwdId || '').trim();
			            if (k) __placeholderCache.quark.set(k, { shareCode: k, password: String(passcode || '').trim() });
			          } catch (_) {}
			          const stoken = __mkMockStoken(pwdId);
			          const root = { status: 200, code: 0, message: 'ok', timestamp: nowS(), data: { stoken } };
			          return { kind: 'token', payload: JSON.stringify(root) };
			        }
			        if (__isQuarkShareDetailPath(pathLike)) {
		          let pwdId = '';
		          let pdirFid = '';
		          let sToken = '';
		          try {
		            const u = new URL('https://drive.quark.cn' + pathLike);
		            pwdId = String(u.searchParams.get('pwd_id') || '').trim();
		            pdirFid = String(u.searchParams.get('pdir_fid') || '').trim() || '0';
		            sToken = String(u.searchParams.get('stoken') || '').trim();
		          } catch (_) {}

			          // Return a "success with placeholder item" that closely resembles real Quark responses,
			          // so scripts can keep the Quark (夸父) line and show an episode, while we avoid real API calls.
			          const md5hex = (s) => {
			            try {
			              return nodeCrypto.createHash('md5').update(String(s == null ? '' : s), 'utf8').digest('hex');
			            } catch (_) {
			              return '0'.repeat(32);
			            }
			          };
			          const fid = md5hex('fid:' + pwdId + ':' + pdirFid);
			          const shareFidToken = md5hex('share_fid_token:' + pwdId + ':' + (sToken || ''));
			          const fidToken = md5hex('fid_token:' + fid + ':' + (sToken || ''));
			          const passcode2 = (() => { try { const hit = __placeholderCache.quark.get(String(pwdId || '').trim()); return hit && hit.password ? String(hit.password) : ''; } catch (_) { return ''; } })();
			          const fileName = __mkPlaceholderFileName('quark', pwdId, passcode2);

			          const listItem = {
			            fid,
				            file_name: fileName,
			            pdir_fid: pdirFid || '0',
			            category: 1,
			            file_type: 1,
			            size: 874 * 1024 * 1024,
			            format_type: 'video/mp4',
			            status: 1,
			            tags: '0',
			            l_created_at: Date.now(),
			            l_updated_at: Date.now(),
			            extra: '{}',
			            source: 'ucpro-pc:saveas',
			            file_source: 'UCPRO-PC:SAVE_SHARE',
			            name_space: 0,
			            l_shot_at: Date.now(),
			            series_id: '',
			            source_display: 'save_share',
			            include_items: 1,
			            series_dir: false,
			            album_dir: false,
			            more_than_one_layer: false,
			            upload_camera_root_dir: false,
			            fps: 0,
			            operated_at: Date.now(),
			            risk_type: 0,
			            tag_list: [],
			            backup_sign: -1,
			            file_name_hl_start: 0,
			            file_name_hl_end: 0,
			            file_struct: {
			              fir_source: 'saveas',
			              sec_source: 'share_save',
			              thi_source: 'share_save',
			              platform_source: 'pc',
			            },
			            share_fid_token: shareFidToken,
			            // Some scripts might look for fid_token variants.
			            fid_token: fidToken,
			            fidToken: fidToken,
			            token: fidToken,
			            cur_version_or_default: 0,
			            raw_name_space: 0,
			            save_as_source: true,
			            backup_source: false,
			            owner_drive_type_or_default: 0,
			            offline_source: false,
			            ensure_valid_save_as_layer: 1,
			            obj_category: 'video',
			            ban: false,
			            dir: false,
			            file: true,
			            created_at: Date.now(),
			            updated_at: Date.now(),
			            _extra: {},
			          };

			          const metaOut = {
			            _size: 200,
			            _page: 1,
			            _count: 1,
			            _total: 1,
			            check_fid_token: 1,
			            _g_group: '',
			            _t_group: '',
			          };

			          const root = {
			            status: 200,
			            code: 0,
			            message: 'ok',
			            timestamp: nowS(),
			            data: {
			              is_owner: 0,
			              list: [listItem],
			              metadata: metaOut,
			            },
			            metadata: metaOut,
			          };
				          return { kind: 'detail_placeholder', payload: JSON.stringify(root) };
				        }
				      } catch (_) {}
				      return {
			        kind: 'blocked',
			        payload: JSON.stringify({
			          status: 200,
			          code: 1,
			          message: 'blocked by CATPAW_MOCK',
			          timestamp: Math.floor(Date.now() / 1000),
			          data: {},
			        }),
				      };
				    };

			    // Interceptors (extensible for other pan providers).
			    const __interceptors = [];
				    const __quarkInterceptor = (() => {
				      const logPath = __mkInterceptLogPath('quark');
				      const log = (obj) =>
				        __appendInterceptLog((__mockDebug() && __mockEnabled() && __mockHasTarget('quark')), logPath, obj);
				      return {
				        name: 'quark',
				        matchHost: (hostLike) => __isQuarkHost(hostLike),
				        log,
				        mock: (meta) => __quarkMockPayloadFor(meta),
				      };
				    })();
				    if (__quarkInterceptor) __interceptors.push(__quarkInterceptor);

				    const __pan139MockPayloadFor = (meta) => {
				      try {
				        const pathLike = meta && meta.path ? String(meta.path) : '';
				        const bodyLike = meta && meta.body ? String(meta.body) : '';
				        const nowS = () => Math.floor(Date.now() / 1000);
				        const __key = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8');
				        const __b64Normalize = (s) => {
				          try {
				            let t = String(s == null ? '' : s).trim();
				            if (!t) return '';
				            t = t.replace(/\s+/g, '');
				            t = t.replace(/-/g, '+').replace(/_/g, '/');
				            const mod = t.length % 4;
				            if (mod === 2) t += '==';
				            else if (mod === 3) t += '=';
				            return t;
				          } catch (_) {
				            return '';
				          }
				        };
				        const __aesDec = (b64) => {
				          const raw = Buffer.from(__b64Normalize(b64), 'base64');
				          if (!raw || raw.length < 17) return '';
				          const iv = raw.subarray(0, 16);
				          const ct = raw.subarray(16);
				          const decipher = nodeCrypto.createDecipheriv('aes-128-cbc', __key, iv);
				          decipher.setAutoPadding(true);
				          const out = Buffer.concat([decipher.update(ct), decipher.final()]);
				          return out.toString('utf8');
				        };
				        const __aesEnc = (plainText) => {
				          const iv = nodeCrypto.randomBytes(16);
				          const cipher = nodeCrypto.createCipheriv('aes-128-cbc', __key, iv);
				          cipher.setAutoPadding(true);
				          const ct = Buffer.concat([cipher.update(Buffer.from(String(plainText || ''), 'utf8')), cipher.final()]);
				          return Buffer.concat([iv, ct]).toString('base64');
				        };

				        const isOutLinkInfo = pathLike.includes('/IOutLink/getOutLinkInfoV6');

				        const parseOutlinkReq = () => {
				          try {
				            const parsedBody = __tryParseJson(bodyLike);
				            const enc = typeof parsedBody === 'string' ? parsedBody : typeof bodyLike === 'string' ? bodyLike.trim() : '';
				            const dec = __aesDec(enc);
				            const obj = __tryParseJson(dec) || {};
				            const req = obj && typeof obj === 'object' ? obj.getOutLinkInfoReq : null;
				            const linkID = req && typeof req === 'object' ? String(req.linkID || '').trim() : '';
				            const pCaID = req && typeof req === 'object' ? String(req.pCaID || '').trim() : '';
				            const passwd =
				              req && typeof req === 'object'
				                ? String(req.passwd || req.passwdStr || req.password || req.pwd || '').trim()
				                : '';
				            return { linkID, pCaID, passwd };
				          } catch (_) {
				            return { linkID: '', pCaID: '', passwd: '' };
				          }
				        };

				        if (isOutLinkInfo) {
				          const { linkID, pCaID, passwd } = parseOutlinkReq();
				          try {
				            const k = String(linkID || '').trim();
				            if (k) __placeholderCache['139'].set(k, { shareCode: k, password: String(passwd || '').trim() });
				          } catch (_) {}
				          const mkId = (salt) => {
				            try {
				              const s = String(salt || '');
				              return nodeCrypto.createHash('md5').update(s, 'utf8').digest('hex');
				            } catch (_) {
				              return '0'.repeat(32);
				            }
				          };

				          const p = String(pCaID || '').trim() || 'root';
				          const coID = mkId('139:co:' + (linkID || '') + ':' + p);
				          const outObj = {
				            code: 0,
				            message: 'ok',
				            data: {
				              caLst: null,
				              coLst: [
				                {
				                  coType: 3,
				                  coName: __mkPlaceholderFileName('139', linkID || 'link', String(passwd || '').trim()),
				                  coID,
				                  coSize: 874 * 1024 * 1024,
				                },
				              ],
				            },
				          };
				          const enc = __aesEnc(JSON.stringify(outObj));
				          return { kind: 'outlink_info', payload: JSON.stringify(enc) };
				        }

				        return {
				          kind: 'blocked',
				          payload: JSON.stringify({
				            status: 200,
				            code: 1,
				            message: 'blocked by CATPAW_MOCK',
				            provider: '139',
				            path: pathLike,
				            timestamp: nowS(),
				            data: {},
				          }),
				        };
				      } catch (_) {}
				      return {
				        kind: 'blocked',
				        payload: JSON.stringify({
			          status: 200,
			          code: 1,
			          message: 'blocked by CATPAW_MOCK',
			          provider: '139',
			          timestamp: Math.floor(Date.now() / 1000),
			          data: {},
			        }),
			      };
			    };
				    const __pan139Interceptor = (() => {
				      const logPath = __mkInterceptLogPath('139');
				      const log = (obj) => __appendInterceptLog((__mockDebug() && __mockEnabled() && __mockHasTarget('139')), logPath, obj);
				      return {
				        name: '139',
				        matchHost: (hostLike) => __is139Host(hostLike),
				        log,
				        mock: (meta) => __pan139MockPayloadFor(meta),
				      };
				    })();
				    if (__pan139Interceptor) __interceptors.push(__pan139Interceptor);

			    const __baiduMockPayloadFor = (meta) => {
			      try {
			        const pathLike = meta && meta.path ? String(meta.path) : '';
			        const bodyLike = meta && meta.body ? String(meta.body) : '';
			        const nowS = () => Math.floor(Date.now() / 1000);

			        const urlObj = (() => {
			          try { return new URL('https://pan.baidu.com' + pathLike); } catch (_) { return null; }
			        })();
			        const qp = (k) => {
			          try { return urlObj ? String(urlObj.searchParams.get(k) || '') : ''; } catch (_) { return ''; }
			        };
			        const surl = qp('surl') || qp('shorturl') || '';
			        const pwdFromBody = (() => {
			          try {
			            const m = String(bodyLike || '').match(/(?:^|&|\\?)pwd=([^&]+)/);
			            if (!m) return '';
			            return decodeURIComponent(String(m[1] || '').replace(/\\+/g, '%20')).trim();
			          } catch (_) {
			            return '';
			          }
			        })();

			        const md5hex = (s) => {
			          try {
			            return nodeCrypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex');
			          } catch (_) {
			            return '0'.repeat(32);
			          }
			        };
			        const shareid = 47340394925;
			        const uk = 1099891027153;
			        const fs_id = 439187793826381;
			        const fileName = 'placeholder.mp4';
			        const filePath = '/placeholder.mp4';
			        const fileItem = {
			          category: 1,
			          extent_int8: 0,
			          fs_id,
			          isdir: 0,
			          local_ctime: nowS(),
			          local_mtime: nowS(),
			          md5: md5hex('baidu:' + (surl || '') + ':' + fileName),
			          path: filePath,
			          server_ctime: nowS(),
			          server_filename: fileName,
			          server_mtime: nowS(),
			          size: 874 * 1024 * 1024,
			          thumbs: {
			            url1: '',
			            url2: '',
			            url3: '',
			            icon: '',
			          },
			        };

				        if (pathLike.startsWith('/share/verify')) {
				          try {
				            const k = String(surl || '').trim();
				            if (k) __placeholderCache.baidu.set(k, { shareCode: k, password: pwdFromBody });
				          } catch (_) {}
				          // Baidu share passcode verify. Set BDCLND to mimic real behavior.
				          const randsk = 'mock_randsk';
				          const payload = JSON.stringify({ errno: 0, err_msg: 'ok', request_id: Date.now(), surl, t: nowS(), randsk });
				          return {
				            kind: 'share_verify',
				            payload,
				            statusCode: 200,
				            headers: {
				              'content-type': 'application/json; charset=utf-8',
				              'set-cookie': ['BDCLND=' + randsk + '; Path=/; Domain=pan.baidu.com'],
				            },
				          };
				        }

				        if (pathLike.startsWith('/share/list')) {
				          const hitPwd = (() => { try { const hit = __placeholderCache.baidu.get(String(surl || '').trim()); return hit && hit.password ? String(hit.password) : ''; } catch (_) { return ''; } })();
				          const fileName2 = __mkPlaceholderFileName('baidu', surl || 'surl', hitPwd);
				          const filePath2 = '/' + fileName2;
				          fileItem.server_filename = fileName2;
				          fileItem.path = filePath2;
				          const payloadObj = {
				            errno: 0,
				            err_msg: 'ok',
				            randsk: 'mock_randsk',
				            uk,
				            shareid,
				            surl: surl || '',
				            list: [fileItem],
				            data: { uk, shareid, list: [fileItem] },
				          };
				          return { kind: 'share_list', payload: JSON.stringify(payloadObj) };
				        }

			        if (pathLike.startsWith('/api/loginStatus')) {
			          const payloadObj = { errno: 0, err_msg: 'ok', bdstoken: 'mock_bdstoken', login_status: 1, uk };
			          return { kind: 'login_status', payload: JSON.stringify(payloadObj) };
			        }

			        // Default: block, but keep path for debugging.
			        return {
			          kind: 'blocked',
			          payload: JSON.stringify({
			            status: 200,
			            code: 1,
			            message: 'blocked by CATPAW_MOCK',
			            provider: 'baidu',
			            path: pathLike,
			            timestamp: nowS(),
			            data: {},
			          }),
			        };
			      } catch (_) {}
			      return {
			        kind: 'blocked',
			        payload: JSON.stringify({
			          status: 200,
			          code: 1,
			          message: 'blocked by CATPAW_MOCK',
			          provider: 'baidu',
			          timestamp: Math.floor(Date.now() / 1000),
			          data: {},
			        }),
			      };
			    };
				    const __baiduInterceptor = (() => {
				      const logPath = __mkInterceptLogPath('baidu');
				      const log = (obj) =>
				        __appendInterceptLog((__mockDebug() && __mockEnabled() && __mockHasTarget('baidu')), logPath, obj);
				      return {
				        name: 'baidu',
				        matchHost: (hostLike) => __isBaiduPanHost(hostLike),
				        log,
				        mock: (meta) => __baiduMockPayloadFor(meta),
				      };
				    })();
				    if (__baiduInterceptor) __interceptors.push(__baiduInterceptor);

				    const __tianyiMockPayloadFor = (meta) => {
				      try {
				        const __tianyiShareCodeCache = (() => {
				          try {
				            const existing = globalThis.__catpaw_tianyi_sharecode_cache;
				            if (existing && typeof existing === 'object') {
				              if (!(existing.byShareId && typeof existing.byShareId.get === 'function')) existing.byShareId = new Map();
				              if (!(existing.byFileId && typeof existing.byFileId.get === 'function')) existing.byFileId = new Map();
				              return existing;
				            }
				          } catch (_) {}
				          const created = { byShareId: new Map(), byFileId: new Map() };
				          try { globalThis.__catpaw_tianyi_sharecode_cache = created; } catch (_) {}
				          return created;
				        })();
				        const pathLike = meta && meta.path ? String(meta.path) : '';
				        const nowMs = () => Date.now();
				        const nowS = () => Math.floor(Date.now() / 1000);
				        const brotliB64 = (obj) => {
				          try {
				            const zlib = require('zlib');
				            const buf = Buffer.from(JSON.stringify(obj), 'utf8');
				            const out = zlib.brotliCompressSync(buf);
				            return out.toString('base64');
				          } catch (_) {
				            return '';
				          }
				        };
				        const md5hex = (s) => {
				          try {
				            return nodeCrypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex');
				          } catch (_) {
				            return '0'.repeat(32);
				          }
				        };
				        const digitsId = (salt, digits) => {
				          try {
				            const h = md5hex(String(salt || ''));
				            const bi = BigInt('0x' + h);
				            const mod = 10n ** BigInt(Math.max(1, Number(digits) || 1));
				            const out = (bi % mod).toString(10);
				            return out.padStart(Math.max(1, Number(digits) || 1), '0');
				          } catch (_) {
				            return String(Date.now());
				          }
				        };
				        const qp = (k) => {
				          try {
				            const u = new URL('https://cloud.189.cn' + pathLike);
				            return String(u.searchParams.get(k) || '');
				          } catch (_) {
				            return '';
				          }
				        };
				        const isShareInfo = pathLike.startsWith('/api/open/share/getShareInfoByCodeV2.action');
				        const isListDir = pathLike.startsWith('/api/open/share/listShareDir.action');

				        const shareCode = qp('shareCode') || '';
				        const accessCodeQ = qp('accessCode') || qp('accesscode') || '';
				        if (shareCode) {
				          try { __placeholderCache.tianyi.set(String(shareCode), { shareCode: String(shareCode), password: String(accessCodeQ || '') }); } catch (_) {}
				        }
				        if (isShareInfo && !shareCode) {
				          return {
				            kind: 'bad_request',
				            payload: JSON.stringify({ res_code: 1, res_message: 'missing shareCode' }),
				            statusCode: 200,
				            headers: { 'content-type': 'application/json;charset=UTF-8' },
				          };
				        }
				        const shareIdQ = qp('shareId') || '';
				        const fileIdQ = qp('fileId') || qp('shareDirFileId') || '';
				        // Real Tianyi uses numeric shareId and fileId; generate stable digits from shareCode.
				        const shareIdFromCode = shareCode ? Number(digitsId('tianyi:share:' + shareCode, 14)) : 0;
				        const fileIdFromCode = shareCode ? digitsId('tianyi:file:' + shareCode, 17) : '';
				        const shareId = isShareInfo ? shareIdFromCode : (shareIdQ ? Number(shareIdQ) : 0);
				        const fileId = isShareInfo ? fileIdFromCode : (fileIdQ || '');
				        // Put shareCode into the filename for easy recovery later.
				        const fileName = shareCode ? __mkPlaceholderFileName('tianyi', shareCode, accessCodeQ) : '';
				        const fileSize = 874 * 1024 * 1024;
				        const brHeaders = {
				          'content-type': 'application/json;charset=UTF-8',
				          // The real Tianyi API responses are brotli-compressed in practice.
				          // 0119.js/its HTTP client expects the runtime to auto-decompress when this header is present.
				          'content-encoding': 'br',
				        };

				        if (isShareInfo) {
				          try {
				            if (shareCode) {
				              try { __tianyiShareCodeCache.byShareId.set(String(shareId), String(shareCode)); } catch (_) {}
				              try { __tianyiShareCodeCache.byFileId.set(String(fileId), String(shareCode)); } catch (_) {}
				            }
				          } catch (_) {}
				          const payloadObj = {
				            res_code: 0,
				            res_message: '成功',
				            accessCode: accessCodeQ || '',
				            creator: { iconURL: '', nickName: 'mock', oper: false, ownerAccount: '', superVip: 0, vip: 0 },
				            expireTime: 0,
				            expireType: 0,
				            fileCreateDate: new Date(nowMs()).toISOString().slice(0, 19).replace('T', ' '),
				            fileId: String(fileId),
				            fileLastOpTime: new Date(nowMs()).toISOString().slice(0, 19).replace('T', ' '),
				            fileName,
				            fileSize,
				            fileType: 'mp4',
				            isFolder: false,
				            mediaType: 3,
				            needAccessCode: 0,
				            reviewStatus: 1,
				            shareDate: nowMs(),
				            shareId,
				            shareMode: 3,
				            shareType: 1,
				          };
				          return {
				            kind: 'share_info',
				            payload: JSON.stringify(payloadObj),
				            payloadB64: brotliB64(payloadObj),
				            statusCode: 200,
				            headers: brHeaders,
				          };
				        }

				        if (isListDir) {
				          if (!shareIdQ && !fileIdQ) {
				            return {
				              kind: 'bad_request',
				              payload: JSON.stringify({ res_code: 1, res_message: 'missing shareId/fileId' }),
				              statusCode: 200,
				              headers: { 'content-type': 'application/json;charset=UTF-8' },
				            };
				          }
				          const shareCode2 = (() => {
				            try {
				              if (shareIdQ) {
				                const v = __tianyiShareCodeCache.byShareId.get(String(shareIdQ));
				                if (v) return String(v);
				              }
				            } catch (_) {}
				            try {
				              if (fileIdQ) {
				                const v = __tianyiShareCodeCache.byFileId.get(String(fileIdQ));
				                if (v) return String(v);
				              }
				            } catch (_) {}
				            return '';
				          })();
				          if (!shareCode2) {
				            return {
				              kind: 'bad_request',
				              payload: JSON.stringify({ res_code: 1, res_message: 'shareCode not cached yet' }),
				              statusCode: 200,
				              headers: { 'content-type': 'application/json;charset=UTF-8' },
				            };
				          }
				          const accessCode2 = (() => { try { const hit = __placeholderCache.tianyi.get(String(shareCode2)); return hit && hit.password ? String(hit.password) : ''; } catch (_) { return ''; } })();
				          const fileName2 = __mkPlaceholderFileName('tianyi', shareCode2, accessCode2);
				          // Tianyi list response items use id/name/size/md5/mediaType (not fileId).
				          const idNum = (() => {
				            try {
				              return (BigInt(fileIdQ || fileId) + 1n).toString(10);
				            } catch (_) {
				              return fileIdQ || fileId;
				            }
				          })();
				          const payloadObj = {
				            res_code: 0,
				            res_message: '成功',
				            expireTime: 0,
				            expireType: 0,
				            lastRev: String(nowS()),
				            fileListAO: {
				              count: 1,
				              fileListSize: 1,
				              fileList: [
				                {
				                  createDate: new Date(nowMs()).toISOString().slice(0, 19).replace('T', ' '),
				                  fileCata: 1,
				                  icon: { largeUrl: '', smallUrl: '' },
				                  id: Number(idNum),
				                  lastOpTime: new Date(nowMs()).toISOString().slice(0, 19).replace('T', ' '),
				                  md5: md5hex('tianyi:md5:' + (shareCode2 || shareCode) + ':' + fileName2),
				                  mediaType: 3,
				                  name: fileName2,
				                  rev: String(nowS()),
				                  size: fileSize,
				                  starLabel: 2,
				                },
				              ],
				              folderList: [],
				            },
				          };
				          return {
				            kind: 'list_dir',
				            payload: JSON.stringify(payloadObj),
				            payloadB64: brotliB64(payloadObj),
				            statusCode: 200,
				            headers: brHeaders,
				          };
				        }

				        return {
				          kind: 'blocked',
				          payload: JSON.stringify({
				            status: 200,
				            code: 1,
				            message: 'blocked by CATPAW_MOCK',
				            provider: 'tianyi',
				            path: pathLike,
				            timestamp: nowS(),
				            data: {},
				          }),
				        };
				      } catch (_) {}
				      return {
				        kind: 'blocked',
				        payload: JSON.stringify({
				          status: 200,
				          code: 1,
				          message: 'blocked by CATPAW_MOCK',
				          provider: 'tianyi',
				          timestamp: Math.floor(Date.now() / 1000),
				          data: {},
				        }),
				      };
				    };
				    const __tianyiInterceptor = (() => {
				      const logPath = __mkInterceptLogPath('tianyi');
				      const log = (obj) =>
				        __appendInterceptLog((__mockDebug() && __mockEnabled() && __mockHasTarget('tianyi')), logPath, obj);
				      return {
				        name: 'tianyi',
				        matchHost: (hostLike) => __isTianyiHost(hostLike),
				        log,
				        mock: (meta) => __tianyiMockPayloadFor(meta),
				      };
				    })();
				    if (__tianyiInterceptor) __interceptors.push(__tianyiInterceptor);

					    const __ucMockPayloadFor = (meta) => {
					      try {
					        const pathLike = meta && meta.path ? String(meta.path) : '';
					        const bodyLike = meta && meta.body ? String(meta.body) : '';
			        const nowS = () => Math.floor(Date.now() / 1000);
			        const isToken = pathLike.startsWith('/1/clouddrive/share/sharepage/token');
			        const isDetail = pathLike.startsWith('/1/clouddrive/share/sharepage/detail');
			        const isSharePage = pathLike.startsWith('/s/');
			        if (isSharePage) {
			          const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>ok</body></html>';
			          return {
			            kind: 'share_page',
			            payload: html,
			            statusCode: 200,
			            headers: {
			              'content-type': 'text/html; charset=utf-8',
			              'set-cookie': [
			                '__pus=mock; Path=/; Domain=.uc.cn',
			                '__puus=mock; Path=/; Domain=.uc.cn',
			                'Video-Auth=mock; Path=/; Domain=.uc.cn',
			              ],
			            },
			          };
			        }
				        if (isToken) {
				          const parsed = __tryParseJson(bodyLike) || {};
				          const pwdId = parsed && typeof parsed === 'object' ? (parsed.pwd_id || parsed.pwdId || '') : '';
				          const passcode = parsed && typeof parsed === 'object' ? (parsed.passcode || parsed.pwd || parsed.password || '') : '';
				          try {
				            const k = String(pwdId || '').trim();
				            if (k) __placeholderCache.uc.set(k, { shareCode: k, password: String(passcode || '').trim() });
				          } catch (_) {}
				          const stoken = __mkMockStoken(pwdId);
				          const root = { status: 200, code: 0, message: 'ok', timestamp: nowS(), data: { stoken } };
				          return { kind: 'token', payload: JSON.stringify(root) };
				        }
			        if (isDetail) {
			          let pwdId = '';
			          let pdirFid = '';
			          let sToken = '';
			          try {
			            const u = new URL('https://pc-api.uc.cn' + pathLike);
			            pwdId = String(u.searchParams.get('pwd_id') || '').trim();
			            pdirFid = String(u.searchParams.get('pdir_fid') || '').trim() || '0';
			            sToken = String(u.searchParams.get('stoken') || '').trim();
			          } catch (_) {}
				          try {
				            if (!pwdId || !sToken || !pdirFid) {
				              const parsed = __tryParseJson(bodyLike) || {};
				              if (!pwdId) pwdId = String(parsed.pwd_id || parsed.pwdId || '').trim();
				              if (!sToken) sToken = String(parsed.stoken || parsed.sToken || parsed.s_token || '').trim();
				              if (!pdirFid) pdirFid = String(parsed.pdir_fid || parsed.pdirFid || '').trim();
				            }
				          } catch (_) {}
				          if (!pdirFid) pdirFid = '0';
				          const md5hex2 = (s) => {
				            try {
				              return nodeCrypto.createHash('md5').update(String(s == null ? '' : s), 'utf8').digest('hex');
				            } catch (_) {
			              return '0'.repeat(32);
			            }
			          };
			          const fid = md5hex2('uc:fid:' + pwdId + ':' + pdirFid);
			          const shareFidToken = md5hex2('uc:share_fid_token:' + pwdId + ':' + (sToken || ''));
			          const fidToken = md5hex2('uc:fid_token:' + fid + ':' + (sToken || ''));
			          const passcode2 = (() => { try { const hit = __placeholderCache.uc.get(String(pwdId || '').trim()); return hit && hit.password ? String(hit.password) : ''; } catch (_) { return ''; } })();
			          const fileName = __mkPlaceholderFileName('uc', pwdId, passcode2);
			          const ts = Date.now();
			          const listItem = {
			            fid,
				            file_name: fileName,
			            pdir_fid: pdirFid || '0',
			            category: 1,
			            file_type: 1,
			            size: 874 * 1024 * 1024,
			            format_type: 'video/mp4',
			            status: 1,
			            tags: '0',
			            l_created_at: ts,
			            l_updated_at: ts,
			            extra: '{}',
			            source: 'ucpro-pc:saveas',
			            file_source: 'UCPRO-PC:SAVE_SHARE',
			            name_space: 0,
			            l_shot_at: ts,
			            series_id: '',
			            thumbnail: 'https://drive.uc.cn/1/clouddrive/file/video/thumbnail?fid=' + fid,
			            big_thumbnail: 'https://drive.uc.cn/1/clouddrive/file/video/quick?fid=' + fid,
			            preview_url: 'https://drive.uc.cn/1/clouddrive/file/video/preview?fid=' + fid,
			            video_max_resolution: '4k',
			            video_width: 3840,
			            video_height: 2160,
			            video_rotate: 0,
			            source_display: 'save_share',
			            include_items: 1,
			            series_dir: false,
			            album_dir: false,
			            more_than_one_layer: false,
			            upload_camera_root_dir: false,
			            fps: 60,
			            like: 0,
			            operated_at: ts,
			            risk_type: 0,
			            tag_list: [],
			            backup_sign: -1,
			            file_name_hl_start: 0,
			            file_name_hl_end: 0,
			            file_struct: {
			              fir_source: 'saveas',
			              sec_source: 'share_save',
			              thi_source: 'share_save',
			              platform_source: 'pc',
			            },
			            duration: 60,
			            share_fid_token: shareFidToken,
			            fid_token: fidToken,
			            fidToken: fidToken,
			            token: fidToken,
			            cur_version_or_default: 0,
			            raw_name_space: 0,
			            save_as_source: true,
			            backup_source: false,
			            owner_drive_type_or_default: 0,
			            offline_source: false,
			            ensure_valid_save_as_layer: 1,
			            obj_category: 'video',
			            ban: false,
			            dir: false,
			            file: true,
			            created_at: ts,
			            updated_at: ts,
			            _extra: {},
			          };
		          const metaOut = {
		            _size: 200,
		            _page: 1,
		            _count: 1,
		            _total: 1,
		            check_fid_token: 1,
		            _g_group: '',
		            _t_group: '',
		          };
		          const root = {
		            status: 200,
		            code: 0,
		            message: 'ok',
		            timestamp: nowS(),
		            data: { is_owner: 1, list: [listItem], metadata: metaOut },
		            metadata: metaOut,
		          };
		          return { kind: 'detail_placeholder', payload: JSON.stringify(root) };
		        }
		      } catch (_) {}
		      return {
		        kind: 'blocked',
		        payload: JSON.stringify({
		          status: 200,
		          code: 1,
		          message: 'blocked by CATPAW_MOCK',
		          timestamp: Math.floor(Date.now() / 1000),
		          data: {},
		        }),
		      };
		    };
			    const __ucInterceptor = (() => {
			      const logPath = __mkInterceptLogPath('uc');
			      const log = (obj) => __appendInterceptLog((__mockDebug() && __mockEnabled() && __mockHasTarget('uc')), logPath, obj);
			      return {
			        name: 'uc',
			        matchHost: (hostLike) => __isUcHost(hostLike),
			        log,
			        mock: (meta) => __ucMockPayloadFor(meta),
			      };
			    })();
			    if (__ucInterceptor) __interceptors.push(__ucInterceptor);
			    const __pickInterceptor = (hostLike) => {
			      try {
			        if (!__mockEnabled()) return null;
			        for (const it of __interceptors) {
			          if (!it || typeof it.matchHost !== 'function') continue;
			          if (!__mockHasTarget(it.name)) continue;
			          if (it.matchHost(hostLike)) return it;
			        }
			      } catch (_) {}
			      return null;
			    };

			    // Runtime-toggle support: update mock state via parent IPC without restarting the child process.
			    try {
			      process.on('message', (msg) => {
			        try {
			          if (!msg || typeof msg !== 'object') return;
			          if (msg.type !== 'mock_config') return;
			          const was = __mockEnabled();
			          __applyMockConfig(msg);
			          const now = __mockEnabled();
			          if (!was && now && __mockDebug()) {
			            for (const it of __interceptors) {
			              try {
			                if (!it || !__mockHasTarget(it.name)) continue;
			                if (typeof it.log === 'function') it.log({ type: 'boot', mode: 'mock', version: __mockVersion, targets: Array.from(__mockState.targets || []) });
			              } catch (_) {}
			            }
			          }
			        } catch (_) {}
			      });
			    } catch (_) {}

						    // Best-effort mock for scripts using fetch (Node 18+ / undici).
						    try {
						      if (__interceptors.length && typeof globalThis.fetch === 'function' && !globalThis.__catpaw_mock_fetch_patched) {
						        globalThis.__catpaw_mock_fetch_patched = true;
				        const __origFetch = globalThis.fetch.bind(globalThis);
				        globalThis.fetch = function patchedFetch(input, init) {
				          try {
				            const method = init && typeof init === 'object' && init.method ? String(init.method).toUpperCase() : 'GET';
		            const url =
		              typeof input === 'string'
	                ? input
	                : input && typeof input === 'object' && typeof input.url === 'string'
	                  ? input.url
	                  : '';
					            const it0 = __pickInterceptor(url);
					            if (it0) {
					              const bodyRaw = init && typeof init === 'object' && init.body != null ? init.body : null;
					              const bodyStr = typeof bodyRaw === 'string' ? bodyRaw : '';
					              const __callStack = (() => {
					                try {
					                  if (!__wantMockStack) return '';
					                  return new Error('catpaw-call-stack').stack || '';
				                } catch (_) {
				                  return '';
				                }
				              })();
					              try {
					                const u2 = (() => { try { return new URL(url); } catch (_) { return null; } })();
					                const pth2 = u2 ? String(u2.pathname || '') + String(u2.search || '') : '';
					                const creds = __extractInterceptCreds(it0 && it0.name ? it0.name : '', __normalizeHost(url), pth2, init && typeof init === 'object' ? (init.headers || {}) : {}, bodyStr);
					                it0.log({ type: 'fetch', provider: it0 && it0.name ? it0.name : '', host: __normalizeHost(url), method, url, body: bodyStr.slice(0, 4096), creds, stack: __callStack });
					              } catch (_) {}
				              try {
					                const u = new URL(url);
					                const meta = { path: String(u.pathname || '') + String(u.search || ''), body: bodyStr };
					                const mocked = it0.mock(meta);
					                try {
					                  it0.log({ type: 'mock', via: 'fetch', kind: mocked.kind, url, stoken: mocked.kind === 'token' ? (__tryParseJson(mocked.payload)?.data?.stoken || '') : '', stack: __callStack });
					                } catch (_) {}
						                const bodyBuf = (() => {
						                  try {
						                    const b64 = mocked && typeof mocked.payloadB64 === 'string' ? mocked.payloadB64 : '';
						                    if (b64) return Buffer.from(b64, 'base64');
						                  } catch (_) {}
						                  try {
						                    return Buffer.from(mocked && mocked.payload != null ? String(mocked.payload) : '', 'utf8');
						                  } catch (_) {
						                    return Buffer.alloc(0);
						                  }
						                })();
						                const body = bodyBuf.toString('utf8');
						                const status = mocked && Number.isFinite(mocked.statusCode) ? mocked.statusCode : 200;
						                const headersIn =
						                  mocked && mocked.headers && typeof mocked.headers === 'object'
						                    ? mocked.headers
						                    : { 'content-type': 'application/json; charset=utf-8' };
					                const headers = (() => {
					                  try {
					                    const out = {};
					                    for (const k of Object.keys(headersIn || {})) {
					                      const v = headersIn[k];
					                      if (v == null) continue;
					                      if (Array.isArray(v)) out[k] = String(v[0] || '');
					                      else out[k] = String(v);
					                    }
					                    return out;
					                  } catch (_) {
					                    return { 'content-type': 'application/json; charset=utf-8' };
					                  }
					                })();
						                if (typeof globalThis.Response === 'function') {
						                  return Promise.resolve(
						                    new globalThis.Response(bodyBuf, {
						                      status,
				                      headers,
				                    })
				                  );
						                }
			              } catch (_) {}
			              return Promise.reject(new Error('blocked by CATPAW_MOCK'));
			            }
			            if (input && typeof input === 'object') {
				              const h = input.hostname || input.host || (input.headers && (input.headers.host || input.headers.Host));
				              const it1 = __pickInterceptor(h);
				              if (it1) {
				                const bodyRaw = init && typeof init === 'object' && init.body != null ? init.body : null;
				                const bodyStr = typeof bodyRaw === 'string' ? bodyRaw : '';
				                try {
				                  it1.log({ type: 'fetch', host: __normalizeHost(h), method, url, body: bodyStr.slice(0, 4096) });
				                } catch (_) {}
			                try {
				                  const url2 = typeof input.url === 'string' ? input.url : '';
				                  const u = url2 ? new URL(url2) : null;
				                  const meta = { path: u ? String(u.pathname || '') + String(u.search || '') : '', body: bodyStr };
				                  const mocked = it1.mock(meta);
				                  try {
				                    it1.log({ type: 'mock', via: 'fetch', kind: mocked.kind, url: url2, stoken: mocked.kind === 'token' ? (__tryParseJson(mocked.payload)?.data?.stoken || '') : '' });
				                  } catch (_) {}
					                  const body = mocked && mocked.payload != null ? String(mocked.payload) : '';
					                  const status = mocked && Number.isFinite(mocked.statusCode) ? mocked.statusCode : 200;
					                  const headersIn =
					                    mocked && mocked.headers && typeof mocked.headers === 'object'
					                      ? mocked.headers
					                      : { 'content-type': 'application/json; charset=utf-8' };
					                  const headers = (() => {
					                    try {
					                      const out = {};
					                      for (const k of Object.keys(headersIn || {})) {
					                        const v = headersIn[k];
					                        if (v == null) continue;
					                        if (Array.isArray(v)) out[k] = String(v[0] || '');
					                        else out[k] = String(v);
					                      }
					                      return out;
					                    } catch (_) {
					                      return { 'content-type': 'application/json; charset=utf-8' };
					                    }
					                  })();
					                  if (typeof globalThis.Response === 'function') {
					                    return Promise.resolve(
					                      new globalThis.Response(body, {
					                        status,
			                        headers,
			                      })
			                    );
			                  }
			                } catch (_) {}
			                return Promise.reject(new Error('blocked by CATPAW_MOCK'));
			              }
			            }
			          } catch (_) {}
				          return __origFetch(input, init);
				        };
			      }
				    } catch (_) {}

						    // Best-effort per-site proxy for scripts using fetch (Node 18+ / undici).
						    // Wrap whatever fetch currently is (may already include CATPAW_MOCK behavior).
						    try {
						      if (typeof globalThis.fetch === 'function' && !globalThis.__catpaw_proxy_fetch_patched) {
						        globalThis.__catpaw_proxy_fetch_patched = true;
						        const __origFetchProxy = globalThis.fetch.bind(globalThis);
						        globalThis.fetch = function proxiedFetch(input, init) {
						          try {
						            const url =
						              typeof input === 'string'
						                ? input
						                : input && typeof input === 'object' && typeof input.url === 'string'
						                  ? input.url
						                  : '';
						            const host = (() => {
						              try {
						                return String(new URL(String(url || '')).hostname || '').toLowerCase();
						              } catch (_) {
						                return '';
						              }
						            })();
						            const proxyUrl = __pickProxyForHost(host);
						            if (proxyUrl) {
						              const dispatcher = __getFetchProxyDispatcher(proxyUrl);
						              if (dispatcher) {
						                const nextInit = init && typeof init === 'object' ? { ...init } : {};
						                if (!nextInit.dispatcher) nextInit.dispatcher = dispatcher;
						                return __origFetchProxy(input, nextInit);
						              }
						            }
						          } catch (_) {}
						          return __origFetchProxy(input, init);
						        };
						      }
						    } catch (_) {}

						    // Packet capture for script outbound fetch traffic.
						    try {
						      if (typeof globalThis.fetch === 'function' && !globalThis.__catpaw_capture_fetch_patched) {
						        globalThis.__catpaw_capture_fetch_patched = true;
						        const __origFetchCapture = globalThis.fetch.bind(globalThis);
						        globalThis.fetch = async function capturedFetch(input, init) {
						          const enabled = __packetCaptureEnabled();
						          const startedAt = Date.now();
						          const requestId = enabled ? __nextPacketCaptureId() : '';
						          let method = 'GET';
						          let url = '';
						          let panMockIntercepted = false;
						          let reqHeaders = {};
						          let reqBody = { text: '', bytes: 0, truncated: false };
						          try {
						            method =
						              init && typeof init === 'object' && init.method
						                ? String(init.method).toUpperCase()
						                : input && typeof input === 'object' && input.method
						                  ? String(input.method).toUpperCase()
						                  : 'GET';
						            url =
						              typeof input === 'string'
						                ? input
						                : input && typeof input === 'object' && typeof input.url === 'string'
						                  ? input.url
						                  : '';
						            const headerSource =
						              init && typeof init === 'object' && Object.prototype.hasOwnProperty.call(init, 'headers')
						                ? init.headers
						                : input && typeof input === 'object' && input.headers
						                  ? input.headers
						                  : null;
						            reqHeaders = __normalizeCaptureHeaders(headerSource);
						            const bodySource =
						              init && typeof init === 'object' && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null;
						            reqBody = __captureBodyPreview(bodySource, __packetCaptureBodyLimit(), reqHeaders);
						            panMockIntercepted = !!__pickInterceptor(url);
						          } catch (_) {}
						          try {
						            const res = await __origFetchCapture(input, init);
						            if (enabled) {
						              let resHeaders = {};
						              let resBody = { text: '', bytes: 0, truncated: false };
						              try {
						                resHeaders = __normalizeCaptureHeaders(res && res.headers ? res.headers : null);
						              } catch (_) {}
						              try {
						                resBody = await __captureFetchResponseBody(res, __packetCaptureBodyLimit(), resHeaders);
						              } catch (_) {}
						              __appendPacketCaptureLog({
						                type: 'fetch',
						                id: requestId,
						                at: startedAt,
						                duration_ms: Date.now() - startedAt,
						                pan_mock_intercepted: panMockIntercepted,
						                request: {
						                  method,
						                  url,
						                  host: __normalizeHost(url),
						                  path: __pathFromUrl(url),
						                  headers: reqHeaders,
						                  body: reqBody.text,
						                  body_bytes: reqBody.bytes,
						                  body_truncated: reqBody.truncated,
						                  body_encoding: reqBody.encoding || '',
						                  body_decoded: !!reqBody.decoded,
						                },
						                response: {
						                  status: res && Number.isFinite(Number(res.status)) ? Math.max(0, Math.trunc(Number(res.status))) : 0,
						                  headers: resHeaders,
						                  body: resBody.text,
						                  body_bytes: resBody.bytes,
						                  body_truncated: resBody.truncated,
						                  body_encoding: resBody.encoding || '',
						                  body_decoded: !!resBody.decoded,
						                },
						              });
						            }
						            return res;
						          } catch (e) {
						            if (enabled) {
						              __appendPacketCaptureLog({
						                type: 'fetch',
						                id: requestId,
						                at: startedAt,
						                duration_ms: Date.now() - startedAt,
						                pan_mock_intercepted: panMockIntercepted,
						                request: {
						                  method,
						                  url,
						                  host: __normalizeHost(url),
						                  path: __pathFromUrl(url),
						                  headers: reqHeaders,
						                  body: reqBody.text,
						                  body_bytes: reqBody.bytes,
						                  body_truncated: reqBody.truncated,
						                  body_encoding: reqBody.encoding || '',
						                  body_decoded: !!reqBody.decoded,
						                },
						                error: {
						                  message: e && e.message ? String(e.message) : String(e),
						                  code: e && e.code ? String(e.code) : '',
						                  name: e && e.name ? String(e.name) : '',
						                },
						              });
						            }
						            throw e;
						          }
						        };
						      }
						    } catch (_) {}

						    /* Tape (record/replay) for scripts using fetch (undici).
						    try {
						      if (__tapeMode !== 'off' && __tapeTargets && __tapeTargets.size && typeof globalThis.fetch === 'function' && !globalThis.__catpaw_tape_fetch_patched) {
						        globalThis.__catpaw_tape_fetch_patched = true;
						        const __origFetchTape = globalThis.fetch.bind(globalThis);
						        globalThis.fetch = async function tapedFetch(input, init) {
					          const method = init && typeof init === 'object' && init.method ? String(init.method).toUpperCase() : 'GET';
					          const url =
					            typeof input === 'string'
					              ? input
					              : input && typeof input === 'object' && typeof input.url === 'string'
					                ? input.url
					                : '';
					          const host = __normalizeHost(url);
					          const provider = __providerForHost(host);
					          if (!provider || !__tapeTargets.has(provider)) return __origFetchTape(input, init);
					          const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
					          const pathLike = u ? String(u.pathname || '') + String(u.search || '') : '';
					          const hdrs = init && typeof init === 'object' && init.headers && typeof init.headers === 'object' ? init.headers : {};
					          const bodyRaw = init && typeof init === 'object' && init.body != null ? init.body : null;
					          const bodyStr = typeof bodyRaw === 'string' ? bodyRaw : '';

					          if (__tapeMode === 'replay') {
					            const key1 = __tapeKey(provider, method, host, pathLike, bodyStr);
					            const key2 = __tapeKey(provider, method, host, pathLike, '');
					            const state = __tapeState && __tapeState.get(provider) ? __tapeState.get(provider) : null;
					            const take = (k) => {
					              try {
					                if (!state || !state.map) return null;
					                const arr = state.map.get(k);
					                if (!arr || !arr.length) return null;
					                return arr.shift();
					              } catch (_) {
					                return null;
					              }
					            };
					            const hit = take(key1) || take(key2);
					            if (!hit) {
					              if (__tapeStrict) throw new Error('tape miss: ' + provider + ' fetch ' + url);
					              return __origFetchTape(input, init);
					            }
					            const payload = hit && hit.resBodyB64 ? Buffer.from(String(hit.resBodyB64), 'base64') : Buffer.from(String(hit.resBody || ''), 'utf8');
					            const status = Number(hit.statusCode || 200);
					            const headers = hit.resHeaders && typeof hit.resHeaders === 'object' ? hit.resHeaders : { 'content-type': 'application/json; charset=utf-8' };
					            if (typeof globalThis.Response === 'function') return new globalThis.Response(payload, { status, headers });
					            return payload.toString('utf8');
					          }

					          if (__tapeMode === 'record') {
					            const res = await __origFetchTape(input, init);
					            try {
					              const cloned = typeof res.clone === 'function' ? res.clone() : null;
					              const buf = cloned && typeof cloned.arrayBuffer === 'function' ? Buffer.from(await cloned.arrayBuffer()) : Buffer.alloc(0);
					              const key = __tapeKey(provider, method, host, pathLike, bodyStr);
					              const resHeaders = (() => {
					                try {
					                  const o = {};
					                  if (res && res.headers && typeof res.headers.forEach === 'function') res.headers.forEach((v, k) => { o[k] = v; });
					                  return o;
					                } catch (_) { return {}; }
					              })();
					              __appendTape(provider, {
					                v: 1,
					                provider,
					                key,
					                method,
					                host,
					                path: __stableQuery(pathLike),
					                reqHeaders: hdrs,
					                reqBody: bodyStr.slice(0, __tapeReqLimit),
					                statusCode: res && typeof res.status === 'number' ? res.status : 0,
					                resHeaders,
					                resBodyB64: buf.length ? buf.subarray(0, __tapeResLimit).toString('base64') : '',
					              });
					            } catch (_) {}
					            return res;
					          }

						          return __origFetchTape(input, init);
						        };
						      }
						    } catch (_) {}
						    */
						    const patch = (mod) => {
					      const orig = mod && typeof mod.request === 'function' ? mod.request : null;
					      if (!orig) return;
					      mod.request = function patchedRequest(options, cb) {
				        try {
		          const isUrl = options && typeof options === 'object' && options instanceof URL;
	          const hostname = isUrl
	            ? String(options.hostname || '')
	            : options && typeof options === 'string'
	              ? (() => { try { return String(new URL(options).hostname || ''); } catch (_) { return ''; } })()
	              : String((options && (options.hostname || options.host)) || '');
		          const host = __normalizeHost(hostname);
		          const __callStack = (() => {
		            try {
		              if (!__wantMockStack) return '';
		              return new Error('catpaw-call-stack').stack || '';
		            } catch (_) {
		              return '';
		            }
		          })();

			          /* Tape replay/record (http/https.request) removed.
			          // IMPORTANT: If CATPAW_MOCK is enabled and a mock interceptor matches this host, do not fall through to real network.
			          try {
			            const provider = __providerForHost(host);
			            const mockMatched = (() => {
			              try {
				                if (!__mockEnabled()) return false;
		                const it0 = __pickInterceptor(host);
		                return !!it0;
		              } catch (_) {
		                return false;
		              }
		            })();
		            const tapeOn = !mockMatched && __tapeMode !== 'off' && provider && __tapeTargets && __tapeTargets.has(provider);
		            if (tapeOn) {
		              const { EventEmitter } = require('events');
		              const { Readable } = require('stream');
		              const method = options && typeof options === 'object' && options.method ? String(options.method).toUpperCase() : 'GET';
		              const pth = options && typeof options === 'object' && typeof options.path === 'string' ? String(options.path) : isUrl ? String(options.pathname || '') + String(options.search || '') : '';
		              const hdrs = options && typeof options === 'object' && options.headers && typeof options.headers === 'object' ? options.headers : {};

		              const mkRes = (payloadStr, statusCode, headersObj) => {
		                const res = Readable.from([Buffer.from(String(payloadStr || ''), 'utf8')]);
		                res.statusCode = Number.isFinite(statusCode) ? statusCode : 200;
		                res.headers = headersObj && typeof headersObj === 'object' ? headersObj : { 'content-type': 'application/json; charset=utf-8' };
		                if (!('set-cookie' in res.headers)) res.headers['set-cookie'] = [];
		                return res;
		              };

		              if (__tapeMode === 'replay') {
		                class __CatPawTapeReplayRequest extends EventEmitter {
		                  constructor(meta) {
		                    super();
		                    this._meta = meta || {};
		                    this._chunks = [];
		                    this._replied = false;
		                    this.aborted = false;
		                    this.destroyed = false;
		                    this.writable = true;
		                    this.readable = false;
		                    this.socket = null;
		                    const cb2 = typeof cb === 'function' ? cb : null;
		                    const tryAuto = () => {
		                      try {
		                        if (this._replied || this.destroyed) return;
		                        const m = String(this._meta.method || 'GET').toUpperCase();
		                        if (m === 'GET' || m === 'HEAD') this._respond(cb2);
		                      } catch (_) {}
		                    };
		                    process.nextTick(tryAuto);
		                  }
		                  _respond(cb2) {
		                    if (this._replied || this.destroyed) return;
		                    this._replied = true;
		                    try {
		                      const buf = this._chunks && this._chunks.length ? Buffer.concat(this._chunks) : Buffer.alloc(0);
		                      const bodyStr = buf.length ? buf.toString('utf8') : '';
		                      const key1 = __tapeKey(provider, this._meta.method || 'GET', this._meta.host || '', this._meta.path || '', bodyStr);
		                      const key2 = __tapeKey(provider, this._meta.method || 'GET', this._meta.host || '', this._meta.path || '', '');
		                      const state = __tapeState && __tapeState.get(provider) ? __tapeState.get(provider) : null;
		                      const take = (k) => {
		                        try {
		                          if (!state || !state.map) return null;
		                          const arr = state.map.get(k);
		                          if (!arr || !arr.length) return null;
		                          return arr.shift();
		                        } catch (_) {
		                          return null;
		                        }
		                      };
		                      const hit = take(key1) || take(key2);
		                      if (!hit) {
		                        const err = new Error('tape miss: ' + provider + ' ' + String(this._meta.method || '') + ' ' + String(this._meta.host || '') + ' ' + String(this._meta.path || ''));
		                        if (__tapeStrict) throw err;
		                        try { this.emit('error', err); } catch (_) {}
		                        try { this.emit('close'); } catch (_) {}
		                        return;
		                      }
		                      const payload = hit && hit.resBodyB64 ? Buffer.from(String(hit.resBodyB64), 'base64').toString('utf8') : String(hit.resBody || '');
		                      const res = mkRes(payload, Number(hit.statusCode || 200), hit.resHeaders || { 'content-type': 'application/json; charset=utf-8' });
		                      try { if (cb2) cb2(res); } catch (_) {}
		                      this.emit('response', res);
		                      this.emit('close');
		                    } catch (e) {
		                      try { this.emit('error', e); } catch (_) {}
		                      try { this.emit('close'); } catch (_) {}
		                    }
		                  }
		                  abort() { this.aborted = true; return this.destroy(new Error('aborted')); }
		                  destroy(err) { this.destroyed = true; try { if (err) this.emit('error', err); } catch (_) {} return this; }
		                  end(_data, _enc, _cb) {
		                    try {
		                      const data = typeof _data === 'string' ? Buffer.from(_data, typeof _enc === 'string' ? _enc : 'utf8') : Buffer.isBuffer(_data) ? _data : null;
		                      if (data) this._chunks.push(Buffer.from(data));
		                    } catch (_) {}
		                    const cb3 = typeof _data === 'function' ? _data : typeof _enc === 'function' ? _enc : typeof _cb === 'function' ? _cb : null;
		                    try { if (cb3) process.nextTick(cb3); } catch (_) {}
		                    try { this._respond(typeof cb === 'function' ? cb : null); } catch (_) {}
		                    return this;
		                  }
		                  write(_data, _enc, _cb) {
		                    try {
		                      const data = typeof _data === 'string' ? Buffer.from(_data, typeof _enc === 'string' ? _enc : 'utf8') : Buffer.isBuffer(_data) ? _data : null;
		                      if (data) {
		                        const cur = this._chunks.reduce((n, b) => n + b.length, 0);
		                        if (cur < __tapeReqLimit) this._chunks.push(Buffer.from(data.subarray(0, Math.max(0, __tapeReqLimit - cur))));
		                      }
		                    } catch (_) {}
		                    const cb3 = typeof _enc === 'function' ? _enc : typeof _cb === 'function' ? _cb : null;
		                    try { if (cb3) process.nextTick(cb3); } catch (_) {}
		                    return true;
		                  }
		                  setTimeout(_ms, _cb) { try { if (typeof _cb === 'function') process.nextTick(_cb); } catch (_) {} return this; }
		                  setHeader() { return; }
		                  getHeader() { return undefined; }
		                  removeHeader() { return; }
		                }
		                const meta = { provider, host, method, path: pth, headers: hdrs };
		                return new __CatPawTapeReplayRequest(meta);
		              }

		              if (__tapeMode === 'record') {
		                const req = orig.call(mod, options, cb);
		                try {
		                  const reqChunks = [];
		                  const pushReq = (d, enc) => {
		                    try {
		                      if (d == null) return;
		                      const buf =
		                        typeof d === 'string'
		                          ? Buffer.from(d, typeof enc === 'string' ? enc : 'utf8')
		                          : Buffer.isBuffer(d)
		                            ? d
		                            : d instanceof Uint8Array
		                              ? Buffer.from(d)
		                              : null;
		                      if (!buf || !buf.length) return;
		                      const cur = reqChunks.reduce((n, b) => n + b.length, 0);
		                      if (cur >= __tapeReqLimit) return;
		                      reqChunks.push(buf.subarray(0, Math.max(0, __tapeReqLimit - cur)));
		                    } catch (_) {}
		                  };
		                  if (req && typeof req.write === 'function') {
		                    const ow = req.write.bind(req);
		                    req.write = function (d, enc, cb3) { pushReq(d, enc); return ow(d, enc, cb3); };
		                  }
		                  if (req && typeof req.end === 'function') {
		                    const oe = req.end.bind(req);
		                    req.end = function (d, enc, cb3) { pushReq(d, enc); return oe(d, enc, cb3); };
		                  }
		                  req.once('response', (res) => {
		                    try {
		                      const resChunks = [];
		                      let resBytes = 0;
		                      res.on('data', (c) => {
		                        try {
		                          const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
		                          if (resBytes >= __tapeResLimit) return;
		                          const take = Math.min(b.length, __tapeResLimit - resBytes);
		                          if (take > 0) {
		                            resChunks.push(b.subarray(0, take));
		                            resBytes += take;
		                          }
		                        } catch (_) {}
		                      });
		                      res.on('end', () => {
		                        try {
		                          const reqBody = reqChunks.length ? Buffer.concat(reqChunks).toString('utf8') : '';
		                          const resBodyBuf = resChunks.length ? Buffer.concat(resChunks) : Buffer.alloc(0);
		                          const key = __tapeKey(provider, method, host, pth, reqBody);
		                          __appendTape(provider, {
		                            v: 1,
		                            provider,
		                            key,
		                            method,
		                            host,
		                            path: __stableQuery(pth),
		                            reqHeaders: hdrs,
		                            reqBody,
		                            statusCode: res && res.statusCode ? Number(res.statusCode || 0) : 0,
		                            resHeaders: res && res.headers ? res.headers : {},
		                            resBodyB64: resBodyBuf.length ? resBodyBuf.toString('base64') : '',
		                          });
		                        } catch (_) {}
		                      });
		                    } catch (_) {}
		                  });
		                } catch (_) {}
		                return req;
			              }
			            }
			          } catch (_) {}
			          */

				          const it = __pickInterceptor(host);
				          if (it) {
				            try {
			              const { EventEmitter } = require('events');
		              const { Readable } = require('stream');
		              const interceptor = it;
		              class __CatPawBlockedRequest extends EventEmitter {
	                constructor(err, meta) {
	                  super();
	                  this._err = err;
	                  this._meta = meta || {};
	                  this._chunks = [];
	                  this._startedAt = Date.now();
	                  this.aborted = false;
	                  this.destroyed = false;
	                  this.writable = true;
	                  this.readable = false;
	                  this.socket = null;
	                  const cb2 = typeof cb === 'function' ? cb : null;
	                  process.nextTick(() => {
	                    try {
	                      if (this.destroyed) return;
			                      try {
			                        const buf = this._chunks && this._chunks.length ? Buffer.concat(this._chunks) : Buffer.alloc(0);
			                        const reqBodyCap = __captureBodyPreview(buf, __packetCaptureBodyLimit(), this._meta.headers || {});
			                        const body = reqBodyCap && typeof reqBodyCap.text === 'string' ? reqBodyCap.text : '';
			                        try { this._meta.body = body; } catch (_) {}
				                        try {
				                          const creds = __extractInterceptCreds(interceptor && interceptor.name ? interceptor.name : '', this._meta.host || '', this._meta.path || '', this._meta.headers || {}, body);
				                          interceptor.log({
				                          type: 'http',
				                          provider: interceptor && interceptor.name ? interceptor.name : '',
				                          host: this._meta.host || '',
				                          method: this._meta.method || '',
			                          path: this._meta.path || '',
			                          headers: this._meta.headers || {},
				                          body,
				                          creds,
				                          stack: this._meta.stack || '',
				                          });
				                        } catch (_) {}
				                      } catch (_) {}
				                      const mocked = interceptor.mock(this._meta);
				                      try {
				                        interceptor.log({
				                          type: 'mock',
				                          via: 'http',
				                          kind: mocked.kind,
				                          host: this._meta.host || '',
				                          method: this._meta.method || '',
				                          path: this._meta.path || '',
				                          stoken: mocked.kind === 'token' ? (__tryParseJson(mocked.payload)?.data?.stoken || '') : '',
				                          stack: this._meta.stack || '',
				                        });
				                      } catch (_) {}
					                      const payloadBuf = (() => {
					                        try {
					                          const b64 = mocked && typeof mocked.payloadB64 === 'string' ? mocked.payloadB64 : '';
					                          if (b64) return Buffer.from(b64, 'base64');
					                        } catch (_) {}
					                        try {
					                          return Buffer.from(mocked && mocked.payload != null ? String(mocked.payload) : '', 'utf8');
					                        } catch (_) {
					                          return Buffer.alloc(0);
					                        }
					                      })();
					                      const payload = payloadBuf.toString('utf8');
				                      const statusCode = mocked && Number.isFinite(mocked.statusCode) ? mocked.statusCode : 200;
				                      const headersRaw = mocked && mocked.headers && typeof mocked.headers === 'object' ? mocked.headers : null;
				                      const headers = headersRaw || { 'content-type': 'application/json; charset=utf-8', 'set-cookie': [] };
					                      const resBodyCap = __captureBodyPreview(payloadBuf, __packetCaptureBodyLimit(), headers || {});
					                      const res = Readable.from([payloadBuf]);
				                      if (!('set-cookie' in headers)) headers['set-cookie'] = [];
				                      res.statusCode = statusCode;
			                      res.headers = headers;
			                      try {
				                        if (__mockDebug() && mocked && mocked.kind && typeof mocked.kind === 'string' && mocked.kind.includes('detail')) {
			                          const parsed = __tryParseJson(payload);
			                          const list = parsed && parsed.data && Array.isArray(parsed.data.list) ? parsed.data.list : [];
			                          const meta = parsed && parsed.data && parsed.data.metadata ? parsed.data.metadata : null;
			                          interceptor.log({
			                            type: 'mock_summary',
			                            via: 'http',
			                            kind: mocked.kind,
			                            host: this._meta.host || '',
			                            path: this._meta.path || '',
			                            listLen: list.length,
			                            firstName: list[0] && list[0].file_name ? String(list[0].file_name) : '',
			                            total: meta && meta._total != null ? meta._total : null,
			                          });
			                        }
			                      } catch (_) {}
			                      try {
			                        __appendPacketCaptureLog({
			                          type: 'http',
			                          id: __nextPacketCaptureId(),
			                          at: this._startedAt || Date.now(),
			                          duration_ms: Date.now() - (this._startedAt || Date.now()),
			                          pan_mock_intercepted: true,
			                          request: {
			                            method: this._meta.method || '',
			                            protocol: '',
			                            url: __composeUrl('', this._meta.host || '', 0, this._meta.path || ''),
			                            host: this._meta.host || '',
			                            port: 0,
			                            path: this._meta.path || '',
			                            headers: __normalizeCaptureHeaders(this._meta.headers || {}),
			                            body: body,
			                            body_bytes: reqBodyCap && Number.isFinite(Number(reqBodyCap.bytes)) ? Math.max(0, Math.trunc(Number(reqBodyCap.bytes))) : 0,
			                            body_truncated: !!(reqBodyCap && reqBodyCap.truncated),
			                            body_encoding: reqBodyCap && reqBodyCap.encoding ? String(reqBodyCap.encoding) : '',
			                            body_decoded: !!(reqBodyCap && reqBodyCap.decoded),
			                          },
			                          response: {
			                            status: statusCode,
			                            headers: __normalizeCaptureHeaders(headers || {}),
			                            body: resBodyCap && typeof resBodyCap.text === 'string' ? resBodyCap.text : payload,
			                            body_bytes: resBodyCap && Number.isFinite(Number(resBodyCap.bytes)) ? Math.max(0, Math.trunc(Number(resBodyCap.bytes))) : 0,
			                            body_truncated: !!(resBodyCap && resBodyCap.truncated),
			                            body_encoding: resBodyCap && resBodyCap.encoding ? String(resBodyCap.encoding) : '',
			                            body_decoded: !!(resBodyCap && resBodyCap.decoded),
			                          },
			                        });
			                      } catch (_) {}
			                      try { if (cb2) cb2(res); } catch (_) {}
			                      this.emit('response', res);
			                      this.emit('close');
		                    } catch (_) {
		                      try { this.emit('error', this._err); } catch (_) {}
		                    }
	                  });
	                }
		                abort() {
		                  this.aborted = true;
		                  return this.destroy(this._err);
		                }
	                destroy(err) {
	                  this.destroyed = true;
	                  try { if (err) this.emit('error', err); } catch (_) {}
	                  return this;
	                }
	                end(_data, _enc, _cb) {
	                  try {
	                    const data = typeof _data === 'string' ? Buffer.from(_data, typeof _enc === 'string' ? _enc : 'utf8') : Buffer.isBuffer(_data) ? _data : null;
	                    if (data) this._chunks.push(Buffer.from(data));
	                  } catch (_) {}
	                  const cb3 = typeof _data === 'function' ? _data : typeof _enc === 'function' ? _enc : typeof _cb === 'function' ? _cb : null;
	                  try { if (cb3) process.nextTick(cb3); } catch (_) {}
	                  return this;
	                }
	                write(_data, _enc, _cb) {
	                  try {
	                    const data = typeof _data === 'string' ? Buffer.from(_data, typeof _enc === 'string' ? _enc : 'utf8') : Buffer.isBuffer(_data) ? _data : null;
	                    if (data) this._chunks.push(Buffer.from(data));
	                  } catch (_) {}
	                  const cb3 = typeof _enc === 'function' ? _enc : typeof _cb === 'function' ? _cb : null;
	                  try { if (cb3) process.nextTick(cb3); } catch (_) {}
	                  return true;
	                }
	                setTimeout(_ms, _cb) { try { if (typeof _cb === 'function') process.nextTick(_cb); } catch (_) {} return this; }
	                setHeader() { return; }
	                getHeader() { return undefined; }
	                removeHeader() { return; }
	              }
			              const meta = (() => {
			                try {
			                  const method = options && typeof options === 'object' && options.method ? String(options.method).toUpperCase() : 'GET';
			                  const pth = options && typeof options === 'object' && typeof options.path === 'string' ? options.path : '';
			                  const hdrs = options && typeof options === 'object' && options.headers && typeof options.headers === 'object' ? options.headers : {};
			                  return { host, method, path: pth, headers: hdrs, stack: __callStack };
			                } catch (_) {
			                  return { host, stack: __callStack };
			                }
			              })();
			              return new __CatPawBlockedRequest(new Error('blocked by CATPAW_MOCK'), meta);
			            } catch (_) {
			              throw new Error('blocked by CATPAW_MOCK');
		            }
		          }

		          let provider = '';
		          if (__isQuarkHost(host)) provider = 'quark';
		          else if (__isUcHost(host) || host.includes('open-api-drive.uc.cn')) provider = 'uc';
		          else if (__is139Host(host)) provider = '139';
		          else if (__isBaiduPanHost(host) || host.endsWith('baidu.com')) provider = 'baidu';
		          else if (__isTianyiHost(host)) provider = 'tianyi';

		          // Cookie injection (legacy behavior).
		          if (provider) {
		            const cookie = pickCookie(provider);
		            if (cookie) {
		              const hdrs = (isUrl ? null : options && typeof options === 'object' ? options.headers : null) || {};
		              const lower = Object.keys(hdrs).reduce((m, k) => { m[String(k).toLowerCase()] = k; return m; }, {});
		              const ckKey = lower['cookie'] || 'Cookie';
		              const cur = hdrs[ckKey];
		              const curStr = cur == null ? '' : String(cur);
		              if (!curStr.trim()) {
		                hdrs[ckKey] = cookie;
		                if (!isUrl && options && typeof options === 'object') options.headers = hdrs;
		              }
		            }
		          }
	        } catch (_) {}

	        // Per-site proxy: set a proxy agent based on current spider site.
	        try {
	          const proxyUrl = __pickProxyForHost(host);
	          if (proxyUrl) {
	            const agent = __getNodeProxyAgent(proxyUrl);
	            if (agent) {
	              // Prefer not to override a caller-specified agent.
	              if (options && typeof options === 'object' && !Array.isArray(options) && !(options instanceof URL)) {
	                if (!options.agent) options.agent = agent;
	              } else if (typeof options === 'string') {
	                try {
	                  const u = new URL(options);
	                  options = {
	                    protocol: u.protocol,
	                    hostname: u.hostname,
	                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
	                    path: String(u.pathname || '/') + String(u.search || ''),
	                    agent,
	                  };
	                } catch (_) {}
	              } else if (options && typeof options === 'object' && options instanceof URL) {
	                try {
	                  const u = options;
	                  options = {
	                    protocol: u.protocol,
	                    hostname: u.hostname,
	                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
	                    path: String(u.pathname || '/') + String(u.search || ''),
	                    agent,
	                  };
	                } catch (_) {}
	              }
	            }
	          }
	        } catch (_) {}

	        const req = orig.call(mod, options, cb);
	        try {
	          if (__packetCaptureEnabled() && req) {
	            const startedAt = Date.now();
	            const requestId = __nextPacketCaptureId();
	            const limit = __packetCaptureBodyLimit();
	            const meta = (() => {
	              try {
	                const isUrl2 = options && typeof options === 'object' && options instanceof URL;
	                const isObj = options && typeof options === 'object' && !Array.isArray(options) && !isUrl2;
	                let protocol = mod === https ? 'https:' : 'http:';
	                if (isUrl2 && options.protocol) protocol = String(options.protocol || protocol);
	                else if (isObj && typeof options.protocol === 'string' && options.protocol) protocol = String(options.protocol);
	                let hostRaw = '';
	                if (isUrl2) hostRaw = String(options.hostname || '');
	                else if (typeof options === 'string') {
	                  try {
	                    hostRaw = String(new URL(options).hostname || '');
	                  } catch (_) {}
	                } else if (isObj) {
	                  hostRaw = String(options.hostname || options.host || '');
	                }
	                const host = __normalizeHost(hostRaw);
	                let pathLike = '/';
	                if (isUrl2) {
	                  pathLike = String(options.pathname || '') + String(options.search || '');
	                } else if (typeof options === 'string') {
	                  try {
	                    const u = new URL(options);
	                    pathLike = String(u.pathname || '') + String(u.search || '') || '/';
	                  } catch (_) {}
	                } else if (isObj && typeof options.path === 'string' && options.path) {
	                  pathLike = String(options.path);
	                }
	                if (!pathLike) pathLike = '/';
	                let port = 0;
	                if (isUrl2) {
	                  const p = Number(options.port || 0);
	                  port = Number.isFinite(p) && p > 0 ? Math.trunc(p) : protocol === 'https:' ? 443 : 80;
	                } else if (typeof options === 'string') {
	                  try {
	                    const u = new URL(options);
	                    const p = Number(u.port || 0);
	                    const up = String(u.protocol || '').trim();
	                    port = Number.isFinite(p) && p > 0 ? Math.trunc(p) : up === 'https:' ? 443 : 80;
	                  } catch (_) {
	                    port = protocol === 'https:' ? 443 : 80;
	                  }
	                } else if (isObj) {
	                  const p = Number(options.port || 0);
	                  if (Number.isFinite(p) && p > 0) port = Math.trunc(p);
	                  if (!port && typeof options.host === 'string') {
	                    const m = /:(\d+)$/.exec(String(options.host || '').trim());
	                    if (m && m[1]) {
	                      const p2 = Number(m[1]);
	                      if (Number.isFinite(p2) && p2 > 0) port = Math.trunc(p2);
	                    }
	                  }
	                  if (!port) port = protocol === 'https:' ? 443 : 80;
	                }
	                const method =
	                  isObj && options.method ? String(options.method).toUpperCase() : 'GET';
	                const headers = __normalizeCaptureHeaders(isObj && options.headers ? options.headers : null);
	                let url = host ? __composeUrl(protocol, host, port, pathLike) : '';
	                if (!url && typeof options === 'string') url = String(options || '');
	                return { protocol, method, host, port, path: pathLike, url, headers };
	              } catch (_) {
	                return {
	                  protocol: mod === https ? 'https:' : 'http:',
	                  method: 'GET',
	                  host: '',
	                  port: 0,
	                  path: '',
	                  url: '',
	                  headers: {},
	                };
	              }
	            })();

	            const reqState = { chunks: [], total: 0, stored: 0 };
	            const resState = { chunks: [], total: 0, stored: 0 };
	            const pushChunk = (state, data, enc) => {
	              try {
	                const buf = __toCaptureBuffer(data, enc);
	                if (!buf || !buf.length) return;
	                state.total += buf.length;
	                if (limit <= 0) return;
	                if (state.stored >= limit) return;
	                const remain = Math.max(0, limit - state.stored);
	                if (!remain) return;
	                const take = Math.min(buf.length, remain);
	                if (take <= 0) return;
	                state.chunks.push(buf.subarray(0, take));
	                state.stored += take;
	              } catch (_) {}
	            };
	            const packBody = (state, headersLike) => {
	              try {
	                const bodyBuf = state && state.chunks && state.chunks.length ? Buffer.concat(state.chunks) : Buffer.alloc(0);
	                const encodings = __parseContentEncodings(headersLike);
	                const decoded = __decodeBufferByEncodings(bodyBuf, encodings);
	                const printable = decoded && decoded.buffer ? decoded.buffer : bodyBuf;
	                let text = '';
	                try {
	                  text = printable.toString('utf8');
	                } catch (_) {
	                  text = '';
	                }
	                const bytes = Number.isFinite(Number(state && state.total)) ? Math.max(0, Math.trunc(Number(state.total))) : bodyBuf.length;
	                return {
	                  body: text,
	                  body_bytes: bytes,
	                  body_truncated: limit > 0 && bytes > limit,
	                  body_encoding: encodings.join(','),
	                  body_decoded: !!(decoded && decoded.decoded),
	                };
	              } catch (_) {
	                return { body: '', body_bytes: 0, body_truncated: false };
	              }
	            };
	            let done = false;
	            const finish = (payload) => {
	              try {
	                if (done) return;
	                done = true;
	                const reqBodyOut = packBody(reqState, meta.headers || {});
	                const out = {
	                  type: 'http',
	                  id: requestId,
	                  at: startedAt,
	                  duration_ms: Date.now() - startedAt,
	                  pan_mock_intercepted: false,
	                  request: {
	                    method: meta.method,
	                    protocol: meta.protocol,
	                    url: meta.url,
	                    host: meta.host,
	                    port: meta.port,
	                    path: meta.path,
	                    headers: meta.headers,
	                    body: reqBodyOut.body,
	                    body_bytes: reqBodyOut.body_bytes,
	                    body_truncated: reqBodyOut.body_truncated,
	                    body_encoding: reqBodyOut.body_encoding || '',
	                    body_decoded: !!reqBodyOut.body_decoded,
	                  },
	                };
	                const p = payload && typeof payload === 'object' ? payload : {};
	                if (p.response && typeof p.response === 'object') {
	                  const resHeadersLike = p.response.headers && typeof p.response.headers === 'object' ? p.response.headers : {};
	                  const resBodyOut = packBody(resState, resHeadersLike);
	                  out.response = {
	                    status:
	                      Number.isFinite(Number(p.response.status)) && Number(p.response.status) > 0
	                        ? Math.trunc(Number(p.response.status))
	                        : 0,
	                    headers:
	                      p.response.headers && typeof p.response.headers === 'object' ? p.response.headers : {},
	                    body: resBodyOut.body,
	                    body_bytes: resBodyOut.body_bytes,
	                    body_truncated: resBodyOut.body_truncated,
	                    body_encoding: resBodyOut.body_encoding || '',
	                    body_decoded: !!resBodyOut.body_decoded,
	                  };
	                }
	                if (p.error && typeof p.error === 'object') out.error = p.error;
	                if (p.aborted) out.aborted = true;
	                if (p.closed) out.closed = true;
	                __appendPacketCaptureLog(out);
	              } catch (_) {}
	            };

	            try {
	              if (typeof req.write === 'function') {
	                const ow = req.write.bind(req);
	                req.write = function patchedWrite(d, enc, cb2) {
	                  try {
	                    pushChunk(reqState, d, enc);
	                  } catch (_) {}
	                  return ow(d, enc, cb2);
	                };
	              }
	            } catch (_) {}

	            try {
	              if (typeof req.end === 'function') {
	                const oe = req.end.bind(req);
	                req.end = function patchedEnd(d, enc, cb2) {
	                  try {
	                    if (d != null && typeof d !== 'function') pushChunk(reqState, d, enc);
	                  } catch (_) {}
	                  return oe(d, enc, cb2);
	                };
	              }
	            } catch (_) {}

	            try {
	              req.once('response', (res) => {
	                const resHeaders = __normalizeCaptureHeaders(res && res.headers ? res.headers : null);
	                try {
	                  if (res && typeof res.on === 'function') {
	                    res.on('data', (chunk) => {
	                      try {
	                        pushChunk(resState, chunk);
	                      } catch (_) {}
	                    });
	                    res.on('end', () => {
	                      finish({
	                        response: {
	                          status: res && Number.isFinite(Number(res.statusCode)) ? Math.max(0, Math.trunc(Number(res.statusCode))) : 0,
	                          headers: resHeaders,
	                        },
	                      });
	                    });
	                    res.on('error', (e) => {
	                      finish({
	                        error: {
	                          message: e && e.message ? String(e.message) : String(e),
	                          code: e && e.code ? String(e.code) : '',
	                          name: e && e.name ? String(e.name) : '',
	                        },
	                      });
	                    });
	                  }
	                } catch (_) {}
	              });
	            } catch (_) {}

	            try {
	              req.once('error', (e) => {
	                finish({
	                  error: {
	                    message: e && e.message ? String(e.message) : String(e),
	                    code: e && e.code ? String(e.code) : '',
	                    name: e && e.name ? String(e.name) : '',
	                  },
	                });
	              });
	            } catch (_) {}

	            try {
	              req.once('abort', () => finish({ aborted: true }));
	            } catch (_) {}

	            try {
	              req.once('close', () => finish({ closed: true }));
	            } catch (_) {}
	          }
	        } catch (_) {}
	        return req;
	      };
	    };
		    patch(http);
		    patch(https);
	  } catch (_) {}

	  const __beforeKeys = (() => {
	    try { return new Set(Object.getOwnPropertyNames(globalThis)); } catch (_) { return new Set(); }
	  })();
	  __stage('vm_eval_start');
	  try {
	    vm.runInThisContext(fs.readFileSync(entry, 'utf8'), { filename: entry });
	  } catch (e) {
	    __log('vm_eval_failed', e && e.stack ? e.stack : String(e));
	    __send({ type: 'fatal', kind: 'vm_eval', message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' });
	    throw e;
	  }
	  try {
	    const after = Object.getOwnPropertyNames(globalThis);
	    const added = [];
	    for (const k of after) if (!__beforeKeys.has(k)) added.push(k);
	    globalThis.__catpaw_online_entry_added_keys = added;
	  } catch (_) {
	    try { globalThis.__catpaw_online_entry_added_keys = []; } catch (_) {}
	  }
	  __stage('vm_eval_done');
	})();

		(async () => {
		  const __send = (globalThis && globalThis.__catpaw_online_send) || (() => {});
		  const __log = (globalThis && globalThis.__catpaw_online_log) || (() => {});
		  const __stage = (globalThis && globalThis.__catpaw_online_stage) || (() => {});
		  __stage('runtime_start');
		  const ensureConfigDefaults = (srv) => {
		    try {
		      if (!srv || typeof srv !== 'object') return;
	      if (!srv.config || typeof srv.config !== 'object' || Array.isArray(srv.config)) srv.config = {};
	      const ensureObj = (k) => {
	        const cur = srv.config[k];
	        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) srv.config[k] = {};
	      };
      // Keys referenced by the bundled website/account routes.
      [
        'baidu',
        'quark',
        'uc',
        'y115',
        'pan123ziyuan',
        'bili',
        'wuming',
        'ali',
        'tgsou',
        'tgchannel',
        'pans',
        'sites',
        'muou',
        'leijing',
        'wogg',
        'livetovod',
      ].forEach(ensureObj);
      if (!Array.isArray(srv.config.pans.list)) srv.config.pans.list = [];
      if (!Array.isArray(srv.config.sites.list)) srv.config.sites.list = [];
	    } catch (_) {}
	  };

  const patchBodyShape = (srv) => {
    try {
      if (!srv || typeof srv.addHook !== 'function') return;
      srv.addHook('preValidation', async function (request) {
        try {
          if (!request) return;
          const method = String(request.method || '').toUpperCase();
          if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

          let body = request.body;
          if (body == null) {
            request.body = { data: {} };
            return;
          }

          if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');

          if (typeof body === 'string') {
            const trimmed = body.trim();
            if (!trimmed) {
              request.body = { data: {} };
              return;
            }

            // JSON string
            if (
              (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
              (trimmed.startsWith('[') && trimmed.endsWith(']'))
            ) {
              try {
                body = JSON.parse(trimmed);
              } catch (_) {
                body = trimmed;
              }
            }

            // x-www-form-urlencoded (e.g. cookie=xxx or data[cookie]=xxx)
            if (typeof body === 'string' && body.includes('=')) {
              try {
                const params = new URLSearchParams(body);
                const plain = {};
                for (const [k, v] of params.entries()) plain[k] = v;
                const cookie =
                  plain.cookie ??
                  plain['data[cookie]'] ??
                  plain['data.cookie'] ??
                  plain['data%5Bcookie%5D'];
                if (cookie !== undefined) {
                  request.body = Object.assign({}, plain, { data: Object.assign({}, plain, { cookie }) });
                  return;
                }
                request.body = Object.assign({}, plain, { data: plain });
                return;
              } catch (_) {
                // fallthrough
              }
            }

            // Plain string; best-effort treat it as cookie.
            request.body = { data: { cookie: body } };
            return;
          }

          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            request.body = { data: {} };
            return;
          }

          if (body.data === undefined || body.data === null) {
            request.body = Object.assign({}, body, { data: body });
            return;
          }
          if (typeof body.data !== 'object' || Array.isArray(body.data)) {
            request.body = Object.assign({}, body, { data: Object.assign({}, body) });
          }
        } catch (_) {
          // best-effort only
        }
      });
    } catch (_) {
      // ignore if server is already ready/started
    }
		  };

	  const pickServerRef = () => {
	    try {
	      const candidates = [
	        globalThis.xn,
	        globalThis.un,
	        globalThis.srv,
	        globalThis.server,
	        globalThis.app,
	        globalThis.fastify,
	      ];
	      for (const c of candidates) if (c && typeof c === 'object') return c;
	    } catch (_) {}
	    return null;
	  };

		  const resolveEntryCandidates = () => {
	    const envName = (() => {
	      try {
	        return (
	          String(process.env.ONLINE_ENTRY_FN || '').trim() ||
	          String(process.env.CATPAW_ONLINE_ENTRY_FN || '').trim() ||
	          String(process.env.CATPAW_ENTRY_FN || '').trim()
	        );
	      } catch (_) {
	        return '';
	      }
	    })();

	    const candidates = [];
	    const seen = new Set();

	    const pushCandidate = (name, via) => {
	      try {
	        const n = String(name || '').trim();
	        if (!n || seen.has(n)) return;
	        const f = globalThis ? globalThis[n] : null;
	        if (typeof f !== 'function') return;
	        seen.add(n);
	        candidates.push({ fn: f, name: n, via: String(via || '') });
	      } catch (_) {}
	    };

	    if (envName) pushCandidate(envName, 'env');
	    if (typeof globalThis.Ndr === 'function') pushCandidate('Ndr', 'default');

		    const addedKeys = (() => {
		      try {
		        return Array.isArray(globalThis.__catpaw_online_entry_added_keys) ? globalThis.__catpaw_online_entry_added_keys : [];
		      } catch (_) {
		        return [];
	      }
	    })();

	    const addedFns = [];
	    for (const k of addedKeys) {
	      try {
	        if (typeof globalThis[k] === 'function') addedFns.push(k);
	      } catch (_) {}
	    }

	    const scoreFn = (name) => {
	      let score = 0;
	      try {
	        const fn = globalThis[name];
	        if (typeof fn !== 'function') return -1;
	        if (/^nd[rR]$/i.test(name)) score += 100;
	        if (/^(start|main|run|bootstrap|init)$/i.test(name)) score += 40;
	        if (fn.length >= 1) score += 20;
	        const src = (() => {
	          try { return Function.prototype.toString.call(fn); } catch (_) { return ''; }
	        })();
	        if (src.includes('serverFactory:catServerFactory')) score += 60;
	        if (src.includes('catServerFactory')) score += 25;
	        if (src.includes('DEV_HTTP_PORT') || src.includes('HTTP_PORT') || src.includes('PORT')) score += 10;
	        if (src.includes('.listen(') || src.includes('listen({')) score += 10;
	        if (src.includes('.register(')) score += 6;
	        if (src.includes('messageToDart')) score += 6;
	        if (src.includes('JsonDB') || src.includes('db.json')) score += 4;
	        if (/^(stop|close|dispose|destroy|shutdown|teardown)$/i.test(name)) score -= 100;
	      } catch (_) {}
	      return score;
	    };

	    let best = '';
	    let bestScore = -1;
	    for (const n of addedFns) {
	      const sc = scoreFn(n);
	      if (sc > bestScore) {
	        bestScore = sc;
	        best = n;
	      }
		    }

		    if (best && bestScore >= 30) pushCandidate(best, 'auto');

		    try {
		      const ranked = addedFns
		        .map((n) => ({ n, sc: scoreFn(n) }))
		        .sort((a, b) => b.sc - a.sc)
	        .map((x) => x.n);
	      for (const n of ranked) pushCandidate(n, 'auto_rank');
	    } catch (_) {}

		    return { candidates, envName, addedFns };
		  };

		  const buildCompatStartConfig = async () => {
		    const out = { sites: { list: [] }, pans: { list: [] }, color: [] };
		    try {
		      const fromEnvUrl =
		        String(process.env.CATPAW_ONLINE_SERVER_URL || '').trim() ||
		        String(process.env.ONLINE_SERVER_URL || '').trim();
		      const fromEnvAuth =
		        String(process.env.CATPAW_ONLINE_SERVER_AUTH || '').trim() ||
		        String(process.env.ONLINE_SERVER_AUTH || '').trim();
		      if (fromEnvUrl) {
		        const server = { url: fromEnvUrl, authorization: fromEnvAuth };
		        out.server = server;
		        out.config = { server };
		        return out;
		      }
		    } catch (_) {}

		    const readEntryRemoteUrlFromMeta = () => {
		      try {
		        const entryPath = String(process.env.ONLINE_ENTRY || '').trim();
		        if (!entryPath) return '';
		        const dir = path.dirname(entryPath);
		        const base = path.basename(entryPath);
		        const metaPath = path.resolve(dir, '.' + base + '.remote.json');
		        if (!fs.existsSync(metaPath)) return '';
		        const raw = fs.readFileSync(metaPath, 'utf8');
		        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
		        return parsed && typeof parsed.url === 'string' ? parsed.url.trim() : '';
		      } catch (_) {
		        return '';
		      }
		    };

		    const deriveConfigUrl = (entryUrl) => {
		      try {
		        const u = new URL(String(entryUrl || '').trim());
		        let p = String(u.pathname || '');
		        if (!p) return '';
		        if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) {
		          const i = p.lastIndexOf('.');
		          p = p.slice(0, i) + '.config.js';
		        } else {
		          p = p.replace(/\\/+$/, '') + '.config.js';
		        }
		        u.pathname = p;
		        u.search = '';
		        u.hash = '';
		        return u.toString();
		      } catch (_) {
		        return '';
		      }
		    };

		    const parseConfigObject = (text) => {
		      const t = String(text || '').trim();
		      if (!t) return null;
		      try {
		        const j = JSON.parse(t);
		        return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
		      } catch (_) {}
		      try {
		        const vm2 = require('node:vm');
		        const sandbox = { module: { exports: {} }, exports: {} };
		        vm2.runInNewContext(t, sandbox, { timeout: 1500, filename: 'remote.index.config.js' });
		        const cand =
		          (sandbox.module && sandbox.module.exports) ||
		          (sandbox.exports && sandbox.exports.default) ||
		          sandbox.exports ||
		          null;
		        return cand && typeof cand === 'object' && !Array.isArray(cand) ? cand : null;
		      } catch (_) {
		        return null;
		      }
		    };

		    const fetchTextWithFallback = async (targetUrl, timeoutMs) => {
		      const urlStr = String(targetUrl || '').trim();
		      if (!urlStr) return { status: 0, text: '' };
		      const to = Math.max(1000, Math.trunc(Number(timeoutMs || 0)) || 0) || 12000;
		      const resolveRequestAuth = (rawUrl) => {
		        try {
		          const u = new URL(String(rawUrl || '').trim());
		          const hasUserInfo = typeof u.username === 'string' && u.username.length > 0;
		          const requestUrl = hasUserInfo ? (u.protocol + '//' + u.host + u.pathname + u.search + u.hash) : u.toString();
		          if (!hasUserInfo) return { requestUrl, basicAuth: '' };
		          const username = decodeURIComponent(u.username || '');
		          const password = decodeURIComponent(u.password || '');
		          const basicAuth = 'Basic ' + Buffer.from(String(username || '') + ':' + String(password || ''), 'utf8').toString('base64');
		          return { requestUrl, basicAuth };
		        } catch (_) {
		          return { requestUrl: String(rawUrl || '').trim(), basicAuth: '' };
		        }
		      };
		      const { requestUrl, basicAuth } = resolveRequestAuth(urlStr);
		      const headers = {
		        accept: '*/*',
		        ...(basicAuth ? { authorization: basicAuth } : {}),
		      };

		      // Prefer built-in fetch in Node 18+ / pkg runtime.
		      try {
		        if (typeof globalThis.fetch === 'function') {
		          const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		          const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, to) : null;
		          try {
		            const res = await globalThis.fetch(requestUrl, {
		              method: 'GET',
		              redirect: 'follow',
		              headers,
		              signal: ctrl ? ctrl.signal : undefined,
		            });
		            const txt = await res.text();
		            return { status: Number(res && res.status ? res.status : 0), text: String(txt || '') };
		          } finally {
		            if (timer) clearTimeout(timer);
		          }
		        }
		      } catch (_) {}

		      // Fallback: plain http/https request (avoid axios dependency in pkg mode).
		      return await new Promise((resolve, reject) => {
		        try {
		          const u = new URL(requestUrl);
		          const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
		          const req = mod.request(
		            {
		              protocol: u.protocol,
		              hostname: u.hostname,
		              port: u.port || (u.protocol === 'https:' ? 443 : 80),
		              path: (u.pathname || '/') + (u.search || ''),
		              method: 'GET',
		              timeout: to,
		              headers,
		            },
		            (res) => {
		              try {
		                const bufs = [];
		                res.on('data', (c) => { try { if (c != null) bufs.push(Buffer.from(c)); } catch (_) {} });
		                res.on('end', () => {
		                  try {
		                    const body = Buffer.concat(bufs).toString('utf8');
		                    resolve({ status: Number(res && res.statusCode ? res.statusCode : 0), text: body });
		                  } catch (e) {
		                    reject(e);
		                  }
		                });
		              } catch (e) {
		                reject(e);
		              }
		            }
		          );
		          req.on('timeout', () => {
		            try { req.destroy(new Error('timeout')); } catch (_) {}
		          });
		          req.on('error', reject);
		          req.end();
		        } catch (e) {
		          reject(e);
		        }
		      });
		    };

		    try {
		      const entryRemoteUrl = readEntryRemoteUrlFromMeta();
		      const cfgUrl = deriveConfigUrl(entryRemoteUrl);
		      if (cfgUrl) {
		        try { __log('entryFn_config_url', cfgUrl); } catch (_) {}
		        const res = await fetchTextWithFallback(cfgUrl, 12000);
		        const status = Number(res && res.status ? res.status : 0);
		        if (status >= 200 && status < 300) {
		          const txt = String(res && res.text ? res.text : '');
		          const cfgObj = parseConfigObject(txt);
		          const s = cfgObj && cfgObj.server && typeof cfgObj.server === 'object' ? cfgObj.server : null;
		          const url = s && typeof s.url === 'string' ? s.url.trim() : '';
		          const authorization = s && typeof s.authorization === 'string' ? s.authorization.trim() : '';
		          if (url) {
		            const server = { url, authorization };
		            out.server = server;
		            out.config = { server };
		            return out;
		          }
		        }
		      }
		    } catch (e) {
		      try { __log('entryFn_config_fetch_failed', e && e.message ? String(e.message) : String(e)); } catch (_) {}
		    }

		    return out;
		  };

		  const waitForListening = async (timeoutMs) => {
		    const t0 = Date.now();
		    const lim = Math.max(250, Math.trunc(Number(timeoutMs || 0)) || 0) || 6000;
		    while (Date.now() - t0 < lim) {
		      try {
	        const p = Number(globalThis.__catpaw_online_listen_port || 0);
	        if (Number.isFinite(p) && p > 0) return true;
	      } catch (_) {}
	      try {
	        const srv = pickServerRef();
	        const addr = srv && typeof srv.address === 'function' ? srv.address() : null;
	        const p = addr && addr.port ? Number(addr.port) : 0;
	        if (Number.isFinite(p) && p > 0) return true;
	      } catch (_) {}
	      await new Promise((r) => setTimeout(r, 50));
	    }
		    return false;
		  };

		  try {
		    const ok = await waitForListening(250);
		    if (ok) {
		      __log('entry already listening');
		      __stage('ndr_done');
		      patchBodyShape(pickServerRef());
		      ensureConfigDefaults(pickServerRef());
		      try {
		        const srv = pickServerRef();
		        if (srv && srv.db && typeof srv.db.push === 'function' && typeof srv.db.getData === 'function') {
		          const origPush = srv.db.push.bind(srv.db);
		          srv.db.push = async (...args) => {
		            try {
		              const p = args[0];
		              const v = args[1];
		              if (typeof p === 'string') {
		                if (/^\\/uc\\/[0-9a-f]{32}$/i.test(p) && typeof v === 'string' && v === '') {
		                  try {
		                    const cur = await srv.db.getData(p);
		                    if (typeof cur === 'string' && cur.trim()) return cur;
		                  } catch (_) {}
		                }
		                if (p === '/uc' && v && typeof v === 'object' && !Array.isArray(v)) {
		                  let out = null;
		                  for (const k of Object.keys(v)) {
		                    if (!/^[0-9a-f]{32}$/i.test(k)) continue;
		                    const vv = v[k];
		                    if (typeof vv !== 'string' || vv !== '') continue;
		                    try {
		                      const cur = await srv.db.getData('/uc/' + k);
		                      if (typeof cur === 'string' && cur.trim()) {
		                        if (!out) out = Object.assign({}, v);
		                        out[k] = cur;
		                      }
		                    } catch (_) {}
		                  }
		                  if (out) args[1] = out;
		                }
		              }
		            } catch (_) {}
		            return origPush(...args);
		          };
		        }
		      } catch (_) {}
		      return;
		    }
		  } catch (_) {}

		  const { candidates, envName, addedFns } = resolveEntryCandidates();
		  if (candidates && candidates.length) {
			    __stage('ndr_found');
			    let baseCfg = { sites: { list: [] }, pans: { list: [] }, color: [] };
		    try {
		      __stage('ndr_call');
		      try {
		        baseCfg = await buildCompatStartConfig();
		        if (baseCfg && baseCfg.server && baseCfg.server.url) {
		          __log('entryFn_server_cfg', baseCfg.server.url);
		        }
		      } catch (_) {}
		      let started = false;
		      let lastErr = null;
			      for (const c of candidates.slice(0, 12)) {
			        try {
			          __log('entryFn_try', c.name, 'via', c.via);
			          try { globalThis.__catpaw_online_listen_port = 0; } catch (_) {}
			          patchBodyShape(pickServerRef());
			          await c.fn(baseCfg);
			          const ok = await waitForListening(7000);
			          if (ok) {
		            __log('entryFn_ok', c.name, 'via', c.via);
		            started = true;
		            break;
		          }
		          __log('entryFn_no_listen', c.name);
		        } catch (e) {
		          lastErr = e;
		          __log('entryFn_failed', c.name, e && e.message ? String(e.message) : String(e));
		        }
		      }
		      if (!started) {
		        const detail = addedFns && addedFns.length ? 'addedFns=' + JSON.stringify(addedFns.slice(0, 50)) : 'addedFns=[]';
		        const hint = envName ? " (ONLINE_ENTRY_FN='" + envName + "')" : '';
		        const msg = 'no entry function could start listening' + hint + ' ' + detail;
		        const err = lastErr instanceof Error ? lastErr : new Error(msg);
		        if (!err.message || err.message === String(lastErr || '')) err.message = msg;
		        throw err;
		      }
		      __stage('ndr_done');
		    } finally {
		    }
		    patchBodyShape(pickServerRef());
		    ensureConfigDefaults(pickServerRef());
	    // Guard against accidental credential wipe:
	    // Some bundled scripts may push('/uc/<hash>', '') during unrelated flows (e.g. category probe),
	    // which overwrites a previously saved UC cookie with empty string.
	    try {
	      const srv = pickServerRef();

	      if (srv && srv.db && typeof srv.db.push === 'function' && typeof srv.db.getData === 'function') {
	        const origPush = srv.db.push.bind(srv.db);
	        srv.db.push = async (...args) => {
	          try {
	            const p = args[0];
	            const v = args[1];
	            if (typeof p === 'string') {
	              // 1) Prevent overwriting "/uc/<md5>" with empty string if there is already a non-empty value.
	              if (/^\\/uc\\/[0-9a-f]{32}$/i.test(p) && typeof v === 'string' && v === '') {
	                try {
	                  const cur = await srv.db.getData(p);
	                  if (typeof cur === 'string' && cur.trim()) return cur;
	                } catch (_) {}
	              }

	              // 2) If a script writes the whole "/uc" object, keep existing non-empty md5 keys.
	              if (p === '/uc' && v && typeof v === 'object' && !Array.isArray(v)) {
	                let out = null;
	                for (const k of Object.keys(v)) {
	                  if (!/^[0-9a-f]{32}$/i.test(k)) continue;
	                  const vv = v[k];
	                  if (typeof vv !== 'string' || vv !== '') continue;
	                  try {
	                    const cur = await srv.db.getData('/uc/' + k);
	                    if (typeof cur === 'string' && cur.trim()) {
	                      if (!out) out = Object.assign({}, v);
	                      out[k] = cur;
	                    }
	                  } catch (_) {}
	                }
	                if (out) args[1] = out;
	              }
	            }
	          } catch (_) {}
	          return origPush(...args);
	        };
	      }
	    } catch (_) {}

	    return;
	  }
	  __log('entry start function not found');
	  throw new Error('entry start function not found');
	})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
	`.trim();

    // `pkg` executables don't reliably support `-e/--eval` for running an inline script.
    // Write a small bootstrap file to the online directory and execute it.
    // Keep bootstrap out of the script directory so it won't be mistaken as an online entry.
    const bootstrapPath = path.resolve(onlineDir, '.catpaw_online_runtime_bootstrap.cjs');
    try {
        if (!fs.existsSync(onlineDir)) fs.mkdirSync(onlineDir, { recursive: true });
        fs.writeFileSync(bootstrapPath, `${bootstrap}\n`, 'utf8');
    } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        throw new Error(`write bootstrap failed: ${msg}`);
    }

				    // In pkg builds, keep the online runtime quiet by default to avoid excessive IO.
				    // Enable child stdout/stderr by setting `CATPAW_DEBUG=1`.
				    const wantDebug = String(process.env.CATPAW_DEBUG || '').trim() === '1';
			    const hasDevLogFile =
			        !isPkg && typeof process.env.CATPAW_LOG_FILE === 'string' && process.env.CATPAW_LOG_FILE.trim();
    // Keep stdin as a pipe so the child can detect parent exit via stdin close (see bootstrap above),
    // and open an IPC channel so we can confirm "listening" (and detect EADDRINUSE) reliably.
	    const stdio = isPkg
	        ? wantDebug
	            ? ['pipe', 'pipe', 'pipe', 'ipc']
	            : ['pipe', 'ignore', 'ignore', 'ipc']
        : hasDevLogFile
          ? ['pipe', 'pipe', 'pipe', 'ipc']
          : ['pipe', 'inherit', 'inherit', 'ipc'];

	    const waitForReady = (childProc, expectedPort) =>
	        new Promise((resolve) => {
	            let done = false;
	            let lastStage = '';
	            let lastFatal = null;
	            const withMeta = (v) => {
	                try {
	                    const out = v && typeof v === 'object' ? { ...v } : v;
	                    if (out && typeof out === 'object') {
	                        if (lastStage && !out.lastStage) out.lastStage = lastStage;
	                        if (lastFatal && !out.fatal) out.fatal = lastFatal;
	                    }
	                    return out;
	                } catch (_) {
	                    return v;
	                }
	            };
	            const finish = (v) => {
	                if (done) return;
	                done = true;
	                try {
	                    clearTimeout(timer);
	                } catch (_) {}
	                try {
	                    clearInterval(pollTimer);
	                } catch (_) {}
		                try {
		                    childProc.off('exit', onExit);
		                } catch (_) {}
		                try {
		                    childProc.off('error', onErr);
		                } catch (_) {}
		                try {
		                    childProc.off('message', onMsg);
		                } catch (_) {}
	                resolve(withMeta(v));
	            };
		            const onExit = (code, signal) => finish({ ok: false, code, signal, port: expectedPort });
		            const onErr = (err) => {
		                try {
		                    finish({
		                        ok: false,
		                        spawnError: {
		                            message: err && err.message ? String(err.message) : String(err),
		                            code: err && err.code ? String(err.code) : '',
		                        },
		                        port: expectedPort,
		                    });
		                } catch (_) {
		                    finish({ ok: false, port: expectedPort });
		                }
		            };
	            const onMsg = (msg) => {
	                if (!msg || typeof msg !== 'object') return;
	                if (msg.type === 'stage') {
	                    const st = typeof msg.stage === 'string' ? msg.stage.trim() : '';
	                    if (st) lastStage = st;
	                    return;
	                }
	                if (msg.type === 'fatal') {
	                    lastFatal = msg;
	                    return;
	                }
	                if (msg.type === 'listening') {
	                    const lp = Number.isFinite(Number(msg.port)) ? Math.max(1, Math.trunc(Number(msg.port))) : expectedPort;
	                    finish({ ok: true, port: lp });
	                    return;
	                }
	                if (msg.type === 'listen_error') {
	                    const code = typeof msg.code === 'string' ? msg.code.trim() : '';
	                    finish({ ok: false, listenError: { code, message: msg.message || '' }, port: expectedPort });
	                }
	            };

		            // Fallback readiness probe (for some pkg/Linux builds where IPC messages may not arrive reliably):
		            // poll any HTTP response on the expected port (even 404).
		            const probeOnce = () =>
		                new Promise((r) => {
		                    try {
		                        const req = http.request(
		                            { method: 'HEAD', hostname: '127.0.0.1', port: expectedPort, path: '/', timeout: 700 },
		                            (res) => {
		                                try {
		                                    const st = res ? Number(res.statusCode || 0) : 0;
		                                    res.resume();
		                                    r(st >= 100);
		                                } catch (_) {
		                                    r(false);
		                                }
		                            }
		                        );
	                        req.on('timeout', () => {
	                            try {
	                                req.destroy(new Error('timeout'));
	                            } catch (_) {}
	                            r(false);
	                        });
	                        req.on('error', () => r(false));
	                        req.end();
	                    } catch (_) {
	                        r(false);
	                    }
	                });

	            const pollTimer = setInterval(async () => {
	                try {
	                    if (done) return;
	                    const ok = await probeOnce();
	                    if (ok) finish({ ok: true, port: expectedPort, via: 'http_probe' });
	                } catch (_) {}
	            }, 250);

		            childProc.on('exit', onExit);
		            childProc.on('error', onErr);
		            childProc.on('message', onMsg);
		            const timeoutMsRaw = String(process.env.CATPAW_ONLINE_READY_TIMEOUT_MS || '').trim();
		            const timeoutMs = timeoutMsRaw ? Math.max(500, Math.trunc(Number(timeoutMsRaw))) : 30000;
		            const timer = setTimeout(() => finish({ ok: false, timeout: true, port: expectedPort }), timeoutMs);
		        });

		    const onlineLogPath = wantDebug ? path.resolve(rootDir, `online-runtime.${key}.log`) : '';
		    let chosenPort = p;
            let lastFailureReason = '';
            let lastFailureStage = '';

				    for (let attempt = 0; attempt < 6; attempt += 1) {
				        const baseEnv = { ...process.env };
				        const panMockCfg = readPanMockConfigFromRuntimeRoot(rootDir);
                        const proxyCfg = readProxyConfigFromRuntimeRoot(rootDir);
                        const packetCaptureCfg = readPacketCaptureConfigFromRuntimeRoot(rootDir);
				        const resolvedEntryFn = typeof entryFn === 'string' ? entryFn.trim() : '';
				        const child = spawn(process.execPath, [bootstrapPath], {
				            stdio,
				            cwd: rootDir,
				            env: {
			                ...baseEnv,
			                DEV_HTTP_PORT: String(chosenPort),
			                PORT: String(chosenPort),
			                HTTP_PORT: String(chosenPort),
			                ONLINE_ID: String(key),
			                ONLINE_ENTRY: entry,
			                ONLINE_ENTRY_FN: resolvedEntryFn,
			                ONLINE_CWD: rootDir,
				                CATPAW_DEBUG_LOG: onlineLogPath,
                                CATPAW_PROXY: typeof proxyCfg.proxy === 'string' ? proxyCfg.proxy : '',
                                CATPAW_SITE_PROXY: (() => {
                                    try {
                                        return JSON.stringify(proxyCfg.siteProxy || {});
                                    } catch (_) {
                                        return '{}';
                                    }
                                })(),
                                CATPAW_PACKET_CAPTURE: packetCaptureCfg && packetCaptureCfg.enabled ? '1' : '0',
                                CATPAW_PACKET_CAPTURE_BODY_LIMIT: String(
                                    packetCaptureCfg && Number.isFinite(Number(packetCaptureCfg.bodyLimit))
                                        ? Math.max(0, Math.trunc(Number(packetCaptureCfg.bodyLimit)))
                                        : DEFAULT_PACKET_CAPTURE_BODY_LIMIT
                                ),
                                CATPAW_PACKET_CAPTURE_DIR:
                                    packetCaptureCfg && typeof packetCaptureCfg.dir === 'string' ? packetCaptureCfg.dir : '',
				                NODE_PATH: rootDir,
				            },
				        });
				        children.set(key, { child, entry, port: chosenPort });
				        // Push initial mock config (can be toggled later without restarting via IPC).
				        sendMockConfigToChild(child, panMockCfg);
                        sendProxyConfigToChild(child, proxyCfg);
                        sendPacketCaptureConfigToChild(child, packetCaptureCfg);

	    // When debugging online runtimes, capture child output:
	    // - dev: if CATPAW_LOG_FILE is set, forward to parent stdout/stderr (which are already redirected to file in dev.js)
		    // - pkg: if CATPAW_DEBUG=1, also write to `online-runtime.<id>.log` under runtime root.
		    let onlineLogStream = null;
		    if (wantDebug && onlineLogPath) {
		        try {
		            onlineLogStream = fs.createWriteStream(onlineLogPath, { flags: 'a' });
		            onlineLogStream.on('error', () => {});
	            onlineLogStream.write(
	                `\n${logPrefix} ---- spawn id=${key} pid=${child.pid || 0} entry=${path.basename(entry)} port=${chosenPort} at=${new Date().toISOString()} ----\n`
	            );
	        } catch (_) {
	            onlineLogStream = null;
	        }
	    }

	    const forwardChunk = (target, chunk) => {
	        try {
	            if (chunk == null) return;
	            if (onlineLogStream) onlineLogStream.write(chunk);
	        } catch (_) {}
	        try {
	            if (target && typeof target.write === 'function') target.write(chunk);
	        } catch (_) {}
	    };

		    if (!isPkg && child && (child.stdout || child.stderr) && typeof process.env.CATPAW_LOG_FILE === 'string' && process.env.CATPAW_LOG_FILE.trim()) {
		        try {
		            if (child.stdout) child.stdout.on('data', (d) => forwardChunk(process.stdout, d));
		        } catch (_) {}
		        try {
		            if (child.stderr) child.stderr.on('data', (d) => forwardChunk(process.stderr, d));
		        } catch (_) {}
		    }
		    if (isPkg && wantDebug && child && (child.stdout || child.stderr)) {
		        try {
		            if (child.stdout) child.stdout.on('data', (d) => forwardChunk(process.stdout, d));
		        } catch (_) {}
		        try {
		            if (child.stderr) child.stderr.on('data', (d) => forwardChunk(process.stderr, d));
		        } catch (_) {}
		    }

		    try {
		        // eslint-disable-next-line no-console
		        console.log(`${logPrefix} runtime spawning: id=${key} entry=${path.basename(entry)} port=${chosenPort}`);
		        if (isPkg && wantDebug && onlineLogPath) {
		            // eslint-disable-next-line no-console
		            console.log(`${logPrefix} debug enabled: id=${key} log=${onlineLogPath}`);
		        }
		    } catch (_) {}

	    child.on('exit', (code, signal) => {
	        try {
	            if (onlineLogStream) {
	                onlineLogStream.write(
	                    `\n${logPrefix} ---- exit id=${key} pid=${child.pid || 0} code=${code} signal=${signal || ''} at=${new Date().toISOString()} ----\n`
	                );
	            }
	        } catch (_) {}
	        try {
	            if (onlineLogStream) onlineLogStream.end();
	        } catch (_) {}
	        onlineLogStream = null;
	        const cur = children.get(key);
	        if (cur && cur.child && cur.child.pid) {
	            try {
	                // eslint-disable-next-line no-console
                console.log(`${logPrefix} runtime exited: id=${key} pid=${cur.child.pid} code=${code} signal=${signal || ''}`);
            } catch (_) {}
        }
        const latest = children.get(key);
        if (latest && latest.child === child) children.delete(key);
    });

	        const ready = await waitForReady(child, chosenPort);
	        if (ready && ready.ok) {
	            const cur = children.get(key);
	            if (cur && cur.child === child) cur.port = ready.port;
            try {
                // eslint-disable-next-line no-console
                console.log(`${logPrefix} runtime ready: id=${key} entry=${path.basename(entry)} port=${ready.port}`);
            } catch (_) {}
	            return { started: true, port: ready.port, entry, reused: false, id: key };
	        }

		        try {
		            const reason =
		                ready && ready.spawnError && ready.spawnError.code
		                    ? `spawn_error:${String(ready.spawnError.code)}`
		                    : ready && ready.spawnError && ready.spawnError.message
		                      ? 'spawn_error'
		                      :
		                ready && ready.listenError && ready.listenError.code
		                    ? `listen_error:${String(ready.listenError.code)}`
		                    : ready && ready.timeout
		                      ? 'timeout'
		                      : ready && typeof ready.code === 'number'
		                        ? `exit:${String(ready.code)}`
		                        : ready && ready.signal
		                          ? `signal:${String(ready.signal)}`
		                        : 'unknown';
                    lastFailureReason = reason;
                    lastFailureStage = ready && ready.lastStage ? String(ready.lastStage) : '';
	            // eslint-disable-next-line no-console
	            console.error(
	                `${logPrefix} runtime not ready: id=${key} entry=${path.basename(entry)} port=${chosenPort} reason=${reason}` +
	                    (ready && ready.lastStage ? ` lastStage=${String(ready.lastStage)}` : '')
	            );
		            if (ready && ready.listenError && ready.listenError.message) {
		                // eslint-disable-next-line no-console
		                console.error(`${logPrefix} runtime listen_error: ${String(ready.listenError.message).slice(0, 600)}`);
		            }
		            if (ready && ready.spawnError && ready.spawnError.message) {
		                // eslint-disable-next-line no-console
		                console.error(`${logPrefix} runtime spawn_error: ${String(ready.spawnError.message).slice(0, 600)}`);
		            }
		            if (ready && ready.fatal && ready.fatal.message) {
		                // eslint-disable-next-line no-console
		                console.error(`${logPrefix} runtime fatal: ${String(ready.fatal.kind || 'fatal')} ${String(ready.fatal.message).slice(0, 600)}`);
		            }
		            if (isPkg && wantDebug && onlineLogPath) {
		                // eslint-disable-next-line no-console
		                console.error(`${logPrefix} check child log: ${onlineLogPath}`);
		            }
	        } catch (_) {}

	        // If failed, clean up.
	        try {
	            if (child && !child.killed) child.kill();
	        } catch (_) {}

        const cur = children.get(key);
        if (cur && cur.child === child) children.delete(key);

        const code = ready && ready.listenError && ready.listenError.code ? String(ready.listenError.code) : '';
        const signal = ready && ready.signal ? String(ready.signal) : '';
        const canRetryTransient = code === 'EADDRINUSE' || signal === 'SIGTERM';
        if (canRetryTransient && attempt < 5) {
            // Retry transient startup interruptions:
            // - EADDRINUSE: pick another port
            // - SIGTERM: startup was interrupted by external lifecycle events
            try {
                // eslint-disable-next-line no-console
                console.warn(
                    `${logPrefix} runtime retry: id=${key} entry=${path.basename(entry)} reason=${code || signal || 'transient'} attempt=${attempt + 1}`
                );
            } catch (_) {}
            // eslint-disable-next-line no-await-in-loop
            chosenPort = await findAvailablePortInRange(30000, 39999);
            continue;
        }

        return {
            started: false,
            port: 0,
            entry: '',
            id: key,
            reason: lastFailureReason || 'runtime_not_ready',
            lastStage: lastFailureStage || '',
        };
    }

    return {
        started: false,
        port: 0,
        entry: '',
        id: key,
        reason: lastFailureReason || 'runtime_not_ready',
        lastStage: lastFailureStage || '',
    };
    })();

    starting.set(key, startPromise);
    try {
        return await startPromise;
    } finally {
        starting.delete(key);
    }
}

export function stopOnlineRuntime(id = 'default') {
    const key = typeof id === 'string' && id.trim() ? id.trim() : 'default';
    const cur = children.get(key);
    if (!cur || !cur.child || cur.child.killed) return false;
    try {
        cur.child.kill();
        return true;
    } catch (_) {
        return false;
    } finally {
        children.delete(key);
    }
}

export function stopAllOnlineRuntimes() {
    const keys = Array.from(children.keys());
    keys.forEach((k) => {
        try {
            stopOnlineRuntime(k);
        } catch (_) {}
    });
    return true;
}

export async function withOnlineRuntimeOpsLock(task) {
    const fn = typeof task === 'function' ? task : async () => null;
    const run = runtimeOpsQueue.then(() => fn());
    // Keep queue alive even if a task fails.
    runtimeOpsQueue = run.catch(() => {});
    return run;
}

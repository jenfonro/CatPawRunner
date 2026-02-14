// Quark API plugin.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

const QUARK_REFERER = 'https://pan.quark.cn';
const PAN_DEBUG = process.env.PAN_DEBUG === '1';

// QuarkTV (open-api-drive) config: ported from OpenList `drivers/quark_uc_tv`.
const QUARK_TV_API = 'https://open-api-drive.quark.cn';
const QUARK_TV_CODE_API = 'http://api.extscreen.com/quarkdrive';
const QUARK_TV_CLIENT_ID = 'd3194e61504e493eb6222857bccfed94';
const QUARK_TV_SIGN_KEY = 'kw2dvtd7p4t3pjl2d9ed9yc8yej8kw2d';
const QUARK_TV_APP_VER = '1.8.2.2';
const QUARK_TV_CHANNEL = 'GENERAL';
const QUARK_TV_UA =
  'Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1';
const QUARK_TV_DEVICE_BRAND = 'Xiaomi';
const QUARK_TV_PLATFORM = 'tv';
const QUARK_TV_DEVICE_NAME = 'M2004J7AC';
const QUARK_TV_DEVICE_MODEL = 'M2004J7AC';
const QUARK_TV_BUILD_DEVICE = 'M2004J7AC';
const QUARK_TV_BUILD_PRODUCT = 'M2004J7AC';
const QUARK_TV_DEVICE_GPU = 'Adreno (TM) 550';
const QUARK_TV_ACTIVITY_RECT = '{}';
const QUARK_TV_TOKEN_SKEW_MS = 60_000;
const QUARK_TV_TOKEN_REFRESH_DEADLINE_MS = 10_000;
let quarkTvRefreshInFlight = null;

function panLog(...args) {
  if (!PAN_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[pan]', ...args);
}

function maskForLog(value, head = 6, tail = 4) {
  const s = String(value == null ? '' : value);
  if (!s) return '';
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

// 1-minute in-memory cache for `/api/quark/play` resolved URLs.
// Rationale: Quark clear/save/list is async/eventually-consistent; recently resolved direct URLs can remain valid
// even if the transferred file is deleted shortly after.
const QUARK_PLAY_URL_CACHE_TTL_MS = 60_000;
const quarkPlayUrlCache = new Map(); // key -> { exp, value }

function getQuarkPlayUrlCache(key) {
  const k = String(key || '');
  const hit = quarkPlayUrlCache.get(k);
  if (!hit) return null;
  if (Date.now() >= hit.exp) {
    quarkPlayUrlCache.delete(k);
    return null;
  }
  return hit.value || null;
}

function setQuarkPlayUrlCache(key, value) {
  const k = String(key || '');
  if (!k) return;
  quarkPlayUrlCache.set(k, { exp: Date.now() + QUARK_PLAY_URL_CACHE_TTL_MS, value });
  // Best-effort cleanup to avoid unbounded growth.
  if (quarkPlayUrlCache.size > 2000) {
    const now = Date.now();
    for (const [ck, cv] of quarkPlayUrlCache.entries()) {
      if (!cv || now >= cv.exp) quarkPlayUrlCache.delete(ck);
    }
    while (quarkPlayUrlCache.size > 2000) {
      const firstKey = quarkPlayUrlCache.keys().next().value;
      if (!firstKey) break;
      quarkPlayUrlCache.delete(firstKey);
    }
  }
}

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input == null ? '' : input)).digest('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input)).digest('hex');
}

function quarkTvGenerateReqSign(method, pathname, deviceId) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '').trim() || '/';
  const timestamp = String(Date.now());
  const dev = String(deviceId || '').trim();
  const reqId = md5Hex(`${dev}${timestamp}`);
  const tokenData = `${m}&${p}&${timestamp}&${QUARK_TV_SIGN_KEY}`;
  const xPanToken = sha256Hex(tokenData);
  return { tm: timestamp, xPanToken, reqId };
}

function isQuarkTvAccessTokenInvalid(resp, msg) {
  try {
    const r = resp && typeof resp === 'object' ? resp : null;
    const status = r && Object.prototype.hasOwnProperty.call(r, 'status') ? Number(r.status) : NaN;
    const errno = r && Object.prototype.hasOwnProperty.call(r, 'errno') ? Number(r.errno) : NaN;
    if (status === -1 && errno === 10001) return true;
  } catch {}
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  return m.includes('access token') || m.includes('access_token') || m.includes('token无效') || m.includes('token 无效');
}

async function fetchQuarkTvJson(urlStr, init) {
  const res = await fetch(urlStr, { redirect: 'manual', ...init });
  const text = await res.text();
  let data;
  try {
    data = text && text.trim() ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.error_info || data.message || data.msg)) || text || `status=${res.status}`;
    const err = new Error(`quark_tv http ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  if (data && typeof data === 'object') {
    const status = Object.prototype.hasOwnProperty.call(data, 'status') ? Number(data.status) : NaN;
    const errno = Object.prototype.hasOwnProperty.call(data, 'errno') ? Number(data.errno) : 0;
    const errInfo =
      (Object.prototype.hasOwnProperty.call(data, 'error_info') ? data.error_info : '') ||
      (Object.prototype.hasOwnProperty.call(data, 'message') ? data.message : '') ||
      '';
    if ((Number.isFinite(status) && status >= 400) || (Number.isFinite(errno) && errno !== 0)) {
      const err = new Error(`quark_tv api errno=${Number.isFinite(errno) ? errno : String(data.errno)}: ${String(errInfo || 'request failed').slice(0, 300)}`);
      err.body = data;
      err.errno = errno;
      err.statusCode = status;
      throw err;
    }
  }
  return data;
}

async function quarkTvRefreshAccessToken({ rootDir, refreshToken, deviceId }) {
  const rt = String(refreshToken || '').trim();
  const dev = String(deviceId || '').trim();
  if (!rt) throw new Error('missing quark_tv refresh_token');
  if (!dev) throw new Error('missing quark_tv device_id');

  const { reqId } = quarkTvGenerateReqSign('POST', '/token', dev);
  const url = `${QUARK_TV_CODE_API}/token`;
  const body = {
    req_id: reqId,
    app_ver: QUARK_TV_APP_VER,
    device_id: dev,
    device_brand: QUARK_TV_DEVICE_BRAND,
    platform: QUARK_TV_PLATFORM,
    device_name: QUARK_TV_DEVICE_NAME,
    device_model: QUARK_TV_DEVICE_MODEL,
    build_device: QUARK_TV_BUILD_DEVICE,
    build_product: QUARK_TV_BUILD_PRODUCT,
    device_gpu: QUARK_TV_DEVICE_GPU,
    activity_rect: QUARK_TV_ACTIVITY_RECT,
    channel: QUARK_TV_CHANNEL,
    refresh_token: rt,
  };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = setTimeout(() => {
    try {
      if (ctrl) ctrl.abort(new Error('timeout'));
    } catch {}
  }, QUARK_TV_TOKEN_REFRESH_DEADLINE_MS);
  let resp;
  try {
    resp = await fetchQuarkTvJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
  } finally {
    clearTimeout(t);
  }

  const code = resp && typeof resp === 'object' && 'code' in resp ? Number(resp.code) : NaN;
  if (code !== 200) {
    const msg = (resp && typeof resp === 'object' && (resp.message || resp.msg)) || 'refresh failed';
    const err = new Error(`quark_tv refresh failed: ${String(msg).slice(0, 300)}`);
    err.body = resp;
    throw err;
  }
  const data = resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' ? resp.data : null;
  const accessToken = data && typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const nextRefresh = data && typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  const expiresIn = data && Number.isFinite(Number(data.expires_in)) ? Math.trunc(Number(data.expires_in)) : 0;
  if (!accessToken) throw new Error('quark_tv refresh failed: empty access_token');

  const expAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
  try {
    saveQuarkTvAccountToConfig(rootDir, {
      refreshToken: nextRefresh || rt,
      deviceId: dev,
      accessToken,
      accessTokenExpAt: expAt,
    });
  } catch (e) {
    panLog('quark_tv token save failed', (e && e.message) || String(e));
  }

  return { accessToken, refreshToken: nextRefresh || rt, expiresIn, expAt };
}

async function ensureQuarkTvAccessToken({ rootDir, account }) {
  const root = rootDir ? String(rootDir) : resolveRuntimeRootDir();
  const a = account && typeof account === 'object' ? account : {};
  const refreshToken = String(a.refreshToken || '').trim();
  const deviceId = String(a.deviceId || '').trim();
  const accessToken = String(a.accessToken || '').trim();
  const expAt = Number.isFinite(Number(a.accessTokenExpAt)) ? Math.trunc(Number(a.accessTokenExpAt)) : 0;

  const needRefresh =
    !accessToken ||
    (expAt > 0 && Date.now() + QUARK_TV_TOKEN_SKEW_MS >= expAt);

  if (!needRefresh) return { accessToken, refreshToken, deviceId, expAt };

  if (!quarkTvRefreshInFlight) {
    quarkTvRefreshInFlight = (async () => {
      try {
        return await quarkTvRefreshAccessToken({ rootDir: root, refreshToken, deviceId });
      } finally {
        quarkTvRefreshInFlight = null;
      }
    })();
  }
  const out = await quarkTvRefreshInFlight;
  return { accessToken: out.accessToken, refreshToken: out.refreshToken, deviceId, expAt: out.expAt };
}

async function quarkTvLinkByFid({ fid, root, rootDir, method }) {
  const fId = String(fid || '').trim();
  if (!fId) throw new Error('missing fid');
  const runtimeRoot = rootDir ? String(rootDir) : resolveRuntimeRootDir();
  const account = getQuarkTvAccountFromDbRoot(root);
  if (!account || !account.refreshToken || !account.deviceId) throw new Error('missing quark_tv credentials (account.quark_tv.refresh_token + device_id)');

  let tokens = await ensureQuarkTvAccessToken({ rootDir: runtimeRoot, account });
  const m = String(method || 'streaming').trim().toLowerCase();
  const apiMethod = m === 'download' ? 'download' : 'streaming';

  const callOnce = async () => {
    const { tm, xPanToken, reqId } = quarkTvGenerateReqSign('GET', '/file', tokens.deviceId);
    const u = new URL(`${QUARK_TV_API}/file`);
    const base = {
      req_id: reqId,
      access_token: tokens.accessToken,
      app_ver: QUARK_TV_APP_VER,
      device_id: tokens.deviceId,
      device_brand: QUARK_TV_DEVICE_BRAND,
      platform: QUARK_TV_PLATFORM,
      device_name: QUARK_TV_DEVICE_NAME,
      device_model: QUARK_TV_DEVICE_MODEL,
      build_device: QUARK_TV_BUILD_DEVICE,
      build_product: QUARK_TV_BUILD_PRODUCT,
      device_gpu: QUARK_TV_DEVICE_GPU,
      activity_rect: QUARK_TV_ACTIVITY_RECT,
      channel: QUARK_TV_CHANNEL,
      method: apiMethod,
      group_by: 'source',
      fid: fId,
      resolution: 'low,normal,high,super,2k,4k',
      support: 'dolby_vision',
    };
    for (const [k, v] of Object.entries(base)) u.searchParams.set(k, String(v));

    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': QUARK_TV_UA,
      'x-pan-tm': tm,
      'x-pan-token': xPanToken,
      'x-pan-client-id': QUARK_TV_CLIENT_ID,
    };
    return await fetchQuarkTvJson(u.toString(), { method: 'GET', headers });
  };

  try {
    const resp = await callOnce();
    const data = resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' ? resp.data : null;
    let url = '';
    if (apiMethod === 'download') {
      url = data && typeof data.download_url === 'string' ? data.download_url.trim() : '';
      if (!url) throw new Error('quark_tv download_url not found');
    } else {
      const list = data && Array.isArray(data.video_info) ? data.video_info : [];
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const u = typeof it.url === 'string' ? it.url.trim() : '';
        if (u) {
          url = u;
          break;
        }
      }
      if (!url) throw new Error('quark_tv streaming url not found');
    }
    return { url, raw: resp, method: apiMethod };
  } catch (e) {
    const body = e && e.body ? e.body : null;
    const msg = (e && e.message) || String(e);
    if (!isQuarkTvAccessTokenInvalid(body, msg)) throw e;
    const refreshed = await quarkTvRefreshAccessToken({
      rootDir: runtimeRoot,
      refreshToken: account.refreshToken,
      deviceId: account.deviceId,
    });
    tokens = { ...tokens, accessToken: refreshed.accessToken };
    const resp2 = await callOnce();
    const data2 = resp2 && typeof resp2 === 'object' && resp2.data && typeof resp2.data === 'object' ? resp2.data : null;
    let url2 = '';
    if (apiMethod === 'download') {
      url2 = data2 && typeof data2.download_url === 'string' ? data2.download_url.trim() : '';
      if (!url2) throw new Error('quark_tv download_url not found');
    } else {
      const list2 = data2 && Array.isArray(data2.video_info) ? data2.video_info : [];
      for (const it of list2) {
        if (!it || typeof it !== 'object') continue;
        const u = typeof it.url === 'string' ? it.url.trim() : '';
        if (u) {
          url2 = u;
          break;
        }
      }
      if (!url2) throw new Error('quark_tv streaming url not found');
    }
    return { url: url2, raw: resp2, method: apiMethod };
  }
}

async function readDbRoot() {
  try {
    const rootDir = resolveRuntimeRootDir();
    const cfgPath = path.resolve(rootDir, 'config.json');
    return readJsonFileSafe(cfgPath);
  } catch {
    return {};
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

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw && raw.trim() ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
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

function getQuarkCookieFromDbRoot(root) {
  try {
    const account =
      root && typeof root === 'object' && root.account && typeof root.account === 'object' && !Array.isArray(root.account)
        ? root.account
        : null;
    const q = account ? account.quark : null;
    if (typeof q === 'string') return q.trim();
    if (!q || typeof q !== 'object' || Array.isArray(q)) return '';
    return typeof q.cookie === 'string' ? q.cookie.trim() : '';
  } catch {}
  return '';
}

function getQuarkTvAccountFromDbRoot(root) {
  try {
    const account =
      root && typeof root === 'object' && root.account && typeof root.account === 'object' && !Array.isArray(root.account)
        ? root.account
        : null;
    const q = account ? account.quark_tv : null;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return { refreshToken: '', deviceId: '', accessToken: '', accessTokenExpAt: 0 };
    const refreshToken = typeof q.refresh_token === 'string' ? q.refresh_token.trim() : typeof q.refreshToken === 'string' ? q.refreshToken.trim() : '';
    const deviceId = typeof q.device_id === 'string' ? q.device_id.trim() : typeof q.deviceId === 'string' ? q.deviceId.trim() : '';
    const accessToken = typeof q.access_token === 'string' ? q.access_token.trim() : typeof q.accessToken === 'string' ? q.accessToken.trim() : '';
    const accessTokenExpAt = Number.isFinite(Number(q.access_token_exp_at))
      ? Math.trunc(Number(q.access_token_exp_at))
      : Number.isFinite(Number(q.accessTokenExpAt))
        ? Math.trunc(Number(q.accessTokenExpAt))
        : 0;
    return { refreshToken, deviceId, accessToken, accessTokenExpAt };
  } catch {}
  return { refreshToken: '', deviceId: '', accessToken: '', accessTokenExpAt: 0 };
}

function saveQuarkTvAccountToConfig(rootDir, patch) {
  const root = rootDir ? String(rootDir) : '';
  const p = patch && typeof patch === 'object' && patch ? patch : {};
  if (!root) throw new Error('invalid runtime root');

  const cfgPath = path.resolve(root, 'config.json');
  const cfgRoot = readJsonFileSafe(cfgPath) || {};
  const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

  const account =
    next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
  const prev =
    account.quark_tv && typeof account.quark_tv === 'object' && account.quark_tv && !Array.isArray(account.quark_tv)
      ? { ...account.quark_tv }
      : {};

  if (typeof p.refreshToken === 'string' && p.refreshToken.trim()) prev.refresh_token = p.refreshToken.trim();
  if (typeof p.deviceId === 'string' && p.deviceId.trim()) prev.device_id = p.deviceId.trim();
  if (typeof p.accessToken === 'string') prev.access_token = p.accessToken.trim();
  if (Number.isFinite(Number(p.accessTokenExpAt)) && Number(p.accessTokenExpAt) > 0) prev.access_token_exp_at = Math.trunc(Number(p.accessTokenExpAt));

  account.quark_tv = prev;
  next.account = account;

  writeJsonFileAtomic(cfgPath, next);
  return { cfgPath, saved: true };
}

function parseQuarkProxyDownUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return null;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const downIdx = parts.indexOf('down');
  if (downIdx < 0 || downIdx + 2 >= parts.length) return null;
  const shareId = parts[downIdx + 1] || '';
  const enc = parts[downIdx + 2] || '';
  if (!shareId || !enc) return null;
  let decoded = enc;
  try {
    decoded = decodeURIComponent(enc);
  } catch {}
  const segs = decoded.split('*');
  const stoken = segs[0] || '';
  const fid = segs[1] || '';
  const fidToken = segs[2] || '';
  if (!stoken || !fid || !fidToken) return null;
  return { shareId, stoken, fid, fidToken };
}

function parseQuarkPlayId(idStr) {
  const raw = String(idStr || '').trim();
  if (!raw) return null;
  // Format: shareId*stoken*fid*fidToken***filename
  let head = raw;
  let name = '';
  const nameIdx = raw.indexOf('***');
  if (nameIdx >= 0) {
    head = raw.slice(0, nameIdx);
    name = raw.slice(nameIdx + 3);
  }
  const parts = head.split('*');
  if (parts.length < 4) return null;
  const shareId = String(parts[0] || '').trim();
  const stoken = String(parts[1] || '').trim();
  const fid = String(parts[2] || '').trim();
  const fidToken = String(parts[3] || '').trim();
  if (!shareId || !stoken || !fid || !fidToken) return null;
  return { shareId, stoken, fid, fidToken, name: String(name || '').trim() };
}

function parseQuarkShareUrl(urlStr) {
  const raw = String(urlStr || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'pan.quark.cn' && !host.endsWith('.quark.cn')) return null;
  const m = u.pathname.match(/^\/s\/([^/?#]+)/);
  if (!m) return { shareId: '', url: raw };
  return { shareId: m[1], url: raw };
}

async function fetchJson(url, init) {
  const res = await fetch(url, { redirect: 'manual', ...init });
  const text = await res.text();
  let data;
  try {
    data = text && text.trim() ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || text || `status=${res.status}`;
    const err = new Error(`quark http ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 0) {
    throw new Error(`quark api code=${data.code} message=${String(data.message || '').slice(0, 300)}`);
  }
  return data;
}

function splitSetCookieHeader(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  // Split on commas that start a new cookie (best-effort; avoids splitting Expires=... which includes a comma).
  return s
    .split(/,(?=[^;]+?=)/g)
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function getSetCookiesFromHeaders(headers) {
  try {
    if (!headers) return [];
    if (typeof headers.getSetCookie === 'function') {
      const arr = headers.getSetCookie();
      return Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [];
    }
    if (typeof headers.get === 'function') {
      const raw = headers.get('set-cookie') || '';
      return splitSetCookieHeader(raw);
    }
  } catch {}
  return [];
}

function mergeCookieString(baseCookie, setCookies) {
  const base = String(baseCookie || '').trim();
  const out = new Map();
  if (base) {
    base
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach((p) => {
        const idx = p.indexOf('=');
        if (idx <= 0) return;
        const k = p.slice(0, idx).trim();
        const v = p.slice(idx + 1).trim();
        if (k) out.set(k, v);
      });
  }

  const list = Array.isArray(setCookies) ? setCookies : [];
  for (const sc of list) {
    const first = String(sc || '').split(';')[0] || '';
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const k = first.slice(0, idx).trim();
    const v = first.slice(idx + 1).trim();
    if (!k) continue;
    out.set(k, v);
  }

  return Array.from(out.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function tryGetStringArrayByPath(root, pathParts) {
  try {
    let cur = root;
    for (const p of pathParts) {
      if (!cur || typeof cur !== 'object') return [];
      cur = cur[p];
    }
    if (!Array.isArray(cur)) return [];
    return cur.map((x) => String(x || '').trim()).filter(Boolean);
  } catch {}
  return [];
}

async function fetchJsonDetailed(url, init) {
  const res = await fetch(url, { redirect: 'manual', ...init });
  const text = await res.text();
  let data;
  try {
    data = text && text.trim() ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || text || `status=${res.status}`;
    const err = new Error(`quark http ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 0) {
    throw new Error(`quark api code=${data.code} message=${String(data.message || '').slice(0, 300)}`);
  }
  const setCookies = getSetCookiesFromHeaders(res.headers);
  return { data, res, setCookies, text };
}

function buildQuarkHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: QUARK_REFERER,
    Referer: QUARK_REFERER,
    'User-Agent': QUARK_UA,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function collectFirstStringByKey(root, keyLower) {
  const queue = [root];
  const seen = new Set();
  let steps = 0;
  while (queue.length && steps < 5000) {
    steps += 1;
    const v = queue.shift();
    if (!v) continue;
    if (typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const it of v) queue.push(it);
      continue;
    }
    for (const [k, val] of Object.entries(v)) {
      if (String(k || '').toLowerCase() === keyLower && typeof val === 'string' && val.trim()) return val.trim();
      queue.push(val);
    }
  }
  return '';
}

async function quarkListDir({ pdirFid, cookie, size }) {
  const headers = buildQuarkHeaders(cookie);
  const fid = String(pdirFid == null ? '0' : pdirFid).trim() || '0';
  const sz = Number.isFinite(Number(size)) ? Math.max(1, Math.min(500, Number(size))) : 200;
  const url =
    `https://drive.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc` +
    `&pdir_fid=${encodeURIComponent(fid)}` +
    `&_fetch_total=1&_size=${encodeURIComponent(String(sz))}` +
    `&_sort=file_type:asc,file_name:asc`;
  return await fetchJson(url, { method: 'GET', headers });
}

function sanitizeQuarkFolderName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '.' || raw === '..') return '';
  // Avoid path traversal / separators; keep unicode as-is for Quark folder names.
  const cleaned = raw.replace(/[\\/]+/g, '_').replace(/\0/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function getTvUserFromReq(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-tv-user'] || headers['X-TV-User'] || headers['x_tv_user'] || '';
  return sanitizeQuarkFolderName(raw);
}

function parseSubPathSegments(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\\/]+/g)
    .map((s) => sanitizeQuarkFolderName(s))
    .filter(Boolean);
  // Refuse suspicious paths.
  if (parts.some((p) => p === '.' || p === '..')) return [];
  return parts.slice(0, 20);
}

async function ensureFolderFid({ name, cookie, parentFid }) {
  const folderName = String(name || '').trim();
  if (!folderName) throw new Error('missing folder name');
  const parent = String(parentFid == null ? '0' : parentFid).trim() || '0';

  const headers = buildQuarkHeaders(cookie);
  const sortResp = await quarkListDir({ pdirFid: parent, cookie, size: 500 });
  const list =
    (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
    (sortResp && sortResp.list) ||
    [];
  if (Array.isArray(list)) {
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const isDir = it.dir === true || it.file_type === 0 || it.type === 'folder' || it.kind === 'folder';
      const nm = String(it.file_name || it.name || '').trim();
      if (!isDir) continue;
      if (nm === folderName) {
        const fid = String(it.fid || it.file_id || it.id || '').trim();
        if (fid) return fid;
      }
    }
  }

  // Create folder.
  const createUrl = `https://drive.quark.cn/1/clouddrive/file?pr=ucpro&fr=pc`;
  const body = { pdir_fid: parent, file_name: folderName, dir_path: '', dir_init_lock: false };
  const createResp = await fetchJson(createUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  const fid =
    String(
      (createResp && createResp.data && (createResp.data.fid || createResp.data.file_id || createResp.data.id)) ||
        ''
    ).trim();
  if (!fid) throw new Error('create folder: fid not found');
  return fid;
}

async function ensureUserDirFid({ req, cookie, subPath }) {
  const rootName = 'MeowFilm';
  const user = getTvUserFromReq(req);
  if (!user) throw new Error('missing X-TV-User');

  const rootFid = await ensureFolderFid({ name: rootName, cookie, parentFid: '0' });
  const userFid = await ensureFolderFid({ name: user, cookie, parentFid: rootFid });

  const segs = parseSubPathSegments(subPath);
  let cur = userFid;
  for (const seg of segs) {
    cur = await ensureFolderFid({ name: seg, cookie, parentFid: cur });
  }
  return { rootName, rootFid, user, userFid, fid: cur, subPath: segs.join('/') };
}

async function quarkDeleteFiles({ fids, cookie }) {
  const list = Array.isArray(fids) ? fids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return { ok: true, deleted: 0 };
  const headers = buildQuarkHeaders(cookie);
  const url = 'https://drive.quark.cn/1/clouddrive/file/delete?pr=ucpro&fr=pc';
  const body = { action_type: 2, filelist: list, exclude_fids: [] };
  const resp = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: true, deleted: list.length, resp };
}

async function quarkClearDir({ pdirFid, cookie }) {
  const fid = String(pdirFid == null ? '0' : pdirFid).trim() || '0';
  if (fid === '0') throw new Error('refuse to clear root (pdir_fid=0)');
  const sortResp = await quarkListDir({ pdirFid: fid, cookie, size: 500 });
  const list =
    (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
    (sortResp && sortResp.list) ||
    [];
  const fids = [];
  if (Array.isArray(list)) {
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const id = String(it.fid || it.file_id || it.id || '').trim();
      if (id && id !== '0') fids.push(id);
    }
  }
  if (!fids.length) return { ok: true, cleared: 0 };
  const del = await quarkDeleteFiles({ fids, cookie });
  return { ok: true, cleared: fids.length, delete: del };
}

async function tryGetShareStoken({ shareId, passcode, cookie }) {
  const pwdId = String(shareId || '').trim();
  if (!pwdId) throw new Error('missing shareId');
  const headers = buildQuarkHeaders(cookie);
  const pc = String(passcode || '').trim();

  const attempts = [
    async () =>
      await fetchJson('https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc', {
        method: 'POST',
        headers,
        body: JSON.stringify(pc ? { pwd_id: pwdId, passcode: pc } : { pwd_id: pwdId }),
      }),
    async () =>
      await fetchJson(`https://drive.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${encodeURIComponent(pwdId)}`, {
        method: 'GET',
        headers,
      }),
    async () =>
      await fetchJson('https://drive.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc', {
        method: 'POST',
        headers,
        body: JSON.stringify(pc ? { pwd_id: pwdId, passcode: pc, pdir_fid: '0' } : { pwd_id: pwdId, pdir_fid: '0' }),
      }),
  ];

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const data = await fn();
      const stoken =
        collectFirstStringByKey(data, 'stoken') ||
        collectFirstStringByKey(data && data.data ? data.data : null, 'stoken');
      if (stoken) return { stoken, raw: data };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('stoken not found');
}

async function quarkShareSave({ shareId, stoken, fid, fidToken, toPdirFid, cookie }) {
  const headers = buildQuarkHeaders(cookie);
  const pwdId = String(shareId || '').trim();
  const sToken = String(stoken || '').trim();
  const fId = String(fid || '').trim();
  const fToken = String(fidToken || '').trim();
  const toPdir = String(toPdirFid || '').trim() || '0';
  if (!pwdId || !sToken || !fId || !fToken) throw new Error('missing quark share parameters');
  if (toPdir === '0') throw new Error('missing to_pdir_fid');

  const saveUrl = 'https://drive.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc';
  const taskUrlBase = 'https://drive.quark.cn/1/clouddrive/task?pr=ucpro&fr=pc';
  const saveBody = {
    fid_list: [fId],
    fid_token_list: [fToken],
    to_pdir_fid: toPdir,
    pwd_id: pwdId,
    stoken: sToken,
    pdir_fid: '0',
    scene: 'link',
    share_id: pwdId,
  };
  const saveResp = await fetchJson(saveUrl, { method: 'POST', headers, body: JSON.stringify(saveBody) });
  const taskId =
    (saveResp && saveResp.data && (saveResp.data.task_id || saveResp.data.taskId || saveResp.data.taskID)) || '';
  const taskID = String(taskId || '').trim();
  if (!taskID) throw new Error('quark save: task_id not found');

  const deadline = Date.now() + 30_000;
  let lastTask = null;
  while (Date.now() < deadline) {
    lastTask = await fetchJson(`${taskUrlBase}&task_id=${encodeURIComponent(taskID)}`, { method: 'GET', headers });
    const data = lastTask && lastTask.data && typeof lastTask.data === 'object' ? lastTask.data : null;
    const state = data ? Number(data.state ?? data.status ?? -1) : -1;
    const finished =
      state === 2 ||
      state === 3 ||
      state === 100 ||
      (data && data.finished === true) ||
      (data && data.finish === true) ||
      (data && Number(data.finish) === 1);
    if (finished) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const savedFids =
    tryGetStringArrayByPath(lastTask, ['data', 'save_as', 'save_as_top_fids']) ||
    tryGetStringArrayByPath(lastTask, ['data', 'save_as', 'save_as_top_fid']) ||
    [];
  return { ok: true, task: lastTask, toPdirFid: toPdir, savedFids };
}

async function getShareDetail({ shareId, stoken, passcode, cookie, pdirFid }) {
  const pwdId = String(shareId || '').trim();
  if (!pwdId) throw new Error('missing shareId');
  let sToken = String(stoken || '').trim();
  let raw = null;
  if (!sToken) {
    const out = await tryGetShareStoken({ shareId: pwdId, passcode, cookie });
    sToken = out.stoken;
    raw = out.raw;
  }
  const headers = buildQuarkHeaders(cookie);
  const dir = String(pdirFid || '0').trim() || '0';
  const url = 'https://drive.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc';
  const body = { pwd_id: pwdId, stoken: sToken, pdir_fid: dir, _fetch_total: 1, _size: 200 };

  // Quark deployments differ:
  // - some accept POST JSON body
  // - others accept only GET with query params (405 on POST)
  const attempts = [
    async () => await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body) }),
    async () => {
      const u = new URL(url);
      u.searchParams.set('pwd_id', pwdId);
      u.searchParams.set('stoken', sToken);
      u.searchParams.set('pdir_fid', dir);
      // best-effort pagination knobs (some clients include these)
      u.searchParams.set('force', '0');
      u.searchParams.set('_page', '1');
      u.searchParams.set('_size', '200');
      u.searchParams.set('_sort', 'file_type:asc,file_name:asc');
      return await fetchJson(u.toString(), { method: 'GET', headers });
    },
  ];

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const detail = await fn();
      return { shareId: pwdId, stoken: sToken, detail, raw };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('share detail failed');
}

async function quarkFileInfo({ fid, cookie }) {
  const headers = buildQuarkHeaders(cookie);
  const fId = String(fid || '').trim();
  if (!fId) throw new Error('missing fid');
  const urls = [
    `https://drive.quark.cn/1/clouddrive/file/info?pr=ucpro&fr=pc&fid=${encodeURIComponent(fId)}`,
    `https://drive.quark.cn/1/clouddrive/file?pr=ucpro&fr=pc&fid=${encodeURIComponent(fId)}`,
  ];
  let lastErr = null;
  for (const u of urls) {
    try {
      return await fetchJson(u, { method: 'GET', headers });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('file info failed');
}

async function quarkDirectDownload({ fid, fidToken, cookie, want }) {
  const headers = buildQuarkHeaders(cookie);
  const fId = String(fid || '').trim();
  const fToken = String(fidToken || '').trim();
  if (!fId) throw new Error('missing fid');
  const wantMode = String(want || 'download_url').trim() || 'download_url';
  const url = 'https://drive.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc';
  // Quark API variants:
  // - some deployments accept `{ fid }`
  // - others require `{ fids: [...] }` and return 400 "Bad Parameter: [fids is empty!]" when missing.
  const body = { fid: fId, fids: [fId] };
  if (fToken) {
    body.fid_token = fToken;
    body.fid_token_list = [fToken];
  }
  const resp = await fetchJsonDetailed(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = resp && resp.data && resp.data.data;
  let out = '';
  if (Array.isArray(data)) {
    for (const it of data) {
      if (!it || typeof it !== 'object') continue;
      out = it[wantMode] || it.download_url || it.play_url || it.url || '';
      if (typeof out === 'string' && out.trim()) break;
      out = '';
    }
  } else if (data && typeof data === 'object') {
    out = data[wantMode] || data.download_url || data.play_url || data.url || '';
  }
  const dl = String(out || '').trim();
  if (!dl) throw new Error('direct download url not found');

  const cookieOut = mergeCookieString(cookie, resp && Array.isArray(resp.setCookies) ? resp.setCookies : []);
  return { url: dl, cookie: cookieOut || cookie };
}

async function resolveDownloadUrl({ shareId, stoken, fid, fidToken, toPdirFid, cookie, want }) {
  const toPdir = String(toPdirFid || '').trim() || '0';
  if (toPdir === '0') throw new Error('missing to_pdir_fid');
  const saved = await quarkShareSave({ shareId, stoken, fid, fidToken, toPdirFid: toPdir, cookie });
  const savedFids = Array.isArray(saved && saved.savedFids) ? saved.savedFids : [];
  if (savedFids.length) {
    try {
      return await quarkDirectDownload({ fid: savedFids[0], fidToken: '', cookie, want });
    } catch {
      // fall through to list fallback
    }
  }

  // After save, pick the saved file from destination folder and request a direct url for it.
  const sortResp = await quarkListDir({ pdirFid: toPdir, cookie, size: 200 });
  const list =
    (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
    (sortResp && sortResp.list) ||
    [];
  let picked = null;
  if (Array.isArray(list)) {
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const isDir = it.dir === true || it.file_type === 0 || it.type === 'folder' || it.kind === 'folder';
      if (isDir) continue;
      const id = String(it.fid || it.file_id || it.id || '').trim();
      if (!id) continue;
      picked = it;
      break;
    }
  }
  const pickedFid = picked ? String(picked.fid || picked.file_id || picked.id || '').trim() : '';
  const pickedToken = picked ? String(picked.fid_token || picked.fidToken || picked.token || '').trim() : '';
  if (!pickedFid) throw new Error('quark save ok but destination folder is empty');
  return await quarkDirectDownload({ fid: pickedFid, fidToken: pickedToken, cookie, want });
}

const apiPlugins = [
  {
    prefix: '/api/quark',
    plugin: async function quarkApi(instance) {
      instance.get('/status', async (req) => {
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        return { ok: true, hasCookie: !!(cookie && cookie.trim()) };
      });

      instance.post('/file/list', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const data = await quarkListDir({ pdirFid: body.pdir_fid ?? body.pdirFid ?? '0', cookie, size: body.size });
          return { ok: true, data };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/file/info', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fid = String(body.fid || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const data = await quarkFileInfo({ fid, cookie });
          return { ok: true, data };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/file/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fid = String(body.fid || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const want = String(body.want || 'download_url').trim() || 'download_url';
          const out = await quarkDirectDownload({
            fid,
            fidToken: body.fidToken || body.fid_token,
            cookie,
            want,
          });
          return {
            ok: true,
            url: out.url,
            headers: {
              Cookie: out.cookie || cookie,
              Referer: QUARK_REFERER,
              'User-Agent': QUARK_UA,
            },
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/share/parse', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const url = String(body.url || '').trim();
        if (!url) {
          reply.code(400);
          return { ok: false, message: 'missing url' };
        }
        const parsed = parseQuarkShareUrl(url);
        if (!parsed || !parsed.shareId) {
          reply.code(400);
          return { ok: false, message: 'invalid quark share url' };
        }
        return { ok: true, shareId: parsed.shareId };
      });

      instance.post('/share/stoken', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const shareId = String(body.shareId || body.pwd_id || body.share_id || '').trim();
        if (!shareId) {
          reply.code(400);
          return { ok: false, message: 'missing shareId' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const out = await tryGetShareStoken({ shareId, passcode: body.passcode || body.pwd, cookie });
          return { ok: true, shareId, stoken: out.stoken };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/share/detail', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const shareId = String(body.shareId || body.pwd_id || body.share_id || '').trim();
        if (!shareId) {
          reply.code(400);
          return { ok: false, message: 'missing shareId' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const out = await getShareDetail({
            shareId,
            stoken: body.stoken,
            passcode: body.passcode || body.pwd,
            pdirFid: body.pdir_fid ?? body.pdirFid ?? '0',
            cookie,
          });
          return { ok: true, ...out };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/share/parse_down', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const url = String(body.url || '').trim();
        const parsed = parseQuarkProxyDownUrl(url);
        if (!parsed) {
          reply.code(400);
          return { ok: false, message: 'invalid down url' };
        }
        return { ok: true, ...parsed };
      });

      instance.post('/file/ensure_dir', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const name = String(body.name || '').trim();
        const parentFid = String(body.parentFid || body.parent_fid || body.pdir_fid || body.pdirFid || '0').trim() || '0';
        if (!name) {
          reply.code(400);
          return { ok: false, message: 'missing name' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const fid = await ensureFolderFid({ name, cookie, parentFid });
          return { ok: true, fid };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      // Ensure a per-user working directory: MeowFilm/<X-TV-User>/<subPath...>
      instance.post('/file/ensure_user_dir', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const subPath = String(body.subPath || body.sub_path || body.path || '').trim();
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const out = await ensureUserDirFid({ req, cookie, subPath });
          return { ok: true, ...out };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(400);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/file/clear', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fid = String(body.fid || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          const out = await quarkClearDir({ pdirFid: fid, cookie });
          return { ok: true, ...out };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/share/save', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const shareId = String(body.shareId || body.pwd_id || body.share_id || '').trim();
        const stoken = String(body.stoken || '').trim();
        const fid = String(body.fid || '').trim();
        const fidToken = String(body.fidToken || body.fid_token || '').trim();
        const toPdirPath = String(body.toPdirPath || body.to_pdir_path || body.toPath || body.to_path || '').trim();
        let toPdirFid = String(body.toPdirFid || body.to_pdir_fid || '').trim();
        if (!shareId || !stoken || !fid || !fidToken) {
          reply.code(400);
          return { ok: false, message: 'missing parameters' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        try {
          if (!toPdirFid) {
            if (!toPdirPath) {
              reply.code(400);
              return { ok: false, message: 'missing toPdirFid (or toPdirPath)' };
            }
            const ensured = await ensureUserDirFid({ req, cookie, subPath: toPdirPath });
            toPdirFid = ensured.fid;
          }
          const out = await quarkShareSave({ shareId, stoken, fid, fidToken, toPdirFid, cookie });
          return { ok: true, ...out };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/share/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }
        const downUrl = String(body.downUrl || body.down_url || body.url || '').trim();
        const parsedDown = downUrl ? parseQuarkProxyDownUrl(downUrl) : null;

        const shareId = String(body.shareId || body.pwd_id || body.share_id || (parsedDown ? parsedDown.shareId : '') || '').trim();
        const stoken = String(body.stoken || (parsedDown ? parsedDown.stoken : '') || '').trim();
        const fid = String(body.fid || (parsedDown ? parsedDown.fid : '') || '').trim();
        const fidToken = String(body.fidToken || body.fid_token || (parsedDown ? parsedDown.fidToken : '') || '').trim();
        const toPdirPath = String(body.toPdirPath || body.to_pdir_path || body.toPath || body.to_path || '').trim();
        let toPdirFid = String(body.toPdirFid || body.to_pdir_fid || '').trim();
        const want = String(body.want || 'download_url').trim() || 'download_url';
        try {
          if (!toPdirFid) {
            if (!toPdirPath) {
              reply.code(400);
              return { ok: false, message: 'missing toPdirFid (or toPdirPath)' };
            }
            const ensured = await ensureUserDirFid({ req, cookie, subPath: toPdirPath });
            toPdirFid = ensured.fid;
          }
          const out = await resolveDownloadUrl({ shareId, stoken, fid, fidToken, toPdirFid, cookie, want });
          return {
            ok: true,
            url: out.url,
            headers: {
              Cookie: out.cookie || cookie,
              Referer: QUARK_REFERER,
              'User-Agent': QUARK_UA,
            },
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg };
        }
      });

      // Direct-download for files that already exist in the user's Quark drive (no share-save/transfer).
      // Input: { fid, fidToken?, want? }  Output: { ok, url, headers? }
      instance.post('/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }

        const fid = String(body.fid || body.file_id || body.id || '').trim();
        const fidToken = String(body.fidToken || body.fid_token || body.token || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        try {
          const outPlay = await quarkDirectDownload({ fid, fidToken, cookie, want: 'play_url' });
          const cookieAfterPlay = outPlay.cookie || cookie;
          const outDl = await quarkDirectDownload({ fid, fidToken, cookie: cookieAfterPlay, want: 'download_url' });
          const cookieAfter = outDl.cookie || cookieAfterPlay || cookie;
          return {
            ok: true,
            url: outPlay.url || outDl.url,
            playUrl: outPlay.url || '',
            downloadUrl: outDl.url || '',
            header: {
              Cookie: cookieAfter,
              Referer: QUARK_REFERER,
              'User-Agent': QUARK_UA,
            },
            headers: {
              Cookie: cookieAfter,
              Referer: QUARK_REFERER,
              'User-Agent': QUARK_UA,
            },
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      // QuarkTV (open-api-drive) direct-download link by fid.
      // Reads credential from config.json: { account: { quark_tv: { refresh_token, device_id, ... } } }
      // Input: { fid, method?: "streaming"|"download" }  Output: { ok, url, method }
      instance.post('/tv/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fid = String(body.fid || body.file_id || body.id || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        const method = String(body.method || body.link_method || 'streaming').trim().toLowerCase();

        const root = await readDbRoot(req.server);
        const tvAcc = getQuarkTvAccountFromDbRoot(root);
        if (!tvAcc || !tvAcc.refreshToken || !tvAcc.deviceId) {
          reply.code(400);
          return { ok: false, message: 'missing quark_tv credentials (account.quark_tv.refresh_token + device_id)' };
        }

        try {
          const out = await quarkTvLinkByFid({ fid, root, rootDir: resolveRuntimeRootDir(), method });
          return { ok: true, url: out.url, method: out.method };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/play', async (req, reply) => {
        const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const tStart = Date.now();
        let stage = 'recv';
        const body = req && typeof req.body === 'object' ? req.body : {};
        const rawId = String(body.id || '').trim();
        const parsed = parseQuarkPlayId(rawId);
        if (!parsed) {
          panLog(`quark play failed id=${reqId}`, { stage: 'decode', ms: Date.now() - tStart, message: 'invalid id' });
          reply.code(400);
          return { ok: false, message: 'invalid id' };
        }

        const root = await readDbRoot(req.server);
        const cookie = getQuarkCookieFromDbRoot(root);
        if (!cookie) {
          panLog(`quark play failed id=${reqId}`, { stage: 'cookie', ms: Date.now() - tStart, message: 'missing quark cookie' });
          reply.code(400);
          return { ok: false, message: 'missing quark cookie' };
        }

        const query = (req && req.query) || {};
        const want = String(body.want || query.want || 'download_url').trim() || 'download_url';
        const tvUserForCache = getTvUserFromReq(req) || '';
        panLog(`quark play recv id=${reqId}`, {
          idLen: rawId.length,
          shareId: maskForLog(parsed.shareId, 4, 4),
          fid: maskForLog(parsed.fid),
          tvUser: tvUserForCache,
        });

        // Cache only resolved URLs (play_url + download_url).
        if (tvUserForCache) {
          const cacheKey = `v2|${tvUserForCache}|${rawId}`;
          const cached = getQuarkPlayUrlCache(cacheKey);
          if (cached && (cached.playUrl || cached.downloadUrl || cached.url)) {
            panLog(`quark play cache hit id=${reqId}`, { ms: Date.now() - tStart });
            return {
              ok: true,
              url: cached.playUrl || cached.url || cached.downloadUrl || '',
              playUrl: cached.playUrl || '',
              downloadUrl: cached.downloadUrl || '',
              parse: 0,
              ...(cached.header ? { header: cached.header } : {}),
              ...(cached.downloadHeader ? { downloadHeader: cached.downloadHeader } : {}),
            };
          }
        }

        // Ensure per-user dir: MeowFilm/<X-TV-User>
        let ensured;
        try {
          stage = 'ensure_dir';
          ensured = await ensureUserDirFid({ req, cookie, subPath: '' });
        } catch (e) {
          const msg = ((e && e.message) || String(e)).slice(0, 400);
          panLog(`quark play failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: msg });
          reply.code(400);
          return { ok: false, message: msg };
        }

        let playCookie = cookie;
        const playHeader = { Cookie: playCookie, Referer: QUARK_REFERER, 'User-Agent': QUARK_UA };

        const toPdirFid = ensured.fid;
        panLog(`quark play ensure_dir done id=${reqId}`, {
          ms: Date.now() - tStart,
          toPdirFid: maskForLog(toPdirFid),
        });

        const pickFirstFileInDir = async () => {
          const sortResp = await quarkListDir({ pdirFid: toPdirFid, cookie, size: 200 });
          const list =
            (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
            (sortResp && sortResp.list) ||
            [];
          if (!Array.isArray(list)) return null;
          for (const it of list) {
            if (!it || typeof it !== 'object') continue;
            const isDir = it.dir === true || it.file_type === 0 || it.type === 'folder' || it.kind === 'folder';
            if (isDir) continue;
            return it;
          }
          return null;
        };

        try {
          stage = 'clear';
          await quarkClearDir({ pdirFid: toPdirFid, cookie });
        } catch (e) {
          const msg = ((e && e.message) || String(e)).slice(0, 400);
          panLog(`quark play failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: msg });
          reply.code(502);
          return { ok: false, message: msg };
        }

        let savedFid = '';
        try {
          stage = 'save';
          const saved = await quarkShareSave({
            shareId: parsed.shareId,
            stoken: parsed.stoken,
            fid: parsed.fid,
            fidToken: parsed.fidToken,
            toPdirFid,
            cookie,
          });
          const savedFids = Array.isArray(saved && saved.savedFids) ? saved.savedFids : [];
          if (savedFids.length) savedFid = String(savedFids[0] || '').trim();
        } catch (e) {
          const msg = ((e && e.message) || String(e)).slice(0, 400);
          panLog(`quark play failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: msg });
          reply.code(502);
          return { ok: false, message: msg };
        }

        // Prefer `save_as_top_fids` from the task result; fall back to listing when missing.
        let picked = savedFid ? { fid: savedFid } : null;
        if (!picked) {
          try {
            stage = 'list';
            picked = await pickFirstFileInDir();
          } catch (e) {
            const msg = ((e && e.message) || String(e)).slice(0, 400);
            panLog(`quark play failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: msg });
            reply.code(502);
            return { ok: false, message: msg };
          }
        }

        const pickedFid = picked ? String(picked.fid || picked.file_id || picked.id || '').trim() : '';
        const pickedToken = picked ? String(picked.fid_token || picked.fidToken || picked.token || '').trim() : '';
        if (!pickedFid) {
          panLog(`quark play failed id=${reqId}`, { stage: 'empty', ms: Date.now() - tStart, message: 'destination folder is empty' });
          reply.code(502);
          return { ok: false, message: 'destination folder is empty' };
        }

        try {
          const tvAcc = getQuarkTvAccountFromDbRoot(root);
          const hasTvCred = !!(tvAcc && tvAcc.refreshToken && tvAcc.deviceId);

          let playUrl = '';
          let downloadUrl = '';
          let headerOut = null;
          let downloadHeaderOut = null;

          if (hasTvCred) {
            // Prefer QuarkTV urls (no cookie headers required).
            try {
              stage = 'tv_streaming';
              const tvOut = await quarkTvLinkByFid({
                fid: pickedFid,
                root,
                rootDir: resolveRuntimeRootDir(),
                method: 'streaming',
              });
              playUrl = tvOut.url || '';
            } catch (e) {
              const msg = (e && e.message) || String(e);
              panLog(`quark play tv streaming failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: String(msg).slice(0, 240) });
              playUrl = '';
            }
            try {
              stage = 'tv_download';
              const tvOut2 = await quarkTvLinkByFid({
                fid: pickedFid,
                root,
                rootDir: resolveRuntimeRootDir(),
                method: 'download',
              });
              downloadUrl = tvOut2.url || '';
            } catch (e2) {
              const msg2 = (e2 && e2.message) || String(e2);
              panLog(`quark play tv download failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: String(msg2).slice(0, 240) });
              downloadUrl = '';
            }
          }

          if (!playUrl || !downloadUrl) {
            // Fallback to cookie-based resolver. Some environments require headers.
            headerOut = playHeader;
            downloadHeaderOut = playHeader;
            if (!playUrl) {
              stage = 'cookie_play_url';
              const outPlay = await quarkDirectDownload({ fid: pickedFid, fidToken: pickedToken, cookie, want: 'play_url' });
              playCookie = outPlay.cookie || playCookie;
              playHeader.Cookie = playCookie;
              playUrl = outPlay.url;
              headerOut = { ...playHeader };
            }
            if (!downloadUrl) {
              stage = 'cookie_download_url';
              const outDl = await quarkDirectDownload({ fid: pickedFid, fidToken: pickedToken, cookie: playCookie, want: 'download_url' });
              playCookie = outDl.cookie || playCookie;
              playHeader.Cookie = playCookie;
              downloadUrl = outDl.url;
              downloadHeaderOut = { ...playHeader };
            }
          }

          // Legacy field: keep `url` as the primary play url when available.
          const url = playUrl || downloadUrl || '';

          panLog(`quark play done id=${reqId}`, {
            ms: Date.now() - tStart,
            stage,
            want,
            toPdirFid: maskForLog(toPdirFid),
            pickedFid: maskForLog(pickedFid),
            host: (() => {
              try {
                return new URL(url).host;
              } catch (_e) {
                return '';
              }
            })(),
          });

          if (tvUserForCache && (playUrl || downloadUrl || url)) {
            const cacheKey = `v2|${tvUserForCache}|${rawId}`;
            setQuarkPlayUrlCache(cacheKey, { url, playUrl, downloadUrl, header: headerOut, downloadHeader: downloadHeaderOut });
          }
          return {
            ok: true,
            url,
            playUrl,
            downloadUrl,
            parse: 0,
            ...(headerOut ? { header: headerOut } : {}),
            ...(downloadHeaderOut ? { downloadHeader: downloadHeaderOut } : {}),
          };
        } catch (e) {
          const msg = ((e && e.message) || String(e)).slice(0, 400);
          panLog(`quark play failed id=${reqId}`, { stage, ms: Date.now() - tStart, message: msg });
          reply.code(502);
          return { ok: false, message: msg };
        }
      });
    },
  },
];

export { apiPlugins };
export default apiPlugins;


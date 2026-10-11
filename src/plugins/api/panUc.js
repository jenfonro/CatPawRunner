// UC (优夕) API plugin.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPanDisplayName } from './panDisplayMeta.js';

const UC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const UC_REFERER = 'https://drive.uc.cn';
const UC_API_BASE = 'https://pc-api.uc.cn/1/clouddrive';

// UCTV (open-api-drive) config: ported from OpenList `drivers/quark_uc_tv` (UCTV).
const UC_TV_API = 'https://open-api-drive.uc.cn';
const UC_TV_CODE_API = 'http://api.extscreen.com/ucdrive';
const UC_TV_CLIENT_ID = '5acf882d27b74502b7040b0c65519aa7';
const UC_TV_SIGN_KEY = 'l3srvtd7p42l0d0x1u8d7yc8ye9kki4d';
const UC_TV_APP_VER = '1.7.2.2';
const UC_TV_CHANNEL = 'UCTVOFFICIALWEB';
const UC_TV_UA =
  'Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1';
const UC_TV_DEVICE_BRAND = 'Xiaomi';
const UC_TV_PLATFORM = 'tv';
const UC_TV_DEVICE_NAME = 'M2004J7AC';
const UC_TV_DEVICE_MODEL = 'M2004J7AC';
const UC_TV_BUILD_DEVICE = 'M2004J7AC';
const UC_TV_BUILD_PRODUCT = 'M2004J7AC';
const UC_TV_DEVICE_GPU = 'Adreno (TM) 550';
const UC_TV_ACTIVITY_RECT = '{}';
const UC_TV_TOKEN_SKEW_MS = 60_000;
let ucTvRefreshInFlight = null;

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input == null ? '' : input)).digest('hex');
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input)).digest('hex');
}

function parseUcShareIdFromFlag(flag) {
  const raw = String(flag || '').trim();
  if (!raw) return '';
  try {
    if (raw.includes('drive.uc.cn')) {
      const p = parseUcShareUrl(raw);
      if (p && p.shareId) return String(p.shareId || '').trim();
    }
  } catch {}
  // Examples: "优夕-0a7af330bad14" / "uc-xxxx"
  const m = raw.match(/(?:优夕|uc)[-_ ]*([a-z0-9]+)/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function pickUcShareFileList(detail) {
  const d = detail && typeof detail === 'object' ? detail : null;
  const list =
    (d && d.data && typeof d.data === 'object' && (d.data.list || d.data.items || d.data.files)) ||
    (d && d.list) ||
    [];
  return Array.isArray(list) ? list : [];
}

function isUcDirItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.dir === true || it.file === false) return true;
  const ft = Number(it.file_type);
  if (Number.isFinite(ft) && ft === 0) return true;
  const kind = String(it.type || it.kind || '').trim().toLowerCase();
  if (kind === 'folder' || kind === 'dir' || kind === 'directory') return true;
  return false;
}

function getUcItemFid(it) {
  if (!it || typeof it !== 'object') return '';
  return String(it.fid || it.file_id || it.fileId || it.id || '').trim();
}

function getUcItemFidToken(it) {
  if (!it || typeof it !== 'object') return '';
  return String(it.share_fid_token || it.fid_token || it.fidToken || it.token || '').trim();
}

function getUcItemName(it) {
  if (!it || typeof it !== 'object') return '';
  return String(it.file_name || it.fileName || it.name || '').trim();
}

function ucTvGenerateReqSign(method, pathname, deviceId) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '').trim() || '/';
  const timestamp = String(Date.now());
  const dev = String(deviceId || '').trim();
  const reqId = md5Hex(`${dev}${timestamp}`);
  const tokenData = `${m}&${p}&${timestamp}&${UC_TV_SIGN_KEY}`;
  const xPanToken = sha256Hex(tokenData);
  return { tm: timestamp, xPanToken, reqId };
}

function isUcTvAccessTokenInvalid(resp, msg) {
  try {
    const r = resp && typeof resp === 'object' ? resp : null;
    const status = r && Object.prototype.hasOwnProperty.call(r, 'status') ? Number(r.status) : NaN;
    const errno = r && Object.prototype.hasOwnProperty.call(r, 'errno') ? Number(r.errno) : NaN;
    if (status === -1 && (errno === 10001 || errno === 11001)) return true;
  } catch {}
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  return m.includes('access token') || m.includes('access_token') || m.includes('token无效') || m.includes('token 无效');
}

async function fetchUcTvJson(urlStr, init) {
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
    const err = new Error(`uc_tv http ${res.status}: ${String(msg).slice(0, 300)}`);
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
      const err = new Error(
        `uc_tv api errno=${Number.isFinite(errno) ? errno : String(data.errno)}: ${String(errInfo || 'request failed').slice(0, 300)}`
      );
      err.body = data;
      err.errno = errno;
      err.statusCode = status;
      throw err;
    }
  }
  return data;
}

function getUcTvAccountFromDbRoot(root) {
  try {
    const account =
      root && typeof root === 'object' && root.account && typeof root.account === 'object' && !Array.isArray(root.account)
        ? root.account
        : null;
    const q = account ? (account.uc_tv || account.uctv || account.ucTV) : null;
    if (!q || typeof q !== 'object' || Array.isArray(q)) return { refreshToken: '', deviceId: '', accessToken: '', accessTokenExpAt: 0 };
    const refreshToken =
      typeof q.refresh_token === 'string'
        ? q.refresh_token.trim()
        : typeof q.refreshToken === 'string'
          ? q.refreshToken.trim()
          : '';
    const deviceId =
      typeof q.device_id === 'string' ? q.device_id.trim() : typeof q.deviceId === 'string' ? q.deviceId.trim() : '';
    const accessToken =
      typeof q.access_token === 'string'
        ? q.access_token.trim()
        : typeof q.accessToken === 'string'
          ? q.accessToken.trim()
          : '';
    const accessTokenExpAt = Number.isFinite(Number(q.access_token_exp_at))
      ? Math.trunc(Number(q.access_token_exp_at))
      : Number.isFinite(Number(q.accessTokenExpAt))
        ? Math.trunc(Number(q.accessTokenExpAt))
        : 0;
    return { refreshToken, deviceId, accessToken, accessTokenExpAt };
  } catch {}
  return { refreshToken: '', deviceId: '', accessToken: '', accessTokenExpAt: 0 };
}

function saveUcTvAccountToConfig(rootDir, patch) {
  const root = rootDir ? String(rootDir) : '';
  const p = patch && typeof patch === 'object' && patch ? patch : {};
  if (!root) throw new Error('invalid runtime root');

  const cfgPath = path.resolve(root, 'config.json');
  const cfgRoot = readJsonFileSafe(cfgPath) || {};
  const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

  const account =
    next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
  const prev =
    account.uc_tv && typeof account.uc_tv === 'object' && account.uc_tv && !Array.isArray(account.uc_tv)
      ? { ...account.uc_tv }
      : {};

  if (typeof p.refreshToken === 'string' && p.refreshToken.trim()) prev.refresh_token = p.refreshToken.trim();
  if (typeof p.deviceId === 'string' && p.deviceId.trim()) prev.device_id = p.deviceId.trim();
  if (typeof p.accessToken === 'string') prev.access_token = p.accessToken.trim();
  if (Number.isFinite(Number(p.accessTokenExpAt)) && Number(p.accessTokenExpAt) > 0) prev.access_token_exp_at = Math.trunc(Number(p.accessTokenExpAt));

  account.uc_tv = prev;
  next.account = account;

  writeJsonFileAtomic(cfgPath, next);
  return { cfgPath, saved: true };
}

async function ucTvRefreshAccessToken({ rootDir, refreshToken, deviceId }) {
  const rt = String(refreshToken || '').trim();
  const dev = String(deviceId || '').trim();
  if (!rt) throw new Error('missing uc_tv refresh_token');
  if (!dev) throw new Error('missing uc_tv device_id');

  const { reqId } = ucTvGenerateReqSign('POST', '/token', dev);
  const url = `${UC_TV_CODE_API}/token`;
  const body = {
    req_id: reqId,
    app_ver: UC_TV_APP_VER,
    device_id: dev,
    device_brand: UC_TV_DEVICE_BRAND,
    platform: UC_TV_PLATFORM,
    device_name: UC_TV_DEVICE_NAME,
    device_model: UC_TV_DEVICE_MODEL,
    build_device: UC_TV_BUILD_DEVICE,
    build_product: UC_TV_BUILD_PRODUCT,
    device_gpu: UC_TV_DEVICE_GPU,
    activity_rect: UC_TV_ACTIVITY_RECT,
    channel: UC_TV_CHANNEL,
    refresh_token: rt,
  };

  const resp = await fetchUcTvJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const code = resp && typeof resp === 'object' && 'code' in resp ? Number(resp.code) : NaN;
  if (code !== 200) {
    const msg = (resp && typeof resp === 'object' && (resp.message || resp.msg)) || 'refresh failed';
    const err = new Error(`uc_tv refresh failed: ${String(msg).slice(0, 300)}`);
    err.body = resp;
    throw err;
  }
  const data = resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' ? resp.data : null;
  const accessToken = data && typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const nextRefresh = data && typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  const expiresIn = data && Number.isFinite(Number(data.expires_in)) ? Math.trunc(Number(data.expires_in)) : 0;
  if (!accessToken) throw new Error('uc_tv refresh failed: empty access_token');

  const expAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
  try {
    saveUcTvAccountToConfig(rootDir, {
      refreshToken: nextRefresh || rt,
      deviceId: dev,
      accessToken,
      accessTokenExpAt: expAt,
    });
  } catch {}

  return { accessToken, refreshToken: nextRefresh || rt, expiresIn, expAt };
}

async function ensureUcTvAccessToken({ rootDir, account }) {
  const root = rootDir ? String(rootDir) : resolveRuntimeRootDir();
  const a = account && typeof account === 'object' ? account : {};
  const refreshToken = String(a.refreshToken || '').trim();
  const deviceId = String(a.deviceId || '').trim();
  const accessToken = String(a.accessToken || '').trim();
  const expAt = Number.isFinite(Number(a.accessTokenExpAt)) ? Math.trunc(Number(a.accessTokenExpAt)) : 0;

  const needRefresh = !accessToken || (expAt > 0 && Date.now() + UC_TV_TOKEN_SKEW_MS >= expAt);
  if (!needRefresh) return { accessToken, refreshToken, deviceId, expAt };

  if (!ucTvRefreshInFlight) {
    ucTvRefreshInFlight = (async () => {
      try {
        return await ucTvRefreshAccessToken({ rootDir: root, refreshToken, deviceId });
      } finally {
        ucTvRefreshInFlight = null;
      }
    })();
  }
  const out = await ucTvRefreshInFlight;
  return { accessToken: out.accessToken, refreshToken: out.refreshToken, deviceId, expAt: out.expAt };
}

async function ucTvLinkByFid({ fid, rootDir, method }) {
  const fId = String(fid || '').trim();
  if (!fId) throw new Error('missing fid');
  const runtimeRoot = rootDir ? String(rootDir) : resolveRuntimeRootDir();
  const cfgRoot = readJsonFileSafe(path.resolve(runtimeRoot, 'config.json')) || {};
  const account = getUcTvAccountFromDbRoot(cfgRoot);
  if (!account || !account.refreshToken || !account.deviceId) throw new Error('missing uc_tv credentials (account.uc_tv.refresh_token + device_id)');

  let tokens = await ensureUcTvAccessToken({ rootDir: runtimeRoot, account });
  const m = String(method || 'streaming').trim().toLowerCase();
  const apiMethod = m === 'download' ? 'download' : 'streaming';

  const callOnce = async () => {
    const { tm, xPanToken, reqId } = ucTvGenerateReqSign('GET', '/file', tokens.deviceId);
    const u = new URL(`${UC_TV_API}/file`);
    u.searchParams.set('req_id', reqId);
    u.searchParams.set('access_token', tokens.accessToken);
    u.searchParams.set('app_ver', UC_TV_APP_VER);
    u.searchParams.set('device_id', tokens.deviceId);
    u.searchParams.set('device_brand', UC_TV_DEVICE_BRAND);
    u.searchParams.set('platform', UC_TV_PLATFORM);
    u.searchParams.set('device_name', UC_TV_DEVICE_NAME);
    u.searchParams.set('device_model', UC_TV_DEVICE_MODEL);
    u.searchParams.set('build_device', UC_TV_BUILD_DEVICE);
    u.searchParams.set('build_product', UC_TV_BUILD_PRODUCT);
    u.searchParams.set('device_gpu', UC_TV_DEVICE_GPU);
    u.searchParams.set('activity_rect', UC_TV_ACTIVITY_RECT);
    u.searchParams.set('channel', UC_TV_CHANNEL);

    u.searchParams.set('method', apiMethod);
    u.searchParams.set('group_by', 'source');
    u.searchParams.set('fid', fId);
    if (apiMethod === 'streaming') {
      u.searchParams.set('resolution', 'low,normal,high,super,2k,4k');
      u.searchParams.set('support', 'dolby_vision');
    }

    return await fetchUcTvJson(u.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': UC_TV_UA,
        'x-pan-tm': tm,
        'x-pan-token': xPanToken,
        'x-pan-client-id': UC_TV_CLIENT_ID,
      },
    });
  };

  try {
    const resp = await callOnce();
    const data = resp && typeof resp === 'object' && resp.data && typeof resp.data === 'object' ? resp.data : null;
    if (apiMethod === 'download') {
      const url = data && typeof data.download_url === 'string' ? data.download_url.trim() : '';
      if (!url) throw new Error('uc_tv download_url not found');
      return { url, raw: resp, method: apiMethod };
    }

    const list = data && Array.isArray(data.video_info) ? data.video_info : [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const u = typeof it.url === 'string' ? it.url.trim() : '';
      if (u) return { url: u, raw: resp, method: apiMethod };
    }
    throw new Error('uc_tv streaming url not found');
  } catch (e) {
    const body = e && e.body ? e.body : null;
    const msg = (e && e.message) || String(e);
    if (!isUcTvAccessTokenInvalid(body, msg)) throw e;
    const refreshed = await ucTvRefreshAccessToken({
      rootDir: runtimeRoot,
      refreshToken: account.refreshToken,
      deviceId: account.deviceId,
    });
    tokens = { ...tokens, accessToken: refreshed.accessToken };
    const resp2 = await callOnce();
    const data2 = resp2 && typeof resp2 === 'object' && resp2.data && typeof resp2.data === 'object' ? resp2.data : null;
    if (apiMethod === 'download') {
      const url2 = data2 && typeof data2.download_url === 'string' ? data2.download_url.trim() : '';
      if (!url2) throw new Error('uc_tv download_url not found');
      return { url: url2, raw: resp2, method: apiMethod };
    }
    const list2 = data2 && Array.isArray(data2.video_info) ? data2.video_info : [];
    for (const it of list2) {
      if (!it || typeof it !== 'object') continue;
      const u = typeof it.url === 'string' ? it.url.trim() : '';
      if (u) return { url: u, raw: resp2, method: apiMethod };
    }
    throw new Error('uc_tv streaming url not found');
  }
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

function collectFirstNumberByKey(root, keyLower) {
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
      if (String(k || '').toLowerCase() === keyLower) {
        const n = Number(val);
        if (Number.isFinite(n)) return n;
      }
      queue.push(val);
    }
  }
  return NaN;
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

function readTextFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function getErrorLogPath() {
  try {
    return path.resolve(resolveRuntimeRootDir(), 'error.log');
  } catch {
    return path.resolve(process.cwd(), 'error.log');
  }
}

function upsertErrorLogByShareId(record) {
  const r = record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  const shareId = String((r && r.shareId) || '').trim();
  if (!shareId) return;

  const logPath = getErrorLogPath();
  const raw = readTextFileSafe(logPath);
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const s = String(line || '').trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      const sid = String((obj && obj.shareId) || '').trim();
      if (sid) map.set(sid, obj);
    } catch {}
  }
  map.set(shareId, { t: Date.now(), provider: 'uc', ...r });
  const out = Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([, v]) => JSON.stringify(v))
    .join('\n');
  atomicWriteFile(logPath, `${out}\n`);
}

function isUcNeedPasscodeError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  if (!msg) return false;
  return msg.includes('passcode') || msg.includes('访问码') || msg.includes('提取码') || msg.includes('密码');
}

function saveUcCookieToConfig(rootDir, cookie) {
  const root = rootDir ? String(rootDir) : '';
  const c = typeof cookie === 'string' ? cookie.trim() : '';
  if (!root) throw new Error('invalid runtime root');
  if (!c) throw new Error('missing cookie');

  const cfgPath = path.resolve(root, 'config.json');
  const cfgRoot = readJsonFileSafe(cfgPath) || {};
  const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};

  const account =
    next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
  const prev =
    account.uc && typeof account.uc === 'object' && account.uc && !Array.isArray(account.uc) ? { ...account.uc } : {};
  prev.cookie = c;
  account.uc = prev;
  next.account = account;

  writeJsonFileAtomic(cfgPath, next);
  return { cfgPath, saved: true };
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

function getUcCookieFromDbRoot(root) {
  try {
    const account =
      root && typeof root === 'object' && root.account && typeof root.account === 'object' && !Array.isArray(root.account)
        ? root.account
        : null;

    const tryRead = (node) => {
      if (typeof node === 'string') return node.trim();
      if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
      return typeof node.cookie === 'string' ? node.cookie.trim() : '';
    };

    // Preferred: account.uc.cookie
    const uc = account ? (Object.prototype.hasOwnProperty.call(account, 'uc') ? account.uc : null) : null;
    const out1 = tryRead(uc);
    if (out1) return out1;

    // Backward/alt keys: account.UC, account.quark_uc, account.quarkUc
    const out2 = tryRead(account ? account.UC : null);
    if (out2) return out2;
    const out3 = tryRead(account ? account.quark_uc : null);
    if (out3) return out3;
    const out4 = tryRead(account ? account.quarkUc : null);
    if (out4) return out4;
  } catch {}
  return '';
}

function cookieHasKey(cookieStr, key) {
  const s = String(cookieStr || '');
  const k = String(key || '').trim();
  if (!k) return false;
  return new RegExp(`(?:^|;\\s*)${k}=`, 'i').test(s);
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
    const err = new Error(`uc http ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (data && typeof data === 'object' && 'code' in data && Number(data.code) !== 0) {
    throw new Error(`uc api code=${data.code} message=${String(data.message || '').slice(0, 300)}`);
  }
  const setCookies = getSetCookiesFromHeaders(res.headers);
  return { data, res, setCookies, text };
}

async function ucFetchJsonWithCookie({ url, init, cookie, persist }) {
  const baseCookie = String(cookie || '').trim();
  const doPersist = persist !== false;
  const resp = await fetchJsonDetailed(url, init);
  const nextCookie = mergeCookieString(baseCookie, resp && Array.isArray(resp.setCookies) ? resp.setCookies : []);
  const outCookie = nextCookie || baseCookie;
  if (doPersist && outCookie && outCookie !== baseCookie) {
    try {
      saveUcCookieToConfig(resolveRuntimeRootDir(), outCookie);
    } catch {}
  }
  return { data: resp.data, cookie: outCookie };
}

function buildUcHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: UC_REFERER,
    Referer: UC_REFERER,
    'User-Agent': UC_UA,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function sanitizePanFolderName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === '.' || raw === '..') return '';
  const cleaned = raw.replace(/[\\/]+/g, '_').replace(/\0/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

function getTvUserFromReq(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-tv-user'] || headers['X-TV-User'] || headers['x_tv_user'] || '';
  return sanitizePanFolderName(raw);
}

function parseSubPathSegments(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\\/]+/g)
    .map((s) => sanitizePanFolderName(s))
    .filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..')) return [];
  return parts.slice(0, 20);
}

function sanitizeVodPlayName(value) {
  return String(value || '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/[<>《》]/g, '')
    .replace(/[$#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeVodIdNameSuffix(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // Keep original file name (no URL encoding).
  // NOTE: `vod_play_url` itself is delimiter-based ("#" and "$"), so names containing those
  // characters can still break parsing. Caller requested no URL formatting here.
  return s;
}

function decodeVodIdNameSuffix(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s;
}

async function ucListDir({ pdirFid, cookie, size, persist }) {
  const fid = String(pdirFid == null ? '0' : pdirFid).trim() || '0';
  const sz = Number.isFinite(Number(size)) ? Math.max(1, Math.min(500, Number(size))) : 200;
  const url =
    `${UC_API_BASE}/file/sort?pr=UCBrowser&fr=pc` +
    `&pdir_fid=${encodeURIComponent(fid)}` +
    `&_fetch_total=1&_size=${encodeURIComponent(String(sz))}` +
    `&_sort=file_type:asc,file_name:asc`;
  const baseCookie = String(cookie || '').trim();
  const headers = buildUcHeaders(baseCookie);
  return await ucFetchJsonWithCookie({ url, init: { method: 'GET', headers }, cookie: baseCookie, persist });
}

async function ensureFolderFid({ name, cookie, parentFid, persist }) {
  const folderName = String(name || '').trim();
  if (!folderName) throw new Error('missing folder name');
  const parent = String(parentFid == null ? '0' : parentFid).trim() || '0';

  const sortOut = await ucListDir({ pdirFid: parent, cookie, size: 500, persist });
  const sortResp = sortOut.data;
  let curCookie = sortOut.cookie;
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
        if (fid) return { fid, cookie: curCookie };
      }
    }
  }

  const createUrl = `${UC_API_BASE}/file?pr=UCBrowser&fr=pc`;
  const body = { pdir_fid: parent, file_name: folderName, dir_path: '', dir_init_lock: false };
  const headers = buildUcHeaders(curCookie);
  const createOut = await ucFetchJsonWithCookie({
    url: createUrl,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
    cookie: curCookie,
    persist,
  });
  curCookie = createOut.cookie;
  const createResp = createOut.data;
  const fid = String((createResp && createResp.data && (createResp.data.fid || createResp.data.file_id || createResp.data.id)) || '').trim();
  if (!fid) throw new Error('create folder: fid not found');
  return { fid, cookie: curCookie };
}

async function ensureUserDirFid({ req, cookie, subPath, persist }) {
  const rootName = 'MeowFilm';
  const user = getTvUserFromReq(req);
  if (!user) throw new Error('missing X-TV-User');

  let curCookie = String(cookie || '').trim();
  const rootOut = await ensureFolderFid({ name: rootName, cookie: curCookie, parentFid: '0', persist });
  const rootFid = rootOut.fid;
  curCookie = rootOut.cookie;
  const userOut = await ensureFolderFid({ name: user, cookie: curCookie, parentFid: rootFid, persist });
  const userFid = userOut.fid;
  curCookie = userOut.cookie;

  const segs = parseSubPathSegments(subPath);
  let cur = userFid;
  for (const seg of segs) {
    const out = await ensureFolderFid({ name: seg, cookie: curCookie, parentFid: cur, persist });
    cur = out.fid;
    curCookie = out.cookie;
  }
  return { rootName, rootFid, user, userFid, fid: cur, subPath: segs.join('/'), cookie: curCookie };
}

function parseUcShareUrl(urlStr) {
  const raw = String(urlStr || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'drive.uc.cn' && !host.endsWith('.uc.cn')) return null;
  const m = u.pathname.match(/^\/s\/([^/?#]+)/);
  if (!m) return { shareId: '', url: raw };
  return { shareId: m[1], url: raw };
}

function parseUcPlayId(idStr) {
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
  const decodedName = decodeVodIdNameSuffix(name);
  return { shareId, stoken, fid, fidToken, name: String(decodedName || '').trim() };
}

async function ensureUcDestDirFid({ req, cookie, toPdirFid, toPdirPath, persist }) {
  const fidIn = String(toPdirFid || '').trim();
  if (fidIn) return { fid: fidIn, cookie: String(cookie || '').trim() };

  const subPath = String(toPdirPath || '').trim();
  const user = getTvUserFromReq(req);
  if (user) {
    const out = await ensureUserDirFid({ req, cookie, subPath, persist });
    return { fid: out.fid, cookie: out.cookie || String(cookie || '').trim() };
  }

  let curCookie = String(cookie || '').trim();
  const rootOut = await ensureFolderFid({ name: 'MeowFilm', cookie: curCookie, parentFid: '0', persist });
  curCookie = rootOut.cookie || curCookie;
  let cur = rootOut.fid;
  const segs = parseSubPathSegments(subPath);
  for (const seg of segs) {
    const out = await ensureFolderFid({ name: seg, cookie: curCookie, parentFid: cur, persist });
    cur = out.fid;
    curCookie = out.cookie || curCookie;
  }
  return { fid: cur, cookie: curCookie };
}

async function tryGetUcShareStoken({ shareId, passcode, cookie }) {
  const pwdId = String(shareId || '').trim();
  if (!pwdId) throw new Error('missing shareId');
  let curCookie = String(cookie || '').trim();
  const headers = buildUcHeaders(curCookie);
  const pc = String(passcode || '').trim();

  const attempts = [
    async () =>
      await ucFetchJsonWithCookie({
        url: `${UC_API_BASE}/share/sharepage/token?pr=UCBrowser&fr=pc`,
        init: { method: 'POST', headers, body: JSON.stringify(pc ? { pwd_id: pwdId, passcode: pc } : { pwd_id: pwdId }) },
        cookie: curCookie,
        persist: true,
      }),
    async () =>
      await ucFetchJsonWithCookie({
        url: `${UC_API_BASE}/share/sharepage/detail?pr=UCBrowser&fr=pc&pwd_id=${encodeURIComponent(pwdId)}`,
        init: { method: 'GET', headers },
        cookie: curCookie,
        persist: true,
      }),
    async () =>
      await ucFetchJsonWithCookie({
        url: `${UC_API_BASE}/share/sharepage/detail?pr=UCBrowser&fr=pc`,
        init: {
          method: 'POST',
          headers,
          body: JSON.stringify(pc ? { pwd_id: pwdId, passcode: pc, pdir_fid: '0' } : { pwd_id: pwdId, pdir_fid: '0' }),
        },
        cookie: curCookie,
        persist: true,
      }),
  ];

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const out = await fn();
      const data = out && out.data;
      if (out && out.cookie) curCookie = out.cookie;
      const stoken =
        collectFirstStringByKey(data, 'stoken') ||
        collectFirstStringByKey(data && data.data ? data.data : null, 'stoken');
      if (stoken) return { stoken, raw: data, cookie: curCookie };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('stoken not found');
}

async function ensureUcTransferCookie({ shareId, cookie }) {
  const pwdId = String(shareId || '').trim();
  let curCookie = String(cookie || '').trim();
  if (!pwdId) return curCookie;
  if (cookieHasKey(curCookie, '__puus') && cookieHasKey(curCookie, 'Video-Auth')) return curCookie;

  try {
    const sharePageUrl = `https://drive.uc.cn/s/${encodeURIComponent(pwdId)}?platform=pc`;
    const shareHeaders = {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: UC_REFERER,
      'User-Agent': UC_UA,
      ...(curCookie ? { Cookie: curCookie } : {}),
    };
    const out = await ucFetchJsonWithCookie({ url: sharePageUrl, init: { method: 'GET', headers: shareHeaders }, cookie: curCookie, persist: true });
    curCookie = out.cookie || curCookie;
  } catch {
    // best-effort
  }

  try {
    const url = `${UC_API_BASE}/transfer/upload/pdir?pr=UCBrowser&fr=pc`;
    const headers = buildUcHeaders(curCookie);
    const out2 = await ucFetchJsonWithCookie({ url, init: { method: 'POST', headers, body: '{}' }, cookie: curCookie, persist: true });
    curCookie = out2.cookie || curCookie;
  } catch {
    // best-effort
  }

  return curCookie;
}

async function ucShareSave({ shareId, stoken, fid, fidToken, toPdirFid, cookie }) {
  let curCookie = await ensureUcTransferCookie({ shareId, cookie });
  const headers = buildUcHeaders(curCookie);
  const pwdId = String(shareId || '').trim();
  const sToken = String(stoken || '').trim();
  const fId = String(fid || '').trim();
  const fToken = String(fidToken || '').trim();
  const toPdir = String(toPdirFid || '').trim() || '0';
  if (!pwdId || !sToken || !fId || !fToken) throw new Error('missing uc share parameters');
  if (toPdir === '0') throw new Error('missing to_pdir_fid');

  const saveUrl = `${UC_API_BASE}/share/sharepage/save?pr=UCBrowser&fr=pc`;
  const taskUrlBase = `${UC_API_BASE}/task?pr=UCBrowser&fr=pc`;
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
  const saveOut = await ucFetchJsonWithCookie({
    url: saveUrl,
    init: { method: 'POST', headers, body: JSON.stringify(saveBody) },
    cookie: curCookie,
    persist: true,
  });
  curCookie = saveOut.cookie || curCookie;
  const saveResp = saveOut.data;
  const taskId =
    (saveResp && saveResp.data && (saveResp.data.task_id || saveResp.data.taskId || saveResp.data.taskID)) || '';
  const taskID = String(taskId || '').trim();
  if (!taskID) throw new Error('uc save: task_id not found');

  const deadline = Date.now() + 30_000;
  let lastTask = null;
  while (Date.now() < deadline) {
    const taskOut = await ucFetchJsonWithCookie({
      url: `${taskUrlBase}&task_id=${encodeURIComponent(taskID)}`,
      init: { method: 'GET', headers: buildUcHeaders(curCookie) },
      cookie: curCookie,
      persist: true,
    });
    curCookie = taskOut.cookie || curCookie;
    lastTask = taskOut.data;
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
  return { ok: true, task: lastTask, toPdirFid: toPdir, cookie: curCookie, savedFids };
}

async function getUcShareDetail({ shareId, stoken, passcode, cookie, pdirFid, page, size }) {
  const pwdId = String(shareId || '').trim();
  if (!pwdId) throw new Error('missing shareId');
  let curCookie = String(cookie || '').trim();
  let sToken = String(stoken || '').trim();
  const pg = Number.isFinite(Number(page)) ? Math.max(1, Math.trunc(Number(page))) : 1;
  const sz = Number.isFinite(Number(size)) ? Math.max(1, Math.min(500, Math.trunc(Number(size)))) : 200;
  let raw = null;
  if (!sToken) {
    const out = await tryGetUcShareStoken({ shareId: pwdId, passcode, cookie: curCookie });
    sToken = out.stoken;
    raw = out.raw;
    curCookie = out.cookie || curCookie;
  }
  const headers = buildUcHeaders(curCookie);
  const dir = String(pdirFid || '0').trim() || '0';
  const url = `${UC_API_BASE}/share/sharepage/detail?pr=UCBrowser&fr=pc`;
  const body = {
    pwd_id: pwdId,
    stoken: sToken,
    pdir_fid: dir,
    force: 0,
    _fetch_total: 1,
    _page: pg,
    _size: sz,
    _sort: 'file_type:asc,file_name:asc',
  };

  const attempts = [
    async () =>
      await ucFetchJsonWithCookie({
        url,
        init: { method: 'POST', headers, body: JSON.stringify(body) },
        cookie: curCookie,
        persist: true,
      }),
    async () => {
      const u = new URL(url);
      u.searchParams.set('pwd_id', pwdId);
      u.searchParams.set('stoken', sToken);
      u.searchParams.set('pdir_fid', dir);
      u.searchParams.set('force', '0');
      u.searchParams.set('_fetch_total', '1');
      u.searchParams.set('_page', String(pg));
      u.searchParams.set('_size', String(sz));
      u.searchParams.set('_sort', 'file_type:asc,file_name:asc');
      return await ucFetchJsonWithCookie({
        url: u.toString(),
        init: { method: 'GET', headers },
        cookie: curCookie,
        persist: true,
      });
    },
  ];

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const out2 = await fn();
      curCookie = out2.cookie || curCookie;
      return { shareId: pwdId, stoken: sToken, detail: out2.data, raw, cookie: curCookie };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('share detail failed');
}

async function listUcShareFilesRecursive({ shareId, passcode, cookie }) {
  const pwdId = String(shareId || '').trim();
  if (!pwdId) throw new Error('missing shareId');

  let curCookie = String(cookie || '').trim();
  const pass = String(passcode || '').trim();

  let rootOut = await getUcShareDetail({ shareId: pwdId, stoken: '', passcode: pass, cookie: curCookie, pdirFid: '0' });
  curCookie = rootOut.cookie || curCookie;
  const stoken = String(rootOut.stoken || '').trim();
  if (!stoken) throw new Error('stoken not found');

  // Virtual-root unwrapping:
  // If share root contains exactly 1 folder and no files, treat that folder as the root.
  // This matches common share patterns where everything is wrapped by a single top-level folder.
  let rootPdirFid = '0';
  let rootDetail = rootOut.detail;
  for (let i = 0; i < 5; i += 1) {
    const list0 = pickUcShareFileList(rootDetail);
    if (!Array.isArray(list0) || !list0.length) break;
    const dirs = [];
    const files0 = [];
    for (const it of list0) {
      if (!it || typeof it !== 'object') continue;
      if (isUcDirItem(it)) dirs.push(it);
      else files0.push(it);
    }
    if (files0.length !== 0 || dirs.length !== 1) break;
    const onlyDirFid = getUcItemFid(dirs[0]);
    if (!onlyDirFid) break;
    rootPdirFid = onlyDirFid;
    const out = await getUcShareDetail({ shareId: pwdId, stoken, passcode: pass, cookie: curCookie, pdirFid: rootPdirFid });
    curCookie = out.cookie || curCookie;
    rootDetail = out.detail;
  }

  const files = [];
  const visited = new Set();
  const queue = [{ pdirFid: rootPdirFid, path: [], detail: rootDetail }];

  const MAX_DEPTH = 12;
  const MAX_DIRS = 800;
  const MAX_FILES = 5000;
  const PAGE_SIZE = 200;
  const MAX_PAGES_PER_DIR = 100;

  while (queue.length) {
    const cur = queue.shift();
    if (!cur) break;
    const dirFid = String(cur.pdirFid || '0').trim() || '0';
    if (visited.has(dirFid)) continue;
    visited.add(dirFid);
    if (visited.size > MAX_DIRS) break;

    const depth = Array.isArray(cur.path) ? cur.path.length : 0;
    if (depth > MAX_DEPTH) continue;

    const seenFileFids = new Set();
    let expectedTotal = NaN;
    let fetchedInDir = 0;

    for (let page = 1; page <= MAX_PAGES_PER_DIR; page += 1) {
      let detail = null;
      if (page === 1 && cur.detail && typeof cur.detail === 'object') {
        detail = cur.detail;
      } else {
        const out = await getUcShareDetail({
          shareId: pwdId,
          stoken,
          passcode: pass,
          cookie: curCookie,
          pdirFid: dirFid,
          page,
          size: PAGE_SIZE,
        });
        curCookie = out.cookie || curCookie;
        detail = out.detail;
      }

      if (!detail || typeof detail !== 'object') break;
      const list = pickUcShareFileList(detail);
      if (!Array.isArray(list) || !list.length) break;

      if (!Number.isFinite(expectedTotal)) {
        const total1 = collectFirstNumberByKey(detail, 'total');
        const total2 = collectFirstNumberByKey(detail, '_total');
        const picked = Number.isFinite(total1) ? total1 : total2;
        if (Number.isFinite(picked) && picked > 0) expectedTotal = picked;
      }

      let newCount = 0;
      for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const name = getUcItemName(it);
        if (isUcDirItem(it)) {
          const childFid = getUcItemFid(it);
          if (!childFid) continue;
          const seg = sanitizePanFolderName(name);
          const nextPath = seg ? [...(cur.path || []), seg] : [...(cur.path || [])];
          queue.push({ pdirFid: childFid, path: nextPath, detail: null });
          continue;
        }
        const fid = getUcItemFid(it);
        const fidToken = getUcItemFidToken(it);
        if (!fid || !fidToken) continue;
        if (seenFileFids.has(fid)) continue;
        seenFileFids.add(fid);
        files.push({ fid, fidToken, name, path: Array.isArray(cur.path) ? cur.path : [] });
        newCount += 1;
        if (files.length >= MAX_FILES) break;
      }

      fetchedInDir += list.length;
      if (files.length >= MAX_FILES) break;

      // Stop paging when:
      // - server returns fewer than page size
      // - no new items added (avoid infinite loops if server repeats same page)
      // - we believe we've fetched all items by total
      if (list.length < PAGE_SIZE) break;
      if (newCount === 0) break;
      if (Number.isFinite(expectedTotal) && fetchedInDir >= expectedTotal) break;
    }

    if (files.length >= MAX_FILES) break;
  }

  return { shareId: pwdId, stoken, cookie: curCookie, files };
}

async function ucDirectDownload({ fid, fidToken, cookie, want }) {
  const headers = buildUcHeaders(cookie);
  const fId = String(fid || '').trim();
  const fToken = String(fidToken || '').trim();
  if (!fId) throw new Error('missing fid');
  const wantMode = String(want || 'download_url').trim() || 'download_url';
  const url = `${UC_API_BASE}/file/download?pr=UCBrowser&fr=pc`;
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
  if (cookieOut && cookieOut !== cookie) {
    try {
      saveUcCookieToConfig(resolveRuntimeRootDir(), cookieOut);
    } catch {}
  }
  return { url: dl, cookie: cookieOut || cookie };
}

async function resolveUcDownloadUrl({ shareId, stoken, fid, fidToken, toPdirFid, cookie, want }) {
  const toPdir = String(toPdirFid || '').trim() || '0';
  if (toPdir === '0') throw new Error('missing to_pdir_fid');
  const saved = await ucShareSave({ shareId, stoken, fid, fidToken, toPdirFid: toPdir, cookie });
  let curCookie = saved.cookie || cookie;
  const savedFids = Array.isArray(saved.savedFids) ? saved.savedFids : [];
  if (savedFids.length) {
    return await ucDirectDownload({ fid: savedFids[0], fidToken: '', cookie: curCookie, want });
  }

  const sortOut = await ucListDir({ pdirFid: toPdir, cookie: curCookie, size: 200, persist: true });
  curCookie = sortOut.cookie || curCookie;
  const sortResp = sortOut.data;
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
  if (!pickedFid) throw new Error('uc save ok but destination folder is empty');
  return await ucDirectDownload({ fid: pickedFid, fidToken: pickedToken, cookie: curCookie, want });
}

async function resolveUcSavedFid({ shareId, stoken, fid, fidToken, toPdirFid, cookie, expectedName }) {
  const toPdir = String(toPdirFid || '').trim() || '0';
  if (toPdir === '0') throw new Error('missing to_pdir_fid');
  const saved = await ucShareSave({ shareId, stoken, fid, fidToken, toPdirFid: toPdir, cookie });
  let curCookie = saved.cookie || cookie;
  const savedFids = Array.isArray(saved.savedFids) ? saved.savedFids : [];
  if (savedFids.length) return { fid: String(savedFids[0] || '').trim(), cookie: curCookie, task: saved.task || null };

  const sortOut = await ucListDir({ pdirFid: toPdir, cookie: curCookie, size: 200, persist: true });
  curCookie = sortOut.cookie || curCookie;
  const sortResp = sortOut.data;
  const list =
    (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
    (sortResp && sortResp.list) ||
    [];
  if (!Array.isArray(list)) throw new Error('uc save ok but destination folder is empty');

  const wantName = String(expectedName || '').trim();
  const pickByName = (it) => {
    if (!wantName) return false;
    const name = String(it && (it.file_name || it.fileName || it.name || '')).trim();
    if (!name) return false;
    return name === wantName;
  };
  const isDir = (it) => it && (it.dir === true || it.file_type === 0 || it.type === 'folder' || it.kind === 'folder');

  let picked = null;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    if (isDir(it)) continue;
    const id2 = String(it.fid || it.file_id || it.id || '').trim();
    if (!id2) continue;
    if (pickByName(it)) {
      picked = it;
      break;
    }
  }
  if (!picked) {
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      if (isDir(it)) continue;
      const id2 = String(it.fid || it.file_id || it.id || '').trim();
      if (!id2) continue;
      picked = it;
      break;
    }
  }
  const pickedFid = picked ? String(picked.fid || picked.file_id || picked.id || '').trim() : '';
  if (!pickedFid) throw new Error('uc save ok but destination folder is empty');
  return { fid: pickedFid, cookie: curCookie, task: saved.task || null };
}

async function ucDeleteFiles({ fids, cookie }) {
  const list = Array.isArray(fids) ? fids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return { ok: true, deleted: 0, cookie: String(cookie || '').trim() };
  let curCookie = String(cookie || '').trim();
  const url = `${UC_API_BASE}/file/delete?pr=UCBrowser&fr=pc`;

  const call = async (actionType) => {
    const headers = buildUcHeaders(curCookie);
    const body = { action_type: actionType, filelist: list, exclude_fids: [] };
    const out = await ucFetchJsonWithCookie({
      url,
      init: { method: 'POST', headers, body: JSON.stringify(body) },
      cookie: curCookie,
      persist: true,
    });
    curCookie = out.cookie || curCookie;
    return out.data;
  };

  try {
    const resp = await call(2);
    return { ok: true, deleted: list.length, resp, cookie: curCookie };
  } catch (e) {
    const resp2 = await call(1);
    return { ok: true, deleted: list.length, resp: resp2, cookie: curCookie };
  }
}

async function ucClearDir({ pdirFid, cookie }) {
  const fid = String(pdirFid == null ? '0' : pdirFid).trim() || '0';
  if (fid === '0') throw new Error('refuse to clear root (pdir_fid=0)');
  let curCookie = String(cookie || '').trim();

  const sortOut = await ucListDir({ pdirFid: fid, cookie: curCookie, size: 500, persist: true });
  curCookie = sortOut.cookie || curCookie;
  const sortResp = sortOut.data;
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
  if (!fids.length) return { ok: true, cleared: 0, cookie: curCookie };
  const del = await ucDeleteFiles({ fids, cookie: curCookie });
  curCookie = del.cookie || curCookie;
  return { ok: true, cleared: fids.length, delete: del, cookie: curCookie };
}

const apiPlugins = [
  {
    prefix: '/api/uc',
    plugin: async function ucApi(instance) {
      instance.get('/status', async (req) => {
        const root = await readDbRoot(req.server);
        const cookie = getUcCookieFromDbRoot(root);
        return { ok: true, hasCookie: !!(cookie && cookie.trim()) };
      });

      instance.post('/file/clear', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fid = String(body.fid || body.pdir_fid || body.pdirFid || '').trim();
        if (!fid) {
          reply.code(400);
          return { ok: false, message: 'missing fid' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const out = await ucClearDir({ pdirFid: fid, cookie });
          const { cookie: _cookie, ...rest } = out || {};
          void _cookie;
          return { ok: true, ...rest };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/file/list', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const root = await readDbRoot(req.server);
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const out = await ucListDir({ pdirFid: body.pdir_fid ?? body.pdirFid ?? '0', cookie, size: body.size, persist: true });
          return { ok: true, data: out.data };
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
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const fidToken = body.fidToken || body.fid_token;
          const outPlay = await ucDirectDownload({
            fid,
            fidToken,
            cookie,
            want: 'play_url',
          });
          const cookieAfterPlay = outPlay.cookie || cookie;
          const outDl = await ucDirectDownload({
            fid,
            fidToken,
            cookie: cookieAfterPlay,
            want: 'download_url',
          });
          const cookieAfter = outDl.cookie || cookieAfterPlay || cookie;
          return {
            ok: true,
            url: outPlay.url || outDl.url,
            playUrl: outPlay.url || '',
            downloadUrl: outDl.url || '',
            header: {
              Cookie: cookieAfter,
              Referer: UC_REFERER,
              'User-Agent': UC_UA,
            },
            headers: {
              Cookie: cookieAfter,
              Referer: UC_REFERER,
              'User-Agent': UC_UA,
            },
          };
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
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const out = await ensureUserDirFid({ req, cookie, subPath, persist: true });
          const { cookie: _cookie, ...rest } = out || {};
          void _cookie;
          return { ok: true, ...rest };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(400);
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
        const parsed = parseUcShareUrl(url);
        if (!parsed || !parsed.shareId) {
          reply.code(400);
          return { ok: false, message: 'invalid uc share url' };
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
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const out = await tryGetUcShareStoken({ shareId, passcode: body.passcode || body.pwd, cookie });
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
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          const out = await getUcShareDetail({
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

      instance.post('/list', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const flag = String(body.flag || '').trim();
        if (!flag) {
          reply.code(400);
          return { ok: false, message: 'missing flag' };
        }
        const shareId = parseUcShareIdFromFlag(flag);
        if (!shareId) {
          reply.code(400);
          return { ok: false, message: 'missing/invalid flag (expected: 优夕-<shareId>)' };
        }
        const root = await readDbRoot(req.server);
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        const passcodeIn = String(body.passcode || body.pwd || '').trim();
        try {
          const out = await listUcShareFilesRecursive({ shareId, passcode: passcodeIn, cookie });
          const stoken = String(out && out.stoken ? out.stoken : '').trim();
          const list = Array.isArray(out && out.files ? out.files : null) ? out.files : [];

          const parts = [];
          for (const it of list) {
            if (!it) continue;
            const fid = String(it.fid || '').trim();
            const fidToken = String(it.fidToken || '').trim();
            const name = String(it.name || '').trim();
            if (!fid || !fidToken || !name) continue;
            const dirPath = Array.isArray(it.path) && it.path.length ? `/${it.path.join('/')}` : '/';
            const baseDisplay = sanitizeVodPlayName(dirPath) || '/';
            const displayName = buildPanDisplayName(baseDisplay, it, name);
            const suffix = encodeVodIdNameSuffix(name);
            const id = `${shareId}*${stoken}*${fid}*${fidToken}${suffix ? `***${suffix}` : ''}`;
            parts.push(`${displayName}$${id}`);
          }
          return { ok: true, vod_play_url: parts.join('#') };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          try {
            if (isUcNeedPasscodeError(e)) {
              upsertErrorLogByShareId({
                api: '/api/uc/list',
                shareId,
                needPasscode: true,
                passcodeProvided: !!passcodeIn,
                message: msg.slice(0, 400),
              });
            }
          } catch {}
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
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }
        try {
          if (!toPdirFid) {
            if (!toPdirPath) {
              reply.code(400);
              return { ok: false, message: 'missing toPdirFid (or toPdirPath)' };
            }
            const ensured = await ensureUserDirFid({ req, cookie, subPath: toPdirPath, persist: true });
            toPdirFid = ensured.fid;
          }
          const out = await ucShareSave({ shareId, stoken, fid, fidToken, toPdirFid, cookie });
          const { cookie: _cookie, ...rest } = out || {};
          void _cookie;
          return { ok: true, ...rest };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      // One-shot: share-save/transfer then return direct download url of the saved file.
      instance.post('/share/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const root = await readDbRoot(req.server);
        const cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }

        const shareId = String(body.shareId || body.pwd_id || body.share_id || '').trim();
        const stoken = String(body.stoken || '').trim();
        const fid = String(body.fid || '').trim();
        const fidToken = String(body.fidToken || body.fid_token || '').trim();
        const toPdirPath = String(body.toPdirPath || body.to_pdir_path || body.toPath || body.to_path || '').trim();
        let toPdirFid = String(body.toPdirFid || body.to_pdir_fid || '').trim();
        const want = String(body.want || 'download_url').trim() || 'download_url';

        if (!shareId || !stoken || !fid || !fidToken) {
          reply.code(400);
          return { ok: false, message: 'missing parameters' };
        }

        try {
          if (!toPdirFid) {
            if (!toPdirPath) {
              reply.code(400);
              return { ok: false, message: 'missing toPdirFid (or toPdirPath)' };
            }
            const ensured = await ensureUserDirFid({ req, cookie, subPath: toPdirPath, persist: true });
            toPdirFid = ensured.fid;
          }
          const out = await resolveUcDownloadUrl({ shareId, stoken, fid, fidToken, toPdirFid, cookie, want });
          return {
            ok: true,
            url: out.url,
            headers: {
              Cookie: out.cookie || cookie,
              Referer: UC_REFERER,
              'User-Agent': UC_UA,
            },
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/play', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const flag = String(body.flag || '').trim();
        const rawId = String(body.id || '').trim();
        const parsed = parseUcPlayId(rawId);
        if (!parsed) {
          reply.code(400);
          return { ok: false, message: 'invalid id' };
        }

        const root = await readDbRoot(req.server);
        let cookie = getUcCookieFromDbRoot(root);
        if (!cookie) {
          reply.code(400);
          return { ok: false, message: 'missing uc cookie' };
        }

        const query = (req && req.query) || {};
        const want = String(body.want || query.want || 'play_url').trim() || 'play_url';
        const method =
          want.toLowerCase().includes('download') ? 'download' : 'streaming';

        const toPdirPath = String(body.toPdirPath || body.to_pdir_path || body.toPath || body.to_path || '').trim();
        const toPdirFidIn = String(body.toPdirFid || body.to_pdir_fid || '').trim();

        // Best-effort: allow flag to be a share url and override shareId when needed.
        let shareId = parsed.shareId;
        if (flag.includes('drive.uc.cn')) {
          const p = parseUcShareUrl(flag);
          if (p && p.shareId) shareId = p.shareId;
        }

        try {
          // Ensure per-user dir (when X-TV-User present) or fall back to stable MeowFilm/...
          const dest = await ensureUcDestDirFid({
            req,
            cookie,
            toPdirFid: toPdirFidIn,
            toPdirPath,
            persist: true,
          });
          cookie = dest.cookie || cookie;

          const out = await ucShareSave({
            shareId,
            stoken: parsed.stoken,
            fid: parsed.fid,
            fidToken: parsed.fidToken,
            toPdirFid: dest.fid,
            cookie,
          });
          cookie = (out && out.cookie) || cookie;

          let savedFid = Array.isArray(out.savedFids) && out.savedFids.length ? String(out.savedFids[0] || '').trim() : '';
          if (!savedFid) {
            const sortOut = await ucListDir({ pdirFid: dest.fid, cookie, size: 200, persist: true });
            cookie = sortOut.cookie || cookie;
            const sortResp = sortOut.data;
            const list =
              (sortResp && sortResp.data && (sortResp.data.list || sortResp.data.items || sortResp.data.files)) ||
              (sortResp && sortResp.list) ||
              [];
            const wantName = String(parsed.name || '').trim();
            const isDir = (it) => it && (it.dir === true || it.file_type === 0 || it.type === 'folder' || it.kind === 'folder');
            const candidates = Array.isArray(list) ? list.filter((it) => it && typeof it === 'object' && !isDir(it)) : [];
            let picked = null;
            if (wantName) {
              for (const it of candidates) {
                const nm = String(it.file_name || it.fileName || it.name || '').trim();
                if (nm && nm === wantName) {
                  picked = it;
                  break;
                }
              }
            }
            if (!picked) picked = candidates.length ? candidates[0] : null;
            savedFid = picked ? String(picked.fid || picked.file_id || picked.id || '').trim() : '';
          }
          if (!savedFid) throw new Error('destination folder is empty');

          const tvAcc = getUcTvAccountFromDbRoot(root);
          const hasTvCred = !!(tvAcc && tvAcc.refreshToken && tvAcc.deviceId);

          let playUrl = '';
          let downloadUrl = '';
          let playHeader = null;
          let downloadHeader = null;
          let playSource = '';
          let downloadSource = '';

          if (hasTvCred) {
            try {
              const tvOut = await ucTvLinkByFid({ fid: savedFid, rootDir: resolveRuntimeRootDir(), method: 'streaming' });
              playUrl = tvOut.url || '';
              if (playUrl) playSource = 'tv';
            } catch {
              playUrl = '';
            }
            try {
              const tvOut2 = await ucTvLinkByFid({ fid: savedFid, rootDir: resolveRuntimeRootDir(), method: 'download' });
              downloadUrl = tvOut2.url || '';
              if (downloadUrl) downloadSource = 'tv';
            } catch {
              downloadUrl = '';
            }
          }

          if (!playUrl || !downloadUrl) {
            // Fallback to cookie-based urls (may require headers).
            if (!playUrl) {
              const outPlay = await ucDirectDownload({ fid: savedFid, fidToken: '', cookie, want: 'play_url' });
              cookie = outPlay.cookie || cookie;
              playUrl = outPlay.url;
              playHeader = { Cookie: cookie, Referer: UC_REFERER, 'User-Agent': UC_UA };
              playSource = playUrl ? 'cookie' : playSource;
            }
            if (!downloadUrl) {
              const outDl = await ucDirectDownload({ fid: savedFid, fidToken: '', cookie, want: 'download_url' });
              cookie = outDl.cookie || cookie;
              downloadUrl = outDl.url;
              downloadHeader = { Cookie: cookie, Referer: UC_REFERER, 'User-Agent': UC_UA };
              downloadSource = downloadUrl ? 'cookie' : downloadSource;
            }
          }

          const preferDownload = method === 'download';
          const chosenUrl = preferDownload ? (downloadUrl || playUrl || '') : (playUrl || downloadUrl || '');
          const chosenSource = preferDownload
            ? (downloadUrl ? downloadSource : playSource)
            : (playUrl ? playSource : downloadSource);
          const chosenHeader = preferDownload ? (downloadUrl ? downloadHeader : playHeader) : (playUrl ? playHeader : downloadHeader);

          // `version` is injected globally by catpawrunner server preSerialization hook (see `src/index.js`).
          const resp = { ok: true, url: chosenUrl };
          if (chosenSource === 'cookie' && chosenHeader) resp.header = chosenHeader;
          return resp;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });

      instance.post('/tv/download', async (req, reply) => {
        const body = req && typeof req.body === 'object' ? req.body : {};
        const fidIn = String(body.fid || body.file_id || body.fileId || body.id_fid || '').trim();
        const flag = String(body.flag || '').trim();
        const id = String(body.id || '').trim();
        const toPdirPath = String(body.toPdirPath || body.to_pdir_path || body.toPath || body.to_path || '').trim();
        const toPdirFidIn = String(body.toPdirFid || body.to_pdir_fid || '').trim();
        const want = String(body.want || 'play_url').trim() || 'play_url';
        const methodIn = String(body.method || body.link_method || '').trim().toLowerCase();
        const method =
          methodIn === 'download' || methodIn === 'streaming'
            ? methodIn
            : want.toLowerCase().includes('download')
              ? 'download'
              : 'streaming';

        const root = await readDbRoot(req.server);
        const tvAcc = getUcTvAccountFromDbRoot(root);
        if (!tvAcc || !tvAcc.refreshToken || !tvAcc.deviceId) {
          reply.code(400);
          return { ok: false, message: 'missing uc_tv credentials (account.uc_tv.refresh_token + device_id)' };
        }

        try {
          let finalFid = fidIn;
          let task = null;
          let cookie = '';

          if (!finalFid) {
            if (!flag || !id) {
              reply.code(400);
              return { ok: false, message: 'missing fid or flag/id' };
            }
            const parsed = parseUcPlayId(id);
            if (!parsed) {
              reply.code(400);
              return { ok: false, message: 'invalid id' };
            }

            cookie = getUcCookieFromDbRoot(root);
            if (!cookie) {
              reply.code(400);
              return { ok: false, message: 'missing uc cookie' };
            }

            let shareId = parsed.shareId;
            if (flag.includes('drive.uc.cn')) {
              const p = parseUcShareUrl(flag);
              if (p && p.shareId) shareId = p.shareId;
            }

            const dest = await ensureUcDestDirFid({
              req,
              cookie,
              toPdirFid: toPdirFidIn,
              toPdirPath,
              persist: true,
            });
            cookie = dest.cookie || cookie;

            const savedOut = await resolveUcSavedFid({
              shareId,
              stoken: parsed.stoken,
              fid: parsed.fid,
              fidToken: parsed.fidToken,
              toPdirFid: dest.fid,
              cookie,
              expectedName: parsed.name,
            });
            finalFid = savedOut.fid;
            task = savedOut.task || null;
          } else {
            cookie = getUcCookieFromDbRoot(root);
          }

          const resolveOne = async (m) => {
            try {
              const out = await ucTvLinkByFid({ fid: finalFid, rootDir: resolveRuntimeRootDir(), method: m });
              return { ok: true, url: out.url || '', method: out.method || m, header: null };
            } catch (eTv) {
              if (!cookie) throw eTv;
              const out2 = await ucDirectDownload({ fid: finalFid, fidToken: '', cookie, want: m === 'download' ? 'download_url' : 'play_url' });
              const headerOut = {
                Cookie: out2.cookie || cookie,
                Referer: UC_REFERER,
                'User-Agent': UC_UA,
              };
              return { ok: true, url: out2.url || '', method: 'cookie', header: headerOut };
            }
          };

          let playUrl = '';
          let downloadUrl = '';
          let headerOut = null;

          const playRes = await resolveOne('streaming');
          playUrl = playRes.url || '';
          headerOut = playRes.header;

          const dlRes = await resolveOne('download');
          downloadUrl = dlRes.url || '';
          if (!headerOut) headerOut = dlRes.header;

          // Keep legacy `url` according to requested method.
          const url = method === 'download' ? (downloadUrl || playUrl) : (playUrl || downloadUrl);
          const legacyHeader = headerOut || null;

          return {
            ok: true,
            url,
            playUrl,
            downloadUrl,
            method,
            fid: finalFid,
            task,
            parse: 0,
            ...(legacyHeader ? { header: legacyHeader, headers: legacyHeader } : { header: {}, headers: {} }),
          };
        } catch (e) {
          const msg = (e && e.message) || String(e);
          reply.code(502);
          return { ok: false, message: msg.slice(0, 400) };
        }
      });
    },
  },
];

export { apiPlugins };
export default apiPlugins;

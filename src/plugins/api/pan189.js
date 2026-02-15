// Tianyi (天翼云盘 / cloud.189.cn) share API plugin.
// Keep only minimal endpoints:
// - POST /api/189/share/info
// - POST /api/189/share/list
// - POST /api/189/file/download
// - POST /api/189/play  (id: fileId*shareId*fileName)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIANYI_API_BASE = 'https://cloud.189.cn';
const TIANYI_AUTH_BASE = 'https://open.e.189.cn';
const TIANYI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function toStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
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

function read189AccountFromConfig() {
  try {
    const runtimeRoot = resolveRuntimeRootDir();
    const cfgPath = path.resolve(runtimeRoot, 'config.json');
    const cfgRoot = readConfigJsonSafe(cfgPath);
    const account =
      cfgRoot && typeof cfgRoot.account === 'object' && cfgRoot.account && !Array.isArray(cfgRoot.account) ? cfgRoot.account : {};
    const p =
      account && typeof account['189'] === 'object' && account['189'] && !Array.isArray(account['189'])
        ? account['189']
        : account && typeof account.tianyi === 'object' && account.tianyi && !Array.isArray(account.tianyi)
          ? account.tianyi
          : {};
    const cookie = typeof p.cookie === 'string' ? p.cookie.trim() : '';
    const username = typeof p.username === 'string' ? p.username : typeof p.userName === 'string' ? p.userName : '';
    const password = typeof p.password === 'string' ? p.password : '';
    return { cookie, username, password, cfgPath, cfgRoot };
  } catch (_) {
    return { cookie: '', username: '', password: '', cfgPath: '', cfgRoot: {} };
  }
}

async function fetchTianyiJson(urlStr, init = {}) {
  const res = await fetch(urlStr, { redirect: 'manual', ...init });
  const text = await res.text();
  let data = null;
  try {
    data = text && text.trim() ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg)) || text || `status=${res.status}`;
    const err = new Error(`tianyi http ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status;
    err.body = data;
    err.rawText = text;
    throw err;
  }
  return { status: res.status, headers: res.headers, text, data };
}

async function resolveFinalUrl(urlStr, { maxRedirects = 8 } = {}) {
  let current = toStr(urlStr).trim();
  if (!current) return '';
  const limit = Number.isFinite(Number(maxRedirects)) ? Math.max(0, Math.trunc(Number(maxRedirects))) : 8;
  for (let i = 0; i <= limit; i += 1) {
    const res = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': TIANYI_UA,
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-0',
      },
    });
    try {
      if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel();
    } catch (_) {}

    const status = Number(res && res.status ? res.status : 0);
    const loc = toStr(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '').trim();
    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return current;
  }
  return current;
}

function buildTianyiHeaders({ cookie, referer }) {
  const h = {
    Accept: 'application/json;charset=UTF-8',
    'Accept-Encoding': 'identity',
    'User-Agent': TIANYI_UA,
    ...(referer ? { Referer: referer } : {}),
  };
  const c = toStr(cookie).trim();
  if (c) h.Cookie = c;
  return h;
}

function pickSetCookieFromHeaders(headers) {
  if (!headers) return [];
  try {
    if (typeof headers.getSetCookie === 'function') {
      const v = headers.getSetCookie();
      return Array.isArray(v) ? v.map((x) => toStr(x).trim()).filter(Boolean) : [];
    }
  } catch (_) {}
  try {
    const v = headers.get('set-cookie');
    if (!v) return [];
    return [toStr(v).trim()].filter(Boolean);
  } catch (_) {}
  return [];
}

function mergeCookieJar(jar, setCookieHeaders) {
  const j = jar && typeof jar === 'object' ? jar : {};
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  for (const line of list) {
    const raw = toStr(line).trim();
    if (!raw) continue;
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    j[name] = value;
  }
  return j;
}

function cookieJarToHeader(jar) {
  const j = jar && typeof jar === 'object' ? jar : {};
  const pairs = [];
  for (const [k, v] of Object.entries(j)) {
    const name = toStr(k).trim();
    if (!name) continue;
    pairs.push(`${name}=${toStr(v)}`);
  }
  return pairs.join('; ');
}

function toFormUrlEncoded(obj) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const parts = [];
  for (const [k, v] of Object.entries(o)) {
    const key = toStr(k);
    const value = toStr(v);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

function wrapPublicKeyPem(rawKey) {
  const k = toStr(rawKey).trim();
  if (!k) return '';
  if (k.includes('BEGIN PUBLIC KEY')) return k;
  // Some pages return bare base64 body.
  return `-----BEGIN PUBLIC KEY-----\n${k}\n-----END PUBLIC KEY-----`;
}

function rsaEncryptToHexUpper(publicKey, plainText) {
  const pem = wrapPublicKeyPem(publicKey);
  if (!pem) throw new Error('missing rsa public key');
  const enc = crypto.publicEncrypt(
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(toStr(plainText), 'utf8')
  );
  return enc.toString('hex').toUpperCase();
}

async function fetch189EncryptConf() {
  const url = `${TIANYI_AUTH_BASE}/api/logbox/config/encryptConf.do?appId=8025431004&timeStamp=${Date.now()}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': TIANYI_UA, Referer: TIANYI_AUTH_BASE, Accept: 'application/json, text/plain, */*', 'Accept-Encoding': 'identity' },
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text && text.trim() ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  if (!res.ok || !json || typeof json !== 'object') return { ok: false, rsaKey: '', pre: '' };
  const result = Object.prototype.hasOwnProperty.call(json, 'result') ? Number(json.result) : NaN;
  if (result !== 0) return { ok: false, rsaKey: '', pre: '' };
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  const rsaKey =
    toStr(data.pubKey || data.publicKey || data.rsaPublicKey || data.rsa_key || data.key || '').trim();
  const pre = toStr(data.pre || data.prefix || '').trim();
  return { ok: !!rsaKey, rsaKey, pre, raw: json };
}

async function fetchWithCookieJar(urlStr, { jar, ...init } = {}) {
  const res = await fetch(urlStr, { redirect: 'manual', ...init });
  const setCookie = pickSetCookieFromHeaders(res.headers);
  mergeCookieJar(jar, setCookie);
  const text = await res.text();
  return { res, text };
}

async function followRedirectsWithCookieJar(urlStr, { jar, headers, maxRedirects = 8 } = {}) {
  let current = toStr(urlStr).trim();
  const h = headers && typeof headers === 'object' ? headers : {};
  for (let i = 0; i <= maxRedirects; i += 1) {
    const { res } = await fetchWithCookieJar(current, { jar, method: 'GET', headers: h });
    const status = Number(res.status || 0);
    const loc = toStr(res.headers.get('location')).trim();
    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return { status, url: current };
  }
  throw new Error('too many redirects');
}

function parseLtReqIdFromUrl(urlStr) {
  const raw = toStr(urlStr).trim();
  if (!raw) return { lt: '', reqId: '' };
  const mReq = raw.match(/reqId=([a-zA-Z0-9]+)/);
  const mLt = raw.match(/(?:\\?|&)lt=([a-zA-Z0-9]+)/);
  const mApp = raw.match(/(?:\\?|&)appId=([a-zA-Z0-9]+)/);
  return {
    lt: mLt && mLt[1] ? toStr(mLt[1]).trim() : '',
    reqId: mReq && mReq[1] ? toStr(mReq[1]).trim() : '',
    appId: mApp && mApp[1] ? toStr(mApp[1]).trim() : '',
  };
}

async function fetchUnifyAccountLoginLtReqId({ jar }) {
  // Align with the runtime script behavior: start from cloud.189.cn and follow redirects to open.e.189.cn,
  // then extract `lt` and `reqId` from the final URL.
  const loginUrl =
    'https://cloud.189.cn/api/portal/loginUrl.action?redirectURL=' +
    encodeURIComponent('https://cloud.189.cn/main.action');
  const jumped = await followRedirectsWithCookieJar(loginUrl, {
    jar,
    headers: { 'User-Agent': TIANYI_UA, Referer: 'https://cloud.189.cn/', 'Accept-Encoding': 'identity' },
  });
  const parsed = parseLtReqIdFromUrl(jumped && jumped.url ? jumped.url : loginUrl);
  return { ...parsed, url: jumped && jumped.url ? jumped.url : loginUrl };
}

async function fetch189AppConf({ jar, lt, reqId, appId }) {
  const url = `${TIANYI_AUTH_BASE}/api/logbox/oauth2/appConf.do`;
  const cookieHeader = cookieJarToHeader(jar);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': TIANYI_UA,
      Referer: TIANYI_AUTH_BASE,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Encoding': 'identity',
      ...(lt ? { Lt: lt } : {}),
      ...(reqId ? { Reqid: reqId } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: toFormUrlEncoded({ version: '2.0', appKey: toStr(appId || 'cloud').trim() || 'cloud' }),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text && text.trim() ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  if (!res.ok || !json || typeof json !== 'object') {
    const err = new Error(`tianyi appConf failed: http ${res.status}`);
    err.status = res.status;
    err.rawText = text;
    err.body = json;
    throw err;
  }
  const result = Object.prototype.hasOwnProperty.call(json, 'result') ? Number(json.result) : NaN;
  if (Number.isFinite(result) && result !== 0) {
    const msg = toStr(json.msg || json.message || 'appConf failed').trim();
    const err = new Error(`tianyi appConf failed: ${msg || String(json.result)}`);
    err.body = json;
    throw err;
  }
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  return {
    accountType: toStr(data.accountType || '').trim(),
    mailSuffix: toStr(data.mailSuffix || '').trim(),
    clientType: Number.isFinite(Number(data.clientType)) ? Math.trunc(Number(data.clientType)) : 0,
    isOauth2: !!data.isOauth2,
    returnUrl: toStr(data.returnUrl || '').trim(),
    paramId: toStr(data.paramId || '').trim(),
    raw: json,
  };
}

async function login189WithPassword({ username, password }) {
  const user = toStr(username).trim();
  const pass = toStr(password);
  if (!user || !pass) throw new Error('missing 189 username/password');

  const jar = {};

  // 1) Get RSA public key.
  const enc = await fetch189EncryptConf();
  const rsaKey = enc && enc.ok && enc.rsaKey ? enc.rsaKey : '';
  const pre = enc && enc.ok ? toStr(enc.pre).trim() : '';
  if (!rsaKey) throw new Error('tianyi login: rsa key not found');

  // 2) Get lt/reqId (from redirect url), then fetch returnUrl/paramId.
  const lr = await fetchUnifyAccountLoginLtReqId({ jar });
  const lt = toStr(lr.lt).trim();
  const reqId = toStr(lr.reqId).trim();
  const appId = toStr(lr.appId).trim() || 'cloud';
  if (!lt || !reqId) throw new Error('tianyi login: missing lt/reqId');

  const conf = await fetch189AppConf({ jar, lt, reqId, appId });
  const returnUrl = toStr(conf.returnUrl).trim();
  const paramId = toStr(conf.paramId).trim();
  if (!returnUrl || !paramId) throw new Error('tianyi login: missing paramId/returnUrl');

  const encUserHex = rsaEncryptToHexUpper(rsaKey, user);
  const encPassHex = rsaEncryptToHexUpper(rsaKey, pass);
  const prefix = pre || '{RSA}';
  const encUser = `${prefix}${encUserHex}`;
  const encPass = `${prefix}${encPassHex}`;

  // 2) Submit login.
  const submitUrl = `${TIANYI_AUTH_BASE}/api/logbox/oauth2/loginSubmit.do`;
  const form = {
    appKey: appId,
    version: 'v2.0',
    apToken: '',
    accountType: toStr(conf.accountType).trim() || '01',
    userName: encUser,
    password: encPass,
    validateCode: '',
    captchaToken: '',
    returnUrl,
    mailSuffix: toStr(conf.mailSuffix).trim() || '@189.cn',
    paramId,
    dynamicCheck: 'FALSE',
    clientType: String(conf.clientType || 10020),
    cb_SaveName: '3',
    isOauth2: String(!!conf.isOauth2),
    state: '',
  };
  const cookieHeader = cookieJarToHeader(jar);
  const { res: submitRes, text: submitText } = await fetchWithCookieJar(submitUrl, {
    jar,
    method: 'POST',
    headers: {
      'User-Agent': TIANYI_UA,
      Referer: TIANYI_AUTH_BASE,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Encoding': 'identity',
      ...(lt ? { Lt: lt } : {}),
      ...(reqId ? { Reqid: reqId } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: toFormUrlEncoded(form),
  });

  let submitJson = null;
  try {
    submitJson = submitText && submitText.trim() ? JSON.parse(submitText) : null;
  } catch (_) {
    submitJson = null;
  }
  if (!submitRes.ok || !submitJson || typeof submitJson !== 'object') {
    throw new Error(`tianyi loginSubmit failed: http ${submitRes.status}`);
  }
  const result = Object.prototype.hasOwnProperty.call(submitJson, 'result') ? Number(submitJson.result) : NaN;
  if (result !== 0) {
    const msg = toStr(submitJson.msg || submitJson.message || 'login failed').trim();
    throw new Error(`tianyi login failed: ${msg || String(submitJson.result)}`);
  }
  const toUrl = toStr(submitJson.toUrl).trim();
  if (!toUrl) throw new Error('tianyi login failed: empty toUrl');

  // 3) Follow redirect to set final cookies.
  await followRedirectsWithCookieJar(toUrl, { jar, headers: { 'User-Agent': TIANYI_UA, 'Accept-Encoding': 'identity' } });

  const cookie = cookieJarToHeader(jar);
  if (!cookie) throw new Error('tianyi login failed: empty cookie');
  return { cookie, jar };
}

let tianyiLoginInFlight = null;

async function ensure189Cookie({ forceRefresh = false } = {}) {
  const cfg = read189AccountFromConfig();
  const existing = toStr(cfg.cookie).trim();
  if (!forceRefresh && existing) return { cookie: existing, refreshed: false };

  const username = toStr(cfg.username).trim();
  const password = toStr(cfg.password);
  if (!username || !password) {
    if (forceRefresh && !existing) throw new Error('missing 189 username/password (and no existing cookie)');
    return { cookie: existing, refreshed: false, missingCred: true };
  }

  if (!tianyiLoginInFlight) {
    tianyiLoginInFlight = (async () => {
      try {
        const out = await login189WithPassword({ username, password });
        const cookie = toStr(out.cookie).trim();
        if (!cookie) throw new Error('empty cookie after login');

        // Persist cookie to config.json under account["189"].cookie
        try {
          const runtimeRoot = resolveRuntimeRootDir();
          const cfgPath = path.resolve(runtimeRoot, 'config.json');
          const cfgRoot = readConfigJsonSafe(cfgPath) || {};
          const next = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? { ...cfgRoot } : {};
          const account =
            next.account && typeof next.account === 'object' && next.account && !Array.isArray(next.account) ? { ...next.account } : {};
          const prev =
            account['189'] && typeof account['189'] === 'object' && account['189'] && !Array.isArray(account['189'])
              ? { ...account['189'] }
              : {};
          prev.cookie = cookie;
          account['189'] = prev;
          next.account = account;
          writeJsonFileAtomic(cfgPath, next);
        } catch (_) {}
        return cookie;
      } finally {
        tianyiLoginInFlight = null;
      }
    })();
  }
  const cookie = await tianyiLoginInFlight;
  return { cookie, refreshed: true };
}

function parsePlayId(id) {
  const raw = toStr(id).trim();
  // Tianyi ids used by the spider: `<fileId>*<shareId>*<fileName?>`
  if (!raw) return { shareId: '', fileId: '', fileName: '' };
  const parts = raw.split('*');
  const fileId = toStr(parts[0]).trim();
  const shareId = toStr(parts[1]).trim();
  const fileName = parts.length >= 3 ? parts.slice(2).join('*').trim() : '';
  return { shareId, fileId, fileName };
}

function normalizeBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function buildUrl(pathname, query) {
  const u = new URL(String(pathname || ''), TIANYI_API_BASE);
  const q = query && typeof query === 'object' ? query : {};
  for (const [k, v] of Object.entries(q)) {
    const vv = toStr(v).trim();
    if (vv !== '') u.searchParams.set(k, vv);
  }
  return u.toString();
}

async function tianyiGetShareInfoByCode({ shareCode, accessCode, cookie }) {
  const url = buildUrl('/api/open/share/getShareInfoByCodeV2.action', {
    key: 'noCache',
    shareCode,
    ...(accessCode ? { accessCode } : {}),
  });
  return await fetchTianyiJson(url, {
    method: 'GET',
    headers: buildTianyiHeaders({ cookie, referer: `https://cloud.189.cn/t/${toStr(shareCode).trim()}` }),
  });
}

function pickTianyiResCode(resp) {
  const r = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp : null;
  if (!r) return { code: null, msg: '' };
  const codeRaw =
    Object.prototype.hasOwnProperty.call(r, 'res_code')
      ? r.res_code
      : Object.prototype.hasOwnProperty.call(r, 'resCode')
        ? r.resCode
        : Object.prototype.hasOwnProperty.call(r, 'code')
          ? r.code
          : null;
  const msgRaw =
    Object.prototype.hasOwnProperty.call(r, 'res_message')
      ? r.res_message
      : Object.prototype.hasOwnProperty.call(r, 'resMessage')
        ? r.resMessage
        : Object.prototype.hasOwnProperty.call(r, 'message')
          ? r.message
          : '';
  const code = Number.isFinite(Number(codeRaw)) ? Math.trunc(Number(codeRaw)) : codeRaw == null ? null : String(codeRaw);
  const msg = toStr(msgRaw).trim();
  return { code, msg };
}

function assertTianyiOk(resp, ctx) {
  const { code, msg } = pickTianyiResCode(resp);
  if (code === null) return;
  if (code === 0 || code === '0') return;
  const err = new Error(`${toStr(ctx).trim() || 'tianyi'}: ${msg || 'request failed'} (${String(code)})`);
  err.body = resp;
  err.res_code = code;
  err.res_message = msg;
  throw err;
}

function isTianyiSessionExpiredError(err) {
  const m = toStr(err && err.message).toLowerCase();
  if (!m) return false;
  return m.includes('invalidsessionkey') || m.includes('usersessionbo is null') || m.includes('session expired');
}

async function tianyiListShareDir({ shareId, fileId, shareMode, pageNum, pageSize, orderBy, descending, accessCode, cookie }) {
  const fid = toStr(fileId || '0').trim() || '0';
  const desc = typeof descending === 'boolean' ? (descending ? 'true' : 'false') : toStr(descending || 'true');
  const url = buildUrl('/api/open/share/listShareDir.action', {
    key: 'noCache',
    noCache: String(Math.random()),
    shareId,
    fileId: fid,
    shareDirFileId: fid,
    isFolder: 'true',
    iconOption: '5',
    shareMode: toStr(shareMode || '3').trim() || '3',
    pageNum: toStr(pageNum || '1').trim() || '1',
    pageSize: toStr(pageSize || '60').trim() || '60',
    orderBy: toStr(orderBy || 'lastOpTime').trim() || 'lastOpTime',
    descending: desc,
    ...(accessCode ? { accessCode } : {}),
  });
  return await fetchTianyiJson(url, {
    method: 'GET',
    headers: buildTianyiHeaders({ cookie, referer: 'https://cloud.189.cn/' }),
  });
}

async function tianyiGetFileDownloadUrl({ shareId, fileId, dt, accessCode, cookie }) {
  const url = buildUrl('/api/open/file/getFileDownloadUrl.action', {
    shareId,
    fileId,
    dt: toStr(dt || '1').trim() || '1',
    ...(accessCode ? { accessCode } : {}),
  });
  return await fetchTianyiJson(url, {
    method: 'GET',
    headers: buildTianyiHeaders({ cookie, referer: 'https://cloud.189.cn/' }),
  });
}

function extractFirstUrlFromTianyiDownloadResp(respData) {
  const d = respData && typeof respData === 'object' ? respData : null;
  if (!d) return '';
  const data = d.data && typeof d.data === 'object' ? d.data : d;
  const candidates = [
    data && data.fileDownloadUrl,
    data && data.downloadUrl,
    data && data.url,
    data && data.fileDownloadUrlHttp,
    data && data.fileDownloadUrlHttps,
  ];
  for (const c of candidates) {
    const s = toStr(c).trim();
    if (s) return s;
  }
  return '';
}

export const apiPlugins = [
  {
    prefix: '/api/189',
    plugin: async function pan189Api(instance) {
      instance.post('/share/info', async (req, reply) => {
        const body = normalizeBody(req && req.body);
        const shareCode = toStr(body.shareCode || body.code || body.share_code).trim();
        const accessCode = toStr(body.accessCode || body.passcode || body.pwd || body.password).trim();
        if (!shareCode) return reply.code(400).send({ ok: false, message: 'missing shareCode' });

        try {
          const ensured = await ensure189Cookie();
          const cookie = toStr(ensured.cookie).trim();
          const out = await tianyiGetShareInfoByCode({ shareCode, accessCode, cookie });
          assertTianyiOk(out.data, 'tianyi share info');
          return { ok: true, shareCode, info: out.data, rawText: out.text };
        } catch (e) {
          return reply.code(502).send({ ok: false, message: (e && e.message) || String(e) });
        }
      });

      instance.post('/share/list', async (req, reply) => {
        const body = normalizeBody(req && req.body);
        const shareId = toStr(body.shareId || body.share_id).trim();
        const fileId = toStr(body.fileId || body.file_id || body.pdir_fid || '0').trim() || '0';
        const accessCode = toStr(body.accessCode || body.passcode || body.pwd || body.password).trim();
        if (!shareId) return reply.code(400).send({ ok: false, message: 'missing shareId' });

        try {
          const ensured = await ensure189Cookie();
          const cookie = toStr(ensured.cookie).trim();
          const out = await tianyiListShareDir({
            shareId,
            fileId,
            shareMode: body.shareMode,
            pageNum: body.pageNum,
            pageSize: body.pageSize,
            orderBy: body.orderBy,
            descending: body.descending,
            accessCode,
            cookie,
          });
          assertTianyiOk(out.data, 'tianyi share list');
          return { ok: true, shareId, fileId, detail: out.data, rawText: out.text };
        } catch (e) {
          return reply.code(502).send({ ok: false, message: (e && e.message) || String(e) });
        }
      });

      instance.post('/file/download', async (req, reply) => {
        const body = normalizeBody(req && req.body);
        const shareId = toStr(body.shareId || body.share_id).trim();
        const fileId = toStr(body.fileId || body.file_id).trim();
        const accessCode = toStr(body.accessCode || body.passcode || body.pwd || body.password).trim();
        if (!shareId) return reply.code(400).send({ ok: false, message: 'missing shareId' });
        if (!fileId) return reply.code(400).send({ ok: false, message: 'missing fileId' });

        try {
          let ensured = await ensure189Cookie();
          let cookie = toStr(ensured.cookie).trim();
          if (!cookie && ensured && ensured.missingCred) {
            return reply.code(400).send({ ok: false, message: 'missing 189 cookie; set account["189"].cookie or account["189"].username/password in config.json' });
          }
          let out;
          try {
            out = await tianyiGetFileDownloadUrl({ shareId, fileId, dt: body.dt, accessCode, cookie });
            assertTianyiOk(out.data, 'tianyi file download');
          } catch (e) {
            if (isTianyiSessionExpiredError(e)) {
              ensured = await ensure189Cookie({ forceRefresh: true });
              cookie = toStr(ensured.cookie).trim();
              out = await tianyiGetFileDownloadUrl({ shareId, fileId, dt: body.dt, accessCode, cookie });
              assertTianyiOk(out.data, 'tianyi file download');
            } else {
              throw e;
            }
          }
          const url0 = extractFirstUrlFromTianyiDownloadResp(out.data);
          if (!url0) return reply.code(502).send({ ok: false, message: 'empty download url', data: out.data, rawText: out.text });
          const url = url0 ? await resolveFinalUrl(url0) : '';
          return { ok: true, shareId, fileId, url, data: out.data, rawText: out.text };
        } catch (e) {
          return reply.code(502).send({ ok: false, message: (e && e.message) || String(e) });
        }
      });

      instance.post('/play', async (req, reply) => {
        const body = normalizeBody(req && req.body);
        const id = toStr(body.id || '').trim();
        const parsed = parsePlayId(id);
        const shareId = toStr(body.shareId || body.share_id || parsed.shareId).trim();
        const fileId = toStr(body.fileId || body.file_id || parsed.fileId).trim();
        const accessCode = toStr(body.accessCode || body.passcode || body.pwd || body.password).trim();

        if (!shareId) return reply.code(400).send({ ok: false, message: 'missing shareId (from id/shareId)' });
        if (!fileId) return reply.code(400).send({ ok: false, message: 'missing fileId (from id/fileId)' });

        try {
          let ensured = await ensure189Cookie();
          let cookie = toStr(ensured.cookie).trim();
          if (!cookie && ensured && ensured.missingCred) {
            return reply.code(400).send({ ok: false, message: 'missing 189 cookie; set account["189"].cookie or account["189"].username/password in config.json' });
          }
          let out;
          try {
            out = await tianyiGetFileDownloadUrl({ shareId, fileId, dt: body.dt, accessCode, cookie });
            assertTianyiOk(out.data, 'tianyi play');
          } catch (e) {
            if (isTianyiSessionExpiredError(e)) {
              ensured = await ensure189Cookie({ forceRefresh: true });
              cookie = toStr(ensured.cookie).trim();
              out = await tianyiGetFileDownloadUrl({ shareId, fileId, dt: body.dt, accessCode, cookie });
              assertTianyiOk(out.data, 'tianyi play');
            } else {
              throw e;
            }
          }
          let url = extractFirstUrlFromTianyiDownloadResp(out.data);
          if (!url) return reply.code(502).send({ ok: false, message: 'empty download url', data: out.data, rawText: out.text });
          url = await resolveFinalUrl(url);
          return {
            ok: true,
            parse: 0,
            url,
            shareId,
            fileId,
            fileName: parsed.fileName,
          };
        } catch (e) {
          return reply.code(502).send({ ok: false, message: (e && e.message) || String(e) });
        }
      });
    },
  },
];

export default apiPlugins;

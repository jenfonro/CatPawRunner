// 139Yun (移动云盘/和彩云) OutLink API.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const OUTLINK_API_BASE = 'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/';

const KEY_OUTLINK_STR = 'PVGDwmcvfs1uV3d1';
const KEY_OUTLINK = Buffer.from(KEY_OUTLINK_STR, 'utf8');

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_X_DEVICEINFO =
    '||9|12.27.0|chrome|143.0.0.0|pda50460feabd10141fb59a3ba787afb||windows 10|1624X1305|zh-CN|||';

const OUTLINK_X_DEVICEINFO_SHARE =
    '||3|12.27.0|chrome|131.0.0.0|5c7c68368f048245e1ce47f1c0f8f2d0||windows 10|1536X695|zh-CN|||';

function toStr(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeBase64Input(value) {
    let s = toStr(value).trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '');
    if (s.includes('-') || s.includes('_')) s = s.replace(/-/g, '+').replace(/_/g, '/');
    const mod = s.length % 4;
    if (mod === 2) s += '==';
    else if (mod === 3) s += '=';
    return s;
}

function aesCbcEncryptBase64(keyBuf, plainText) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', keyBuf, iv);
    const out = Buffer.concat([cipher.update(Buffer.from(toStr(plainText), 'utf8')), cipher.final()]);
    return Buffer.concat([iv, out]).toString('base64');
}

function aesCbcDecryptBase64(keyBuf, b64Text) {
    const raw = Buffer.from(normalizeBase64Input(b64Text), 'base64');
    if (raw.length < 17) throw new Error('ciphertext too short');
    const iv = raw.subarray(0, 16);
    const ct = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    return out.toString('utf8');
}

function md5HexLower(input) {
    return crypto.createHash('md5').update(Buffer.from(toStr(input), 'utf8')).digest('hex');
}

function calMcloudSign(plainJsonBody, ts, randStr) {
    const encoded = encodeURIComponent(toStr(plainJsonBody));
    const chars = encoded.split('');
    chars.sort();
    const sorted = chars.join('');
    const bodyB64 = Buffer.from(sorted, 'utf8').toString('base64');
    const res = md5HexLower(bodyB64) + md5HexLower(`${toStr(ts)}:${toStr(randStr)}`);
    return md5HexLower(res).toUpperCase();
}

function randomAlphaNum(len) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const n = Number.isFinite(Number(len)) ? Math.max(0, Number(len)) : 0;
    if (!n) return '';
    const bytes = crypto.randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

function formatChinaTimestamp() {
    const ms = Date.now();
    const d = new Date(ms + 8 * 60 * 60 * 1000);
    const pad = (v) => String(v).padStart(2, '0');
    const y = d.getUTCFullYear();
    const m = pad(d.getUTCMonth() + 1);
    const day = pad(d.getUTCDate());
    const hh = pad(d.getUTCHours());
    const mm = pad(d.getUTCMinutes());
    const ss = pad(d.getUTCSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function stripBasicPrefix(value) {
    const s = toStr(value).trim();
    if (!s) return '';
    return s.replace(/^basic\s+/i, '').trim();
}

function decodeAccountFromAuthorization(authorization) {
    const tokenRaw = stripBasicPrefix(authorization);
    const token = normalizeBase64Input(tokenRaw);
    if (!tokenRaw) return '';

    const parseDecoded = (decodedStr) => {
        const decoded = toStr(decodedStr);
        const parts = decoded.split(':');
        return parts && parts.length >= 3 ? toStr(parts[1]).trim() : '';
    };

    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const account = parseDecoded(decoded);
        if (account) return account;
    } catch (_) {}
    return parseDecoded(tokenRaw);
}

function resolveRuntimeRootDir() {
    try {
        if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
            return path.dirname(process.execPath);
        }
    } catch (_) {}
    const p = typeof process.env.NODE_PATH === 'string' && process.env.NODE_PATH.trim() ? process.env.NODE_PATH.trim() : '';
    return p ? path.resolve(p) : process.cwd();
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

async function get139Authorization(instance) {
    try {
        const runtimeRoot = resolveRuntimeRootDir();
        const cfgPath = path.resolve(runtimeRoot, 'config.json');
        const cfgRoot = readConfigJsonSafe(cfgPath);
        const account = cfgRoot && typeof cfgRoot.account === 'object' && cfgRoot.account && !Array.isArray(cfgRoot.account) ? cfgRoot.account : {};
        const p139 = account && typeof account['139'] === 'object' && account['139'] && !Array.isArray(account['139']) ? account['139'] : {};
        const v = typeof p139.authorization === 'string' ? p139.authorization : '';
        return v.trim();
    } catch (_) {}
    return '';
}

function buildMcloudHeaders({ authorization, bodyForSign }) {
    const ts = formatChinaTimestamp();
    const randStr = randomAlphaNum(16);
    const sign = calMcloudSign(toStr(bodyForSign), ts, randStr);

    return {
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Authorization: `Basic ${stripBasicPrefix(authorization)}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'Hcy-Cool-Flag': '1',
        'Mcloud-Sign': `${ts},${randStr},${sign}`,
        Origin: 'https://yun.139.com',
        Referer: 'https://yun.139.com/',
        'User-Agent': DEFAULT_UA,
        'X-Deviceinfo': DEFAULT_X_DEVICEINFO,
    };
}

function buildOutlinkAnonHeaders(linkID = '') {
    return {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'hcy-cool-flag': '1',
        'x-deviceinfo': OUTLINK_X_DEVICEINFO_SHARE,
        ...(toStr(linkID).trim() ? { Referer: `https://caiyun.139.com/w/i/${toStr(linkID).trim()}` } : {}),
    };
}

function fetchText(urlStr, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : {};
    const body = opts.body != null ? opts.body : undefined;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(100, Math.trunc(Number(opts.timeoutMs))) : 15000;

    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(String(urlStr || ''));
        } catch (e) {
            reject(e);
            return;
        }

        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(
            {
                method,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: `${u.pathname || '/'}${u.search || ''}`,
                headers,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const h = res ? res.headers || {} : {};
                    const enc = toStr(h['content-encoding'] || h['Content-Encoding'] || '').trim().toLowerCase();
                    const done = (outBuf) => {
                        const text = Buffer.isBuffer(outBuf) ? outBuf.toString('utf8') : buf.toString('utf8');
                        resolve({
                            status: res ? Number(res.statusCode || 0) : 0,
                            ok: res ? res.statusCode >= 200 && res.statusCode < 300 : false,
                            headers: h,
                            text,
                            url: urlStr,
                        });
                    };

                    if (enc === 'gzip') {
                        zlib.gunzip(buf, (err, outBuf) => (err ? done(buf) : done(outBuf)));
                        return;
                    }
                    if (enc === 'deflate') {
                        zlib.inflate(buf, (err, outBuf) => (err ? done(buf) : done(outBuf)));
                        return;
                    }
                    if (enc === 'br') {
                        zlib.brotliDecompress(buf, (err, outBuf) => (err ? done(buf) : done(outBuf)));
                        return;
                    }
                    done(buf);
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            try {
                req.destroy(new Error('timeout'));
            } catch (_) {}
        });
        if (body !== undefined) req.end(body);
        else req.end();
    });
}

function decryptOutlinkResponse(rawText) {
    const raw = toStr(rawText).trim();
    if (!raw) return { rawText: '', decrypted: '', parsed: null };
    let b64 = raw;
    try {
        const maybe = JSON.parse(raw);
        if (typeof maybe === 'string') b64 = maybe;
    } catch (_) {}
    let decrypted = '';
    try {
        decrypted = aesCbcDecryptBase64(KEY_OUTLINK, b64);
    } catch (_) {
        decrypted = raw;
    }
    let parsed = null;
    try {
        parsed = decrypted && decrypted.trim() ? JSON.parse(decrypted) : null;
    } catch (_) {
        parsed = null;
    }
    return { rawText: raw, decrypted, parsed };
}

function isOutlinkSuccessCode(code) {
    const c = toStr(code).trim();
    if (!c) return true;
    return c === '0' || c.toLowerCase() === 'success' || c === '200';
}

function pickOutlinkError(parsed) {
    const root = parsed && typeof parsed === 'object' ? parsed : null;
    if (!root) return null;
    const code = root.code ?? root.resultCode ?? root.result_code ?? root.errcode ?? root.errorCode;
    const desc = root.desc ?? root.message ?? root.msg ?? root.errorMessage ?? root.errmsg;
    if (isOutlinkSuccessCode(code)) return null;
    const d = toStr(desc).trim();
    return { code: toStr(code).trim() || 'error', desc: d || 'request failed', raw: root };
}

function toFriendlyOutlinkErrorMessage(err) {
    const code = err && typeof err === 'object' ? toStr(err.code).trim() : 'error';
    const desc = err && typeof err === 'object' ? toStr(err.desc).trim() : '';
    if (/浏览次数.*上限|达到.*次数.*上限|次数.*上限/.test(desc)) return `${code}: 分享已达到浏览次数上限`;
    if (/来晚了/.test(desc)) return `${code}: ${desc}`;
    return desc ? `${code}: ${desc}` : toStr(code || 'failed');
}

function makeOutlinkError(err) {
    const e = new Error(toFriendlyOutlinkErrorMessage(err));
    e.name = 'OutlinkError';
    e.code = err && typeof err === 'object' ? toStr(err.code).trim() : '';
    e.desc = err && typeof err === 'object' ? toStr(err.desc).trim() : '';
    e.raw = err && typeof err === 'object' ? err.raw : null;
    return e;
}

function pickRedrUrl(parsed) {
    const data = parsed && typeof parsed === 'object' ? parsed.data : null;
    const b = data && typeof data === 'object' ? data : parsed;
    if (!b || typeof b !== 'object') return '';
    const tryKeys = ['redrUrl', 'redrUrlNew', 'downloadUrl', 'url', 'dlUrl'];
    for (const k of tryKeys) {
        const v = b && typeof b[k] === 'string' ? b[k] : '';
        if (v && v.trim().startsWith('http')) return v.trim();
    }
    return '';
}

function normalizeRequestBody(body) {
    if (body == null) return {};
    if (typeof body === 'string') {
        try {
            return body.trim() ? JSON.parse(body) : {};
        } catch (_) {
            return {};
        }
    }
    if (typeof body !== 'object' || Array.isArray(body)) return {};
    return body;
}

function parseLinkIDFromFlag(flag) {
    const s = toStr(flag).trim();
    if (!s) return '';
    const byPrefix = s.match(/(?:逸动|yidong)[-_ ]*([a-zA-Z0-9]+)/i);
    if (byPrefix && byPrefix[1]) return byPrefix[1];
    const byUrl =
        /(?:\/w\/i\/|\?linkID=|\/m\/i\/?|\/shareweb\/#.*?\/w\/i\/)([\w]+)(?=[\/#?]|$)/.exec(s) ||
        /https:\/\/caiyun\.139\.com\/m\/i\?([^&]+)/.exec(s);
    if (byUrl) return toStr(byUrl[1]).trim();
    return '';
}

function parsePlayId(idStr) {
    const raw = toStr(idStr).trim();
    if (!raw) return { linkID: '', contentId: '', coID: '' };
    if (!raw.includes('|') && raw.includes('*')) {
        const parts = raw.split('*');
        const contentId = toStr(parts[0] || '').trim();
        const linkID = toStr(parts[1] || '').trim();
        return { linkID, contentId, coID: '' };
    }
    const parts = raw.split('|');
    const linkID = parts[0] || '';
    const contentId = parts[1] || '';
    const coID = parts[2] || '';
    return { linkID, contentId, coID };
}

async function outlinkDlFromOutLinkV3Signed({ linkID, contentId, coID, authorization }) {
    const auth = stripBasicPrefix(authorization);
    if (!auth) throw new Error('missing authorization');
    const account = decodeAccountFromAuthorization(auth);
    if (!account) throw new Error('authorization invalid (missing account)');

    const buildPayload = (useCoID) => {
        const co = toStr(coID || '').trim();
        if (useCoID && co) {
            return {
                dlFromOutLinkReqV3: { account, linkID: toStr(linkID), coIDLst: { item: [co] } },
                commonAccountInfo: { account, accountType: 1 },
            };
        }
        return {
            dlFromOutLinkReq: { contentId: toStr(contentId), linkID: toStr(linkID), account },
            commonAccountInfo: { account, accountType: 1 },
        };
    };

    const tryOnce = async (useCoID) => {
        const payload = buildPayload(useCoID);
        const plain = JSON.stringify(payload);
        const enc = aesCbcEncryptBase64(KEY_OUTLINK, plain);
        const body = JSON.stringify(enc);
        const headers = buildMcloudHeaders({ authorization: auth, bodyForSign: plain });
        const url = `${OUTLINK_API_BASE}dlFromOutLinkV3`;

        const resp = await fetchText(url, { method: 'POST', headers, body });
        const decoded = decryptOutlinkResponse(resp.text);
        const parsed = decoded.parsed;
        const urlOut = pickRedrUrl(parsed);
        return { resp, parsed, url: urlOut, rawText: decoded.rawText, decrypted: decoded.decrypted };
    };

    const first = await tryOnce(true);
    if (first.url) return first;
    const code = first.parsed && (first.parsed.code || first.parsed.resultCode);
    if (String(code) === '9530') return tryOnce(false);
    return first;
}

const OUTLINK_CACHE = {
    infoByKey: new Map(),
};

async function getOutLinkInfoV6({ linkID, pCaID, bNum = 1, eNum = 200 }) {
    const ca = toStr(pCaID ?? '').trim();
    const bn = Number.isFinite(Number(bNum)) ? Math.max(1, Math.trunc(Number(bNum))) : 1;
    const en = Number.isFinite(Number(eNum)) ? Math.max(1, Math.trunc(Number(eNum))) : 200;
    const key = `${toStr(linkID).trim()}-${ca}-${bn}-${en}`;
    if (OUTLINK_CACHE.infoByKey.has(key)) {
        const cached = OUTLINK_CACHE.infoByKey.get(key);
        if (cached && typeof cached === 'object' && cached.__error) throw makeOutlinkError(cached);
        return cached;
    }

    const payload = {
        getOutLinkInfoReq: {
            account: '',
            linkID: toStr(linkID),
            passwd: '',
            caSrt: 0,
            coSrt: 0,
            srtDr: 1,
            bNum: bn,
            pCaID: ca,
            eNum: en,
        },
        commonAccountInfo: { account: '', accountType: 1 },
    };
    const plain = JSON.stringify(payload);
    const enc = aesCbcEncryptBase64(KEY_OUTLINK, plain);
    const body = JSON.stringify(enc);
    const headers = buildOutlinkAnonHeaders(linkID);
    const url = `${OUTLINK_API_BASE}getOutLinkInfoV6`;

    try {
        const resp = await fetchText(url, { method: 'POST', headers, body });
        if (!resp || !resp.ok) {
            OUTLINK_CACHE.infoByKey.set(key, null);
            return null;
        }
        const decoded = decryptOutlinkResponse(resp.text);
        const root = decoded.parsed && typeof decoded.parsed === 'object' ? decoded.parsed : null;
        const err = pickOutlinkError(root);
        if (err) {
            OUTLINK_CACHE.infoByKey.set(key, { __error: true, ...err });
            throw makeOutlinkError(err);
        }
        const data = root && typeof root.data === 'object' && root.data ? root.data : null;
        OUTLINK_CACHE.infoByKey.set(key, data);
        return data;
    } catch (e) {
        if (e && typeof e === 'object' && e.name === 'OutlinkError') throw e;
        OUTLINK_CACHE.infoByKey.set(key, null);
        return null;
    }
}

function pickListArray(node, keys) {
    const n = node && typeof node === 'object' ? node : null;
    if (!n) return [];
    for (const k of Array.isArray(keys) ? keys : []) {
        const v = n[k];
        if (Array.isArray(v)) return v;
    }
    return [];
}

function pickCoId(item) {
    const it = item && typeof item === 'object' ? item : null;
    if (!it) return '';
    return toStr(it.coID || it.coId || it.contentId || it.contentID || it.id || it.ID).trim();
}

function pickCaPath(item) {
    const it = item && typeof item === 'object' ? item : null;
    if (!it) return '';
    return toStr(it.path || it.caPath || it.caID || it.caId || it.pCaID || it.pCaId || it.id).trim();
}

function updatePagingCollectorForDir(pagingCollector, pCaID, pageResult) {
    const pg = ensurePagingCollector(pagingCollector);
    const dirId = toStr(pCaID).trim() || 'root';

    if (pageResult && pageResult.truncated) {
        pg.truncated = true;
        if (!pg.truncatedDirs.some((x) => x && x.pCaID === dirId)) {
            pg.truncatedDirs.push({ pCaID: dirId, pagesFetched: pageResult.pagesFetched, eNum: pageResult.eNum });
        }
    }

    if (pageResult && pageResult.suspect) {
        pg.suspect = true;
        if (!pg.suspectDirs.some((x) => x && x.pCaID === dirId)) {
            pg.suspectDirs.push({
                pCaID: dirId,
                pagesFetched: pageResult.pagesFetched,
                eNum: pageResult.eNum,
                reason: toStr(pageResult.suspectReason || 'pagination may not be effective'),
            });
        }
    }
}

async function getOutLinkInfoV6AllPages({ linkID, pCaID, eNum = 200, maxPages = 50 }) {
    const en = Number.isFinite(Number(eNum)) ? Math.max(1, Math.trunc(Number(eNum))) : 200;
    const mp = Number.isFinite(Number(maxPages)) ? Math.max(1, Math.trunc(Number(maxPages))) : 50;
    const caAll = [];
    const coAll = [];

    let pagesFetched = 0;
    let truncated = false;
    let suspect = false;
    let suspectReason = '';

    const seenCo = new Set();
    const seenCa = new Set();
    let lastSignature = '';

    for (let bn = 1; bn <= mp; bn += 1) {
        pagesFetched = bn;
        const data = await getOutLinkInfoV6({ linkID, pCaID, bNum: bn, eNum: en });
        if (!data || typeof data !== 'object') break;

        const ca = pickListArray(data, ['caLst']);
        const co = pickListArray(data, ['coLst']);

        if (ca.length === 0 && co.length === 0) break;

        let newItems = 0;
        const sigParts = [];
        for (const it of co) {
            const id = pickCoId(it);
            if (!id) continue;
            if (!seenCo.has(id)) {
                seenCo.add(id);
                newItems += 1;
            }
            if (sigParts.length < 16) sigParts.push(`co:${id}`);
        }
        for (const it of ca) {
            const id = pickCaPath(it);
            if (!id) continue;
            if (!seenCa.has(id)) {
                seenCa.add(id);
                newItems += 1;
            }
            if (sigParts.length < 16) sigParts.push(`ca:${id}`);
        }
        const signature = sigParts.join('|');
        if (bn > 1) {
            if (newItems === 0) {
                suspect = true;
                suspectReason = 'no new items across pages (pagination may be ignored or repeating)';
                break;
            }
            if (signature && signature === lastSignature) {
                suspect = true;
                suspectReason = 'repeated page signature (pagination may be ignored or repeating)';
                break;
            }
        }
        lastSignature = signature;

        caAll.push(...ca);
        coAll.push(...co);

        const maybeHasNext = ca.length >= en || co.length >= en;
        if (!maybeHasNext) break;
        if (bn === mp) truncated = true;
    }

    return { caLst: caAll, coLst: coAll, eNum: en, pagesFetched, truncated, suspect, suspectReason };
}

async function getShareFile({ linkID, pCaID }) {
    if (!pCaID) return null;
    const ca = toStr(pCaID).trim();
    const all = await getOutLinkInfoV6AllPages({ linkID, pCaID: ca.startsWith('http') ? 'root' : ca });
    const i = Array.isArray(all && all.caLst) ? all.caLst : [];
    if (i.length === 0) return null;
    const a = Array.isArray(i) ? i.map((x) => x && x.caName) : [];
    const s = Array.isArray(i) ? i.map((x) => x && x.path) : [];
    const c = /App|活动中心|免费|1T空间|免流/;
    const u = [];
    if (Array.isArray(i) && i.length > 0) {
        a.forEach((d, l) => {
            if (!d || c.test(toStr(d))) return;
            const path = toStr(s[l] || '').trim();
            if (!path) return;
            u.push({ name: toStr(d), path });
        });
        let x = await Promise.all(s.map(async (d) => getShareFile({ linkID, pCaID: d })));
        x = x.filter((d) => d != null);
        return [...u, ...x.flat()];
    }
    return null;
}

function ensurePagingCollector(input) {
    const out =
        input && typeof input === 'object' && !Array.isArray(input)
            ? input
            : { eNum: 200, maxPages: 50, truncated: false, suspect: false, scannedDirs: 0, truncatedDirs: [], suspectDirs: [] };
    if (!Number.isFinite(Number(out.eNum))) out.eNum = 200;
    if (!Number.isFinite(Number(out.maxPages))) out.maxPages = 50;
    if (typeof out.truncated !== 'boolean') out.truncated = false;
    if (typeof out.suspect !== 'boolean') out.suspect = false;
    if (!Number.isFinite(Number(out.scannedDirs))) out.scannedDirs = 0;
    if (!Array.isArray(out.truncatedDirs)) out.truncatedDirs = [];
    if (!Array.isArray(out.suspectDirs)) out.suspectDirs = [];
    return out;
}

function formatDirPath(dirParts) {
    const parts = Array.isArray(dirParts) ? dirParts.map((x) => toStr(x).trim()).filter(Boolean) : [];
    return parts.length === 0 ? '/' : parts.join('/');
}

async function resolveLogicalRootDir({ linkID, pCaID, paging }) {
    const pg = ensurePagingCollector(paging);
    const removed = [];
    let current = toStr(pCaID).trim() || 'root';

    if (current !== 'root') return { pCaID: current, removed };

    for (let i = 0; i < 10; i += 1) {
        const all = await getOutLinkInfoV6AllPages({ linkID, pCaID: current, eNum: pg.eNum, maxPages: pg.maxPages });
        updatePagingCollectorForDir(pg, current, all);
        pg.scannedDirs += 1;

        const co = Array.isArray(all && all.coLst) ? all.coLst : [];
        const ca = Array.isArray(all && all.caLst) ? all.caLst : [];

        const files = co.filter((x) => x && x.coType === 3);
        const dirs = ca.filter((x) => x && toStr(x.path).trim());

        if (files.length === 0 && dirs.length === 1) {
            removed.push(toStr(dirs[0].caName).trim() || '');
            current = toStr(dirs[0].path).trim();
            continue;
        }
        break;
    }

    return { pCaID: current, removed: removed.filter(Boolean) };
}

async function collectShareFilesRecursive({ linkID, pCaID, dirParts, paging }) {
    const pg = ensurePagingCollector(paging);
    const caId = toStr(pCaID).trim() || 'root';
    const parts = Array.isArray(dirParts) ? dirParts : [];

    const all = await getOutLinkInfoV6AllPages({ linkID, pCaID: caId, eNum: pg.eNum, maxPages: pg.maxPages });
    updatePagingCollectorForDir(pg, caId, all);
    pg.scannedDirs += 1;

    const out = [];
    const co = Array.isArray(all && all.coLst) ? all.coLst : [];
    for (const it of co) {
        if (!it || it.coType !== 3) continue;
        out.push({
            name: toStr(it.coName),
            contentId: toStr(it.coID),
            linkID: toStr(linkID),
            size: it.coSize,
            pCaID: caId,
            dirPath: formatDirPath(parts),
        });
    }

    const ca = Array.isArray(all && all.caLst) ? all.caLst : [];
    const children = ca
        .map((x) => ({
            name: toStr(x && x.caName).trim(),
            path: toStr(x && x.path).trim(),
        }))
        .filter((x) => x.path);

    if (children.length > 0) {
        const nested = await Promise.all(
            children.map(async (c) =>
                collectShareFilesRecursive({ linkID, pCaID: c.path, dirParts: [...parts, c.name || c.path], paging: pg })
            )
        );
        for (const arr of nested) if (Array.isArray(arr) && arr.length > 0) out.push(...arr);
    }

    return out;
}

async function getShareUrl({ linkID, pCaID, paging }) {
    const pagingCollector = ensurePagingCollector(paging);
    const all = await getOutLinkInfoV6AllPages({
        linkID,
        pCaID,
        eNum: pagingCollector.eNum,
        maxPages: pagingCollector.maxPages,
    });
    const t = all && typeof all === 'object' ? all : null;
    if (!t) return null;
    pagingCollector.scannedDirs += 1;
    updatePagingCollectorForDir(pagingCollector, pCaID, t);
    const out = [];
    const o = Array.isArray(t.coLst) ? t.coLst : [];
    if (Array.isArray(o) && o.length > 0) {
        out.push(
            ...o
                .filter((a) => a && a.coType === 3)
                .map((a) => ({
                    name: toStr(a.coName),
                    contentId: toStr(a.coID),
                    linkID: toStr(linkID),
                    size: a.coSize,
                    pCaID: toStr(pCaID),
                }))
        );
    }
    if (Array.isArray(t.caLst) && t.caLst.length > 0) {
        const i = t.caLst.map((s) => (s && s.path ? toStr(s.path).trim() : '')).filter(Boolean);
        let a = await Promise.all(i.map((s) => getShareUrl({ linkID, pCaID: s, paging: pagingCollector })));
        a = a.filter((s) => Array.isArray(s) && s.length > 0);
        out.push(...a.flat());
    }
    return out;
}

async function outlinkGetContentInfoFromOutLink({ linkID, contentId }) {
    const payload = {
        getContentInfoFromOutLinkReq: { contentId: toStr(contentId), linkID: toStr(linkID), account: '' },
        commonAccountInfo: { account: '', accountType: 1 },
    };
    const body = JSON.stringify(payload);
    const headers = {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': 'application/json',
    };
    const url = `${OUTLINK_API_BASE}getContentInfoFromOutLink`;
    const parseResp = (text) => {
        try {
            return text && text.trim() ? JSON.parse(text) : null;
        } catch (_) {
            return null;
        }
    };

    let resp = await fetchText(url, { method: 'POST', headers, body });
    if (!resp || !resp.ok) return { ok: false, url: '', rawText: resp ? resp.text : '' };
    let parsed = parseResp(resp.text);
    if (!parsed) {
        const enc = toStr(resp.headers && (resp.headers['content-encoding'] || resp.headers['Content-Encoding'])).trim().toLowerCase();
        if (enc === 'zstd') {
            const headers2 = { ...headers, 'Accept-Encoding': 'identity' };
            resp = await fetchText(url, { method: 'POST', headers: headers2, body });
            if (!resp || !resp.ok) return { ok: false, url: '', rawText: resp ? resp.text : '' };
            parsed = parseResp(resp.text);
        }
    }
    const present =
        toStr(parsed && parsed.data && parsed.data.contentInfo && (parsed.data.contentInfo.presentURL || parsed.data.contentInfo.presentUrl)).trim() ||
        '';
    return { ok: Boolean(present), url: present, rawText: resp.text || '', parsed };
}

export const apiPlugins = [
    {
        prefix: '/api/139',
        plugin: async function pan139Api(instance) {
            instance.post('/list', async (req, reply) => {
                const body = normalizeRequestBody(req && req.body);
                const flag = toStr(body.flag || '').trim();
                const linkID = toStr(body.linkID || body.linkId || parseLinkIDFromFlag(flag)).trim();
                if (!linkID) {
                    reply.code(400);
                    return { ok: false, message: 'missing/invalid flag (expected: 逸动-<linkID>)' };
                }
                try {
                    const pCaID0 = toStr(body.pCaID || body.pcaid || body.caID || body.caId || '').trim() || 'root';

                    const paging = ensurePagingCollector({
                        eNum: 200,
                        maxPages: 50,
                        truncated: false,
                        suspect: false,
                        scannedDirs: 0,
                        truncatedDirs: [],
                        suspectDirs: [],
                    });

                    const logical = await resolveLogicalRootDir({ linkID, pCaID: pCaID0, paging });
                    const startCaID = toStr((logical && logical.pCaID) || pCaID0).trim() || 'root';
                    const removedWrappers = Array.isArray(logical && logical.removed) ? logical.removed : [];

                    const files = await collectShareFilesRecursive({ linkID, pCaID: startCaID, dirParts: [], paging });
                    const list = Array.isArray(files)
                        ? files.map((c) => ({
                              vod_name: toStr(c && c.dirPath) || '/',
                              vod_id: `${toStr(c && c.contentId)}*${toStr(c && c.linkID)}***${toStr(c && c.name)}`,
                              vod_size: c && c.size,
                              pCaID: toStr(c && c.pCaID),
                              dirPath: toStr(c && c.dirPath),
                              fileName: toStr(c && c.name),
                          }))
                        : [];
                    const parts = [];
                    for (const it of list) {
                        const n = toStr(it && it.vod_name).trim();
                        const vid = toStr(it && it.vod_id).trim();
                        if (!n || !vid) continue;
                        parts.push(`${n}$${vid}`);
                    }
                    return { ok: true, vod_play_url: parts.join('#') };
                } catch (e) {
                    reply.code(502);
                    return { ok: false, message: (e && e.message) || String(e) };
                }
            });

            instance.post('/play', async (req, reply) => {
                const body = normalizeRequestBody(req && req.body);
                const flag = toStr(body.flag || '').trim();
                const id = toStr(body.id || '').trim();
                const wantRaw = toStr(body.want || body.type || '').trim().toLowerCase();
                const want = wantRaw || 'download_url'; // default: prefer direct download url
                if (!id) {
                    reply.code(400);
                    return { ok: false, message: 'missing id' };
                }
                if (want !== 'download_url' && want !== 'play_url') {
                    reply.code(400);
                    return { ok: false, message: 'invalid want (expected: download_url|play_url)' };
                }

                const parsed = parsePlayId(id);
                const linkID = toStr(parsed.linkID || parseLinkIDFromFlag(flag)).trim();
                const contentId = toStr(parsed.contentId).trim();
                const coID = toStr(parsed.coID).trim();
                const isStarId = id.includes('*') && !id.includes('|');

                if (!linkID) {
                    reply.code(400);
                    return { ok: false, message: 'missing linkID (from id/flag)' };
                }
                if (!contentId && !coID) {
                    reply.code(400);
                    return { ok: false, message: 'missing contentId/coID (from id)' };
                }

                try {
                    if (want === 'play_url') {
                        if (!contentId) {
                            reply.code(400);
                            return { ok: false, message: 'want=play_url requires contentId (expected id: <coID>*<linkID>)' };
                        }
                        const trans = await outlinkGetContentInfoFromOutLink({ linkID, contentId });
                        const url = toStr(trans && trans.url).trim();
                        if (!url) {
                            reply.code(502);
                            return { ok: false, message: 'play url unavailable' };
                        }
                        return { ok: true, url };
                    }

                    const authorization = await get139Authorization(instance);
                    const auth = stripBasicPrefix(authorization);
                    const canSigned = Boolean(decodeAccountFromAuthorization(auth));
                    if (!canSigned) {
                        reply.code(400);
                        return { ok: false, message: 'missing authorization' };
                    }
                    const dl =
                        isStarId && contentId && !coID
                            ? await outlinkDlFromOutLinkV3Signed({ linkID, contentId: '', coID: contentId, authorization })
                            : await outlinkDlFromOutLinkV3Signed({ linkID, contentId, coID, authorization });
                    const url = toStr(dl && dl.url).trim();
                    if (!url) {
                        reply.code(502);
                        return { ok: false, message: 'download url unavailable' };
                    }
                    return { ok: true, url };
                } catch (e) {
                    reply.code(502);
                    return { ok: false, message: (e && e.message) || String(e) };
                }
            });
        },
    },
];

export default apiPlugins;

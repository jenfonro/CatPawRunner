// 139Yun (移动云盘/和彩云) OutLink API.
// Endpoints:
// - POST /api/139/list (0119.js-style anonymous share listing)
// - POST /api/139/play (direct link + optional transcode link)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const OUTLINK_API_BASE = 'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/';

// AES-128-CBC key (16 bytes). IV is randomly generated per request and is prepended to ciphertext.
const KEY_OUTLINK_STR = 'PVGDwmcvfs1uV3d1';
const KEY_OUTLINK = Buffer.from(KEY_OUTLINK_STR, 'utf8');

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// X-Deviceinfo format matters; the version number does not. Keep a known-good value.
const DEFAULT_X_DEVICEINFO =
    '||9|12.27.0|chrome|143.0.0.0|pda50460feabd10141fb59a3ba787afb||windows 10|1624X1305|zh-CN|||';

// config/0119.js uses this value for anonymous OutLink list requests.
const OUTLINK_0119_X_DEVICEINFO =
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
    // Compatible with OpenList-style sign behavior.
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

    // base64("xxx:<account>:<token...>")
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const account = parseDecoded(decoded);
        if (account) return account;
    } catch (_) {}

    // Some callers may persist decoded form directly.
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
    // Persisted in config.json (main process runtime root) under:
    // { account: { "139": { authorization: "..." } } }
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

function buildOutlinkAnonHeaders() {
    // Mirrors config/0119.js headers: no Authorization/Mcloud-Sign.
    return {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'hcy-cool-flag': '1',
        'x-deviceinfo': OUTLINK_0119_X_DEVICEINFO,
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
                    // Unknown enc (e.g. zstd) -> best-effort as utf8.
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
    // Examples: "逸动-xxxxx" / "逸动 xxxx"
    const s = toStr(flag).trim();
    if (!s) return '';
    const m = s.match(/(?:逸动|yidong)[-_ ]*([a-zA-Z0-9]+)/i);
    return m && m[1] ? m[1] : '';
}

function parsePlayId(idStr) {
    const raw = toStr(idStr).trim();
    if (!raw) return { linkID: '', contentId: '', coID: '' };
    // 0119.js-style: "<contentId>*<linkID>"
    if (!raw.includes('|') && raw.includes('*')) {
        const parts = raw.split('*');
        const contentId = toStr(parts[0] || '').trim();
        const linkID = toStr(parts[1] || '').trim();
        return { linkID, contentId, coID: '' };
    }
    // Format: linkID|contentId|coID|filename...
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

const OUTLINK_0119_CACHE = {
    // key: `${linkID}-${pCaID}` -> data object (or null)
    infoByKey: new Map(),
};

async function getOutLinkInfoV6_0119({ linkID, pCaID }) {
    const ca = toStr(pCaID ?? '').trim();
    const key = `${toStr(linkID).trim()}-${ca}`;
    if (OUTLINK_0119_CACHE.infoByKey.has(key)) return OUTLINK_0119_CACHE.infoByKey.get(key);

    const payload = {
        getOutLinkInfoReq: {
            account: '',
            linkID: toStr(linkID),
            passwd: '',
            caSrt: 0,
            coSrt: 0,
            srtDr: 1,
            bNum: 1,
            pCaID: ca,
            eNum: 200,
        },
        commonAccountInfo: { account: '', accountType: 1 },
    };
    const plain = JSON.stringify(payload);
    const enc = aesCbcEncryptBase64(KEY_OUTLINK, plain);
    const body = JSON.stringify(enc);
    const headers = buildOutlinkAnonHeaders();
    const url = `${OUTLINK_API_BASE}getOutLinkInfoV6`;

    try {
        const resp = await fetchText(url, { method: 'POST', headers, body });
        if (!resp || !resp.ok) {
            OUTLINK_0119_CACHE.infoByKey.set(key, null);
            return null;
        }
        const decoded = decryptOutlinkResponse(resp.text);
        const root = decoded.parsed && typeof decoded.parsed === 'object' ? decoded.parsed : null;
        const data = root && typeof root.data === 'object' && root.data ? root.data : null;
        OUTLINK_0119_CACHE.infoByKey.set(key, data);
        return data;
    } catch (_) {
        OUTLINK_0119_CACHE.infoByKey.set(key, null);
        return null;
    }
}

async function getShareFile_0119({ linkID, pCaID }) {
    if (!pCaID) return null;
    const ca = toStr(pCaID).trim();
    try {
        const o = await getOutLinkInfoV6_0119({ linkID, pCaID: ca.startsWith('http') ? 'root' : ca });
        if (!o || !o.caLst) return null;
        const i = o.caLst;
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
            let x = await Promise.all(s.map(async (d) => getShareFile_0119({ linkID, pCaID: d })));
            x = x.filter((d) => d != null);
            return [...u, ...x.flat()];
        }
    } catch (_) {}
    return null;
}

async function getShareUrl_0119({ linkID, pCaID }) {
    try {
        const t = await getOutLinkInfoV6_0119({ linkID, pCaID });
        if (!t || typeof t !== 'object' || !('coLst' in t)) return null;
        const o = t.coLst;
        if (o !== null) {
            return Array.isArray(o)
                ? o
                      .filter((a) => a && a.coType === 3)
                      .map((a) => ({
                          name: toStr(a.coName),
                          contentId: toStr(a.coID),
                          linkID: toStr(linkID),
                          size: a.coSize,
                      }))
                : [];
        }
        if (t.caLst !== null) {
            const i = Array.isArray(t.caLst) ? t.caLst.map((s) => s && s.path) : [];
            let a = await Promise.all(i.map((s) => getShareUrl_0119({ linkID, pCaID: s })));
            a = a.filter((s) => s && s.length > 0);
            return a.flat();
        }
    } catch (_) {}
    return null;
}

async function outlinkGetContentInfoFromOutLink_0119({ linkID, contentId }) {
    const payload = {
        getContentInfoFromOutLinkReq: { contentId: toStr(contentId), linkID: toStr(linkID), account: '' },
        commonAccountInfo: { account: '', accountType: 1 },
    };
    const body = JSON.stringify(payload);
    const headers = {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json, text/plain, */*',
        // 0119.js sets this; we can handle gzip/deflate/br, unknown (zstd) falls back to raw.
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
        // If server picked zstd (or other unsupported encoding), retry with identity encoding.
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
            // List OutLink root files and return 0119-style `vod_play_url`.
            // Input: { flag: "逸动-<linkID>" }  Output: { ok, vod_play_url }
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

                    const data = {};
                    const folders = await getShareFile_0119({ linkID, pCaID: pCaID0 });
                    if (folders && Array.isArray(folders)) {
                        await Promise.all(
                            folders.map(async (s) => {
                                if (!s || typeof s !== 'object') return;
                                const name = toStr(s.name).trim();
                                const path = toStr(s.path).trim();
                                if (!name || !path) return;
                                if (!(name in data)) data[name] = [];
                                const c = await getShareUrl_0119({ linkID, pCaID: path });
                                if (c && c.length > 0) data[name].push(...c);
                            })
                        );
                    }

                    for (const k of Object.keys(data)) if (!Array.isArray(data[k]) || data[k].length === 0) delete data[k];

                    if (Object.keys(data).length === 0) {
                        // Keep 0119.js behavior (even though it may return empty for shares without caLst).
                        data.root = (await getShareFile_0119({ linkID, pCaID: pCaID0 })) || [];
                        if (Array.isArray(data.root)) data.root = data.root.filter((s) => s && Object.keys(s).length > 0);
                    }

                    // 0119.js-style vod_id: "<contentId>*<linkID>"
                    for (const k of Object.keys(data)) {
                        if (!Array.isArray(data[k])) continue;
                        data[k] = data[k].map((c) => ({
                            vod_name: toStr(c && c.name),
                            vod_id: `${toStr(c && c.contentId)}*${toStr(c && c.linkID)}`,
                            vod_size: c && c.size,
                        }));
                    }

                    const parts = [];
                    for (const k of Object.keys(data)) {
                        const arr = Array.isArray(data[k]) ? data[k] : [];
                        for (const it of arr) {
                            const n = toStr(it && it.vod_name).trim();
                            const id = toStr(it && it.vod_id).trim();
                            if (!n || !id) continue;
                            parts.push(`${n}$${id}`);
                        }
                    }

                    return { ok: true, vod_play_url: parts.join('#'), data };
                } catch (e) {
                    reply.code(502);
                    return { ok: false, message: (e && e.message) || String(e) };
                }
            });

            instance.post('/play', async (req, reply) => {
                const body = normalizeRequestBody(req && req.body);
                const flag = toStr(body.flag || '').trim();
                const id = toStr(body.id || '').trim();
                if (!id) {
                    reply.code(400);
                    return { ok: false, message: 'missing id' };
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
                    // For 0119.js-style id ("contentId*linkID"):
                    // - `url` is the direct download link (signed dlFromOutLinkV3)
                    if (contentId && !coID && isStarId) {
                        const trans = await outlinkGetContentInfoFromOutLink_0119({ linkID, contentId });
                        const play_url = toStr(trans && trans.url).trim();

                        const authorization = await get139Authorization(instance);
                        // In 0119.js list, "contentId" is actually `coID` from `coLst`.
                        const dl = await outlinkDlFromOutLinkV3Signed({ linkID, contentId: '', coID: contentId, authorization });
                        if (!dl.url) {
                            const code = dl.parsed && (dl.parsed.code || dl.parsed.resultCode);
                            const desc = dl.parsed && (dl.parsed.desc || dl.parsed.message);
                            reply.code(502);
                            return {
                                ok: false,
                                message: desc ? `${toStr(code || 'error')}: ${toStr(desc)}` : toStr(code || 'failed'),
                                raw: dl.rawText || '',
                                play_url,
                            };
                        }

                        return {
                            ok: true,
                            parse: 0,
                            url: dl.url,
                            downloadUrl: dl.url,
                            play_url,
                            playUrl: play_url || dl.url,
                        };
                    }

                    // Legacy id formats (with coID etc): keep signed dlFromOutLinkV3 behavior.
                    const authorization = await get139Authorization(instance);
                    const out = await outlinkDlFromOutLinkV3Signed({ linkID, contentId, coID, authorization });
                    if (!out.url) {
                        const code = out.parsed && (out.parsed.code || out.parsed.resultCode);
                        const desc = out.parsed && (out.parsed.desc || out.parsed.message);
                        reply.code(502);
                        return {
                            ok: false,
                            message: desc ? `${toStr(code || 'error')}: ${toStr(desc)}` : toStr(code || 'failed'),
                            raw: out.rawText || '',
                        };
                    }
                    return { ok: true, parse: 0, url: out.url, playUrl: out.url, downloadUrl: out.url };
                } catch (e) {
                    reply.code(502);
                    return { ok: false, message: (e && e.message) || String(e) };
                }
            });
        },
    },
];

export default apiPlugins;

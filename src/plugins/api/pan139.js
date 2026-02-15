// 139Yun (移动云盘/和彩云) OutLink play API.
// Keep only: POST /api/139/play

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const OUTLINK_API_BASE = 'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/';

// AES-128-CBC key (16 bytes). IV is randomly generated per request and is prepended to ciphertext.
const KEY_OUTLINK_STR = 'PVGDwmcvfs1uV3d1';
const KEY_OUTLINK = Buffer.from(KEY_OUTLINK_STR, 'utf8');

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// X-Deviceinfo format matters; the version number does not. Keep a known-good value.
const DEFAULT_X_DEVICEINFO =
    '||9|12.27.0|chrome|143.0.0.0|pda50460feabd10141fb59a3ba787afb||windows 10|1624X1305|zh-CN|||';

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
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        status: res ? Number(res.statusCode || 0) : 0,
                        ok: res ? res.statusCode >= 200 && res.statusCode < 300 : false,
                        headers: res ? res.headers || {} : {},
                        text,
                        url: urlStr,
                    });
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
    // Format: linkID|contentId|coID|filename...
    const parts = raw.split('|');
    const linkID = parts[0] || '';
    const contentId = parts[1] || '';
    const coID = parts[2] || '';
    return { linkID, contentId, coID };
}

async function getOutLinkInfoV6Signed({ linkID, pCaID, authorization }) {
    const auth = stripBasicPrefix(authorization);
    if (!auth) throw new Error('missing authorization');
    const account = decodeAccountFromAuthorization(auth);
    if (!account) throw new Error('authorization invalid (missing account)');

    const payload = {
        getOutLinkInfoReq: { account, linkID: toStr(linkID), pCaID: toStr(pCaID || '') },
        commonAccountInfo: { account, accountType: 1 },
    };
    const plain = JSON.stringify(payload);
    const enc = aesCbcEncryptBase64(KEY_OUTLINK, plain);
    const body = JSON.stringify(enc);
    const headers = buildMcloudHeaders({ authorization: auth, bodyForSign: plain });
    const url = `${OUTLINK_API_BASE}getOutLinkInfoV6`;

    const resp = await fetchText(url, { method: 'POST', headers, body });
    const decoded = decryptOutlinkResponse(resp.text);
    return { resp, parsed: decoded.parsed, rawText: decoded.rawText, decrypted: decoded.decrypted };
}

function pickOutlinkCoList(parsed) {
    const p = parsed && typeof parsed === 'object' ? parsed : null;
    const data = p && typeof p.data === 'object' && p.data ? p.data : null;
    const list = (data && (data.coLst || data.co_list || data.list)) || (p && (p.coLst || p.list)) || [];
    if (Array.isArray(list)) return list;
    if (list && typeof list === 'object' && Array.isArray(list.item)) return list.item;
    return [];
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
                    const authorization = await get139Authorization(instance);
                    const out = await getOutLinkInfoV6Signed({ linkID, pCaID: '', authorization });
                    const parsed = out.parsed;
                    const code = parsed && (parsed.code ?? parsed.resultCode);
                    if (String(code) !== '0') {
                        const desc = parsed && (parsed.desc || parsed.message);
                        reply.code(502);
                        return { ok: false, message: desc ? `${toStr(code || 'error')}: ${toStr(desc)}` : toStr(code || 'failed') };
                    }

                    const coLst = pickOutlinkCoList(parsed);
                    const parts = [];
                    for (const it of coLst) {
                        if (!it || typeof it !== 'object') continue;
                        const name = toStr(it.coName || it.name || it.fileName || '').trim();
                        const coID = toStr(it.coID || it.coId || it.id || '').trim();
                        if (!name || !coID) continue;
                        const id = `${linkID}||${coID}|${name}`;
                        parts.push(`${name}$${id}`);
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
                if (!id) {
                    reply.code(400);
                    return { ok: false, message: 'missing id' };
                }

                const parsed = parsePlayId(id);
                const linkID = toStr(parsed.linkID || parseLinkIDFromFlag(flag)).trim();
                const contentId = toStr(parsed.contentId).trim();
                const coID = toStr(parsed.coID).trim();

                if (!linkID) {
                    reply.code(400);
                    return { ok: false, message: 'missing linkID (from id/flag)' };
                }
                if (!contentId && !coID) {
                    reply.code(400);
                    return { ok: false, message: 'missing contentId/coID (from id)' };
                }

                try {
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

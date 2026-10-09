import { rewritePanmockDetailPayloadFields } from './panmockDetailCodec.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';

// This is the existing client contract, not a new MeowFilm-specific protocol.
// Native episode IDs are opaque: never translate them into a different
// provider's file ID. The original flag must reach the native /play unchanged.
const nativeRequest = (body) => body;
const legacyNativeFlagPrefix = '原生-';
const panLabels = {
    quark: '夸父',
    uc: '优夕',
    baidu: '百度原画',
    pan189: '天意',
    new139: '逸动',
};

export function parseSpiderOperation(forwardPath) {
    const match = /^\/spider\/[^/]+\/\d+\/(home|category|search|detail|play)(?:\?|$)/i.exec(String(forwardPath || ''));
    return match ? match[1].toLowerCase() : '';
}

function mapDetail(payload, panMock, mockFields, nativeFields) {
    if (!Array.isArray(payload.list)) return payload;
    const next = { ...payload, pan_mock: !!panMock };
    const rewriteFields = panMock ? mockFields : nativeFields;
    if (!rewriteFields) return next;
    next.list = payload.list.map((vod) => isObject(vod)
        ? { ...vod, ...rewriteFields(vod.vod_play_from, vod.vod_play_url) }
        : vod);
    return next;
}

function rewriteLegacyFlags(playFrom, panMock) {
    return String(playFrom || '').split('$$$').map((group) => group.split('|||').map((flag) => {
        const head = flag.includes('-') ? flag.split('-')[0] : '';
        // Existing clients classify these flags as builtin pan sources even
        // with pan_mock=false, discarding the native episode list. Escape the
        // flag (not the ID) and restore it on /play inside this same adapter.
        const clientPanFlag = ['夸父', '优夕', '逸动', '天意', '百度'].some((label) => head.includes(label));
        return flag.startsWith(legacyNativeFlagPrefix) || (!panMock && clientPanFlag)
            ? `${legacyNativeFlagPrefix}${flag}` : flag;
    }).join('|||')).join('$$$');
}

function legacyMockFields(playFrom, playURL) {
    const fields = rewritePanmockDetailPayloadFields(playFrom, playURL);
    return { ...fields, vod_play_from: rewriteLegacyFlags(fields.vod_play_from, true) };
}

function legacyNativeFields(playFrom, playURL) {
    return { vod_play_from: rewriteLegacyFlags(playFrom, false), vod_play_url: playURL };
}

function decodeNativeEpisode(value) {
    const id = text(value);
    // Bound decoding and require the declared protocol's actual shape. An
    // arbitrary URL, malformed Base64 or another script's ID is not a share.
    if (!id || id.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(id)) return null;
    try {
        const decoded = Buffer.from(id, 'base64');
        if (decoded.toString('base64').replace(/=+$/, '') !== id.replace(/=+$/, '')) return null;
        const item = JSON.parse(decoded.toString('utf8'));
        if (!isObject(item) || !text(item.providerId) || !text(item.shareId) || !text(item.fileId)) return null;
        let token = {};
        if (isObject(item.playToken)) token = item.playToken;
        else if (typeof item.playToken === 'string') {
            try {
                const parsed = JSON.parse(item.playToken);
                if (isObject(parsed)) token = parsed;
            } catch (_) {}
        }
        return { item, token };
    } catch (_) {
        return null;
    }
}

function cleanPasscode(value) {
    const candidate = text(value);
    return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : '';
}

function placeholderPasscode(name, provider, shareId) {
    const match = /([A-Za-z0-9_-]+)\.mp4\b/i.exec(text(name));
    if (!match) return '';
    let stem = match[1];
    if (provider === 'pan189') {
        // Both legacy "code-pass.MP4" and the native API's
        // "code_pass-nopass.MP4" placeholder can occur.
        if (stem === shareId) return '';
        if (stem.startsWith(`${shareId}-`) || stem.startsWith(`${shareId}_`)) {
            stem = stem.slice(shareId.length + 1).replace(/-(?:nopass|root\d*)$/i, '');
        } else return '';
    }
    return /^(?:nopass|root\d*)$/i.test(stem) ? '' : cleanPasscode(stem);
}

function nativeMockShare(decoded, title) {
    const { item, token } = decoded;
    const provider = item.providerId;
    const prefix = Object.prototype.hasOwnProperty.call(panLabels, provider) ? panLabels[provider] : '';
    const shareId = text(item.shareId);
    if (!prefix || !/^[A-Za-z0-9_-]{1,128}$/.test(shareId)) return null;
    if (provider === 'pan189' && !/^[A-Za-z0-9]{6,64}$/.test(shareId)) return null;
    // Baidu's numeric token.shareId is NOT its public /s/<id> identifier.
    // Tianyi likewise embeds a numeric internal share ID inside playToken.
    // Only the outer public shareId is suitable for the client list resolver.
    const explicitCodes = [token.passCode, token.passcode, token.pwd, token.accessCode]
        .filter((value) => typeof value === 'string');
    const passcode = explicitCodes.length
        ? explicitCodes.map(cleanPasscode).find(Boolean) || ''
        : placeholderPasscode(token.fileName || item.name || title, provider, shareId);
    return { flag: `${prefix}-${shareId}`, passcode };
}

export function rewritePanServiceMockDetailFields(playFrom, playURL) {
    const froms = String(playFrom || '').split('$$$');
    const urls = String(playURL || '').split('$$$');
    const nextFroms = [];
    const nextURLs = [];
    const shareIndexes = new Map();
    for (let i = 0; i < Math.max(froms.length, urls.length); i += 1) {
        const flag = froms[i] || '';
        const url = urls[i] || '';
        const episodes = url.split('#').filter((entry) => entry.trim());
        const shares = [];
        let compatible = episodes.length > 0;
        for (const episode of episodes) {
            const dollar = episode.indexOf('$');
            const decoded = dollar >= 0 ? decodeNativeEpisode(episode.slice(dollar + 1)) : null;
            const share = decoded ? nativeMockShare(decoded, episode.slice(0, dollar)) : null;
            if (!share) {
                compatible = false;
                break;
            }
            shares.push(share);
        }
        if (!compatible) {
            // Direct streams and providers without an existing client list
            // resolver (115/123/etc.) stay native, including their play IDs.
            nextFroms.push(flag);
            nextURLs.push(url);
            continue;
        }
        for (const share of shares) {
            // The client keys list requests by provider + flag, not password.
            // Keep distinct shares, but collapse quality variants of one share;
            // prefer the first non-empty access code over a no-pass placeholder.
            if (shareIndexes.has(share.flag)) {
                const index = shareIndexes.get(share.flag);
                if (!nextURLs[index] && share.passcode) nextURLs[index] = share.passcode;
                continue;
            }
            shareIndexes.set(share.flag, nextFroms.length);
            nextFroms.push(share.flag);
            nextURLs.push(share.passcode);
        }
    }
    return { vod_play_from: nextFroms.join('$$$'), vod_play_url: nextURLs.join('$$$') };
}

function normalizeNativePlay(payload) {
    // Both protocols already return parse/url/header. Keep all extension fields
    // (format, subtitles, watch reporting, URL choices) and accept headers alias.
    if (isObject(payload.headers) && !isObject(payload.header)) return { ...payload, header: payload.headers };
    return payload;
}

export const legacySpiderDataAdapter = {
    id: 'cat-open-v1',
    request(body, { operation } = {}) {
        if (operation === 'play' && isObject(body) && typeof body.flag === 'string' && body.flag.startsWith(legacyNativeFlagPrefix)) {
            return { ...body, flag: body.flag.slice(legacyNativeFlagPrefix.length) };
        }
        return body;
    },
    response(payload, { operation, panMock = false } = {}) {
        if (!isObject(payload)) return payload;
        return operation === 'detail'
            ? mapDetail(payload, panMock, legacyMockFields, legacyNativeFields)
            : payload;
    },
};

export const panServiceSpiderDataAdapter = {
    id: 'pan-service-v1',
    request: nativeRequest,
    response(payload, { operation, panMock = false } = {}) {
        if (!isObject(payload)) return payload;
        if (operation === 'detail') return mapDetail(payload, panMock, rewritePanServiceMockDetailFields);
        if (operation === 'play') return normalizeNativePlay(payload);
        return payload;
    },
};

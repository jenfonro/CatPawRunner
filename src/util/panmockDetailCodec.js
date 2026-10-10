function getPanmockDetailProviderKey(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    if (raw.startsWith('夸父-')) return 'quark';
    if (raw.startsWith('优夕-')) return 'uc';
    if (raw.startsWith('逸动-')) return '139';
    if (raw.startsWith('天意-')) return '189';
    if (raw.startsWith('百度原画-')) return 'baidu';
    return '';
}

function isPanmockDetailSource(label) {
    return !!getPanmockDetailProviderKey(label);
}

function sanitizePanmockSourceLabel(label) {
    const raw = String(label || '').trim();
    if (!raw) return '';
    if (raw.startsWith('百度原画-')) {
        return String(raw.split('#')[0] || '').trim();
    }
    return raw;
}

function normalizePanmockDetailText(raw) {
    try {
        return decodeURIComponent(String(raw || '').trim());
    } catch (_) {
        return String(raw || '').trim();
    }
}

function extractPanmockPlaceholderName(title, playURL) {
    const candidates = [title, playURL];
    for (const candidate of candidates) {
        const text = normalizePanmockDetailText(candidate);
        if (!text) continue;
        const mp4Match = text.match(/([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)?)\.(?:mp4|MP4)\b/);
        if (mp4Match && mp4Match[1]) return String(mp4Match[1]).trim();
        const rootMatch = text.match(/\b(root\d*)\b/i);
        if (rootMatch && rootMatch[1]) return String(rootMatch[1]).trim();
    }
    return '';
}

function extractPanmockDisplayPasscode(_label, title, playURL) {
    const placeholder = extractPanmockPlaceholderName(title, playURL);
    if (!placeholder) return '';
    const lower = placeholder.toLowerCase();
    if (lower === 'nopass' || lower === 'root' || /^root\d+$/.test(lower)) {
        return '';
    }
    return String(placeholder || '').trim();
}

function extractGenericPanmockMeta(label, title, playURL) {
    return {
        nextLabel: String(label || '').trim(),
        passcode: extractPanmockDisplayPasscode('', title, playURL),
    };
}

function extractTianyiPanmockMeta(label, title, playURL) {
    const placeholder = extractPanmockPlaceholderName(title, playURL);
    if (!placeholder) {
        return { nextLabel: String(label || '').trim(), passcode: '' };
    }
    let shareCode = '';
    let accessCodeRaw = '';
    const stem = String(placeholder || '').replace(/-(?:nopass|root\d*)$/i, '').trim();
    if (stem.includes('_')) {
        const splitIdx = stem.lastIndexOf('_');
        shareCode = String(stem.slice(0, splitIdx) || '').trim();
        accessCodeRaw = String(stem.slice(splitIdx + 1) || '').trim();
    } else if (placeholder.includes('-')) {
        const seg = placeholder.split('-');
        shareCode = String(seg[0] || '').trim();
        accessCodeRaw = String(seg.slice(1).join('-') || '').trim();
    } else {
        shareCode = String(stem || '').trim();
    }
    const accessLower = accessCodeRaw.toLowerCase();
    const passcode =
        !accessCodeRaw || accessLower === 'nopass' || accessLower === 'root' || /^root\d+$/.test(accessLower)
            ? ''
            : accessCodeRaw;
    let nextLabel = String(label || '').trim();
    if (shareCode && /^天意-root\d*$/i.test(nextLabel)) {
        nextLabel = `天意-${shareCode}`;
    }
    return { nextLabel, passcode };
}

const PANMOCK_DETAIL_CODECS = {
    quark: extractGenericPanmockMeta,
    uc: extractGenericPanmockMeta,
    '139': extractGenericPanmockMeta,
    baidu: extractGenericPanmockMeta,
    '189': extractTianyiPanmockMeta,
};

function rewritePanmockSourceByProvider(label, playURL) {
    const providerKey = getPanmockDetailProviderKey(label);
    const codec = providerKey ? PANMOCK_DETAIL_CODECS[providerKey] : null;
    if (typeof codec !== 'function') {
        return { playFrom: String(label || '').trim(), playURL: String(playURL || '').trim() };
    }
    const tabs = String(playURL || '').split('#');
    const byDisplay = new Map();
    for (let idx = 0; idx < tabs.length; idx += 1) {
        const chunk = String(tabs[idx] || '').trim();
        if (!chunk) continue;
        const splitIdx = chunk.indexOf('$');
        if (splitIdx < 0) continue;
        const title = String(chunk.slice(0, splitIdx) || '').trim();
        const urlPart = String(chunk.slice(splitIdx + 1) || '').trim();
        const meta = codec(label, title, urlPart);
        const nextLabel = String(meta && meta.nextLabel ? meta.nextLabel : label).trim();
        const displayTitle = String(meta && meta.passcode ? meta.passcode : '').trim();
        const dedupeKey = displayTitle ? displayTitle.toLowerCase() : '__empty__';
        const prev = byDisplay.get(dedupeKey);
        const next = { raw: displayTitle, hasPasscode: !!displayTitle, order: idx, label: nextLabel };
        if (!prev || (!prev.hasPasscode && next.hasPasscode)) {
            byDisplay.set(dedupeKey, next);
        }
    }
    const ordered = Array.from(byDisplay.values()).sort((a, b) => a.order - b.order);
    return {
        playFrom: String(ordered[0] && ordered[0].label ? ordered[0].label : label).trim(),
        playURL: ordered.map((item) => item.raw).join('#'),
    };
}

export function rewritePanmockDetailPayloadFields(playFrom, playURL) {
    const fromRaw = String(playFrom || '');
    const urlRaw = String(playURL || '');
    const fromParts = fromRaw.split('$$$');
    const urlParts = urlRaw.split('$$$');
    const total = Math.max(fromParts.length, urlParts.length);
    const nextFroms = [];
    const nextURLs = [];
    for (let i = 0; i < total; i += 1) {
        const label = sanitizePanmockSourceLabel(i < fromParts.length ? fromParts[i] : '');
        const urls = i < urlParts.length ? String(urlParts[i] || '') : '';
        if (!isPanmockDetailSource(label)) {
            nextFroms.push(label);
            nextURLs.push(urls);
            continue;
        }
        const rewritten = rewritePanmockSourceByProvider(label, urls);
        nextFroms.push(rewritten.playFrom);
        nextURLs.push(rewritten.playURL);
    }
    return {
        vod_play_from: nextFroms.join('$$$'),
        vod_play_url: nextURLs.join('$$$'),
    };
}

const PAN_NAMES = { baidu: '百度', quark: '夸克', uc: 'UC', '189': '天翼', '139': '移动' };
const clean = (value) => String(value == null ? '' : value).trim();
const validShareId = (value) => /^[A-Za-z0-9_-]{4,256}$/.test(value) && !/^(?:root\d*|nopass|share)$/i.test(value);

// Name matching is only a hint. A share URL/ID (or a captured request) is still
// required before removing a script's source or routing it to a built-in API.
export function getSupportedPanProvider(label) {
    // A share ID or password may itself contain provider text.
    const value = clean(label).split('-')[0].trim();
    if (/百度|baidu/i.test(value)) return 'baidu';
    if (/夸克|夸父|quark/i.test(value)) return 'quark';
    if (/优夕|(?:^|[^a-z])uc(?:$|[^a-z])/i.test(value)) return 'uc';
    if (/天翼|天意|tianyi|^(?:pan)?189$/i.test(value)) return '189';
    if (/移动|逸动|和彩云|云空间|caiyun|yun139|^(?:new)?139$/i.test(value)) return '139';
    return '';
}

export function parsePanShareURL(value, password = '') {
    const raw = clean(value);
    // Some resource cards append an explicit access code instead of using a
    // URL query. Extract it here before the script loses it during URL parsing.
    const annotated = /^(https?:\/\/[^\s（）()]+)\s*[（(]\s*(?:提取码|访问码|密码)\s*[:：]\s*([A-Za-z0-9]{1,16})\s*[）)]$/i.exec(raw);
    let url;
    try { url = new URL(annotated ? annotated[1] : raw); } catch (_) { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const q = url.searchParams;
    let provider = '';
    let shareId = '';
    const match = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (host === 'pan.baidu.com') {
        provider = 'baidu';
        shareId = match ? match[1].replace(/^1/, '') : clean(q.get('surl'));
    } else if (host === 'pan.quark.cn') {
        provider = 'quark';
        shareId = match ? match[1] : '';
    } else if (host === 'drive.uc.cn' || host === 'fast.uc.cn') {
        provider = 'uc';
        shareId = match ? match[1] : '';
    } else if (host === 'cloud.189.cn' || host === 'h5.cloud.189.cn') {
        provider = '189';
        shareId = (/^\/t\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname) || [])[1] || clean(q.get('code') || q.get('shareCode'));
    } else if (host === 'caiyun.139.com' || host === 'yun.139.com') {
        provider = '139';
        shareId = (/(?:^|#)\/(?:m\/i|w\/i)\/([A-Za-z0-9_-]+)(?:[/?]|$)/.exec(url.pathname + url.hash) || [])[1] ||
            clean(q.get('linkID') || q.get('linkId')) ||
            (/^\/m\/i\/?$/.test(url.pathname) ? (url.search.slice(1).split('&')[0] || '') : '');
    }
    if (!provider || !validShareId(shareId)) return null;
    const hashQuery = new URLSearchParams(url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '');
    const pwd = clean(password || q.get('pwd') || q.get('passcode') || q.get('accessCode') || q.get('password') || q.get('passwd') ||
        hashQuery.get('pwd') || hashQuery.get('passwd') || (annotated && annotated[2]));
    const bases = {
        baidu: 'https://pan.baidu.com/s/1', quark: 'https://pan.quark.cn/s/',
        uc: 'https://drive.uc.cn/s/', '189': 'https://cloud.189.cn/t/', '139': 'https://caiyun.139.com/m/i?',
    };
    const canonical = bases[provider] + shareId;
    return {
        provider, shareId, password: pwd, key: `${provider}:${shareId}`,
        flag: `${PAN_NAMES[provider]}-${shareId}` + (pwd ? `-${pwd}` : ''),
        url: canonical + (pwd ? `${provider === '139' ? '&' : '?'}${provider === '189' ? 'accessCode' : 'pwd'}=${encodeURIComponent(pwd)}` : ''),
    };
}

function shareFromId(provider, id, password = '', baiduShort = false) {
    const shareId = clean(id);
    if (!validShareId(shareId) || !PAN_NAMES[provider]) return null;
    const bases = {
        baidu: `https://pan.baidu.com/s/${baiduShort || !shareId.startsWith('1') ? '1' : ''}`,
        quark: 'https://pan.quark.cn/s/', uc: 'https://drive.uc.cn/s/',
        '189': 'https://cloud.189.cn/t/', '139': 'https://caiyun.139.com/m/i?',
    };
    return parsePanShareURL(bases[provider] + shareId, password);
}

export function decodeStructuredDetailId(value) {
    let raw = clean(value);
    if (!raw || raw.length > 65536) return null;
    try { raw = decodeURIComponent(raw); } catch (_) {}
    raw = raw.split(/\*\*\*|\|\|\|/)[0];
    const colon = raw.indexOf(':');
    if (colon > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(raw.slice(0, colon))) raw = raw.slice(colon + 1);
    try {
        const parsed = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
}

export function extractPanSharesFromSource(flag, group, { placeholders = false } = {}) {
    const found = new Map();
    const add = (share) => {
        if (share && !share.password) {
            const prefix = `${PAN_NAMES[share.provider]}-${share.shareId}-`;
            if (clean(flag).startsWith(prefix)) share = parsePanShareURL(share.url, clean(flag).slice(prefix.length));
        }
        if (share && (!found.has(share.key) || (!found.get(share.key).password && share.password))) found.set(share.key, share);
    };
    const directShare = parsePanShareURL(group);
    add(directShare);
    add(parsePanShareURL(flag));
    // A mobile share URL can contain a hash route; it is not an episode separator.
    if (directShare) return Array.from(found.values());
    const provider = getSupportedPanProvider(flag);
    const parts = clean(group).split('#');
    for (const part of parts) {
        const split = part.indexOf('$');
        const title = split >= 0 ? part.slice(0, split) : '';
        const id = split >= 0 ? part.slice(split + 1) : part;
        add(parsePanShareURL(id));
        const data = decodeStructuredDetailId(id);
        if (data) {
            add(parsePanShareURL(data.url || data.shareUrl || data.share_url, data.password || data.pwd || data.accessCode));
            const p = getSupportedPanProvider(data.providerId || data.provider) || provider;
            const pwd = data.password || data.pwd || data.passcode || data.accessCode || '';
            if (p === 'baidu' && data.surl) add(shareFromId(p, data.surl, pwd, true));
            else if (data.shareCode || (data.shareId && !(p === '189' && /^\d+$/.test(clean(data.shareId))))) {
                // Tianyi's internal numeric shareId is not a public shareCode.
                add(shareFromId(p, data.shareCode || data.shareId, pwd));
            }
        }
        // Legacy flags can carry share identity without a URL. Canonical labels
        // are descriptive; prefer the actual URL/full ID rather than guessing
        // where a share ID containing "-" ends and its optional password starts.
        const legacy = /^(夸父|优夕|逸动|天意|百度原画)-([^#]+)/.exec(clean(flag));
        if (legacy && provider) {
            let legacyId = legacy[2];
            let pwd = '';
            if (placeholders && split >= 0) {
                const meta = provider === '189'
                    ? extractTianyiPanmockMeta(flag, title, id)
                    : extractGenericPanmockMeta(flag, title, id);
                legacyId = clean(meta.nextLabel).replace(/^[^-]+-/, '');
                pwd = meta.passcode;
            } else if (split < 0 && clean(group) && !/[*$/:]/.test(group)) {
                pwd = clean(group);
            }
            add(shareFromId(provider, legacyId, pwd));
        }
        // Existing complete Quark/UC and Mobile IDs retain share identity.
        // Tianyi numeric share IDs are NOT share codes and cannot be used here.
        const tokens = id.split('*');
        if ((provider === 'quark' || provider === 'uc') && tokens.length >= 4) add(shareFromId(provider, tokens[0]));
        if (provider === '139' && tokens.length >= 3) add(shareFromId(provider, tokens[1]));
    }
    return Array.from(found.values());
}

export function isBuiltinPanPlayId(provider, value) {
    const id = clean(value);
    const parts = id.split('*');
    if (provider === 'baidu') {
        const data = decodeStructuredDetailId(id);
        return !!(data && data.surl && data.shareid && data.uk && data.fs_id && !data.providerId);
    }
    if (provider === 'quark' || provider === 'uc') return parts.length >= 4 && !!parts[0] && !!parts[1] && !!parts[2];
    if (provider === '139') return parts.length >= 3 && !!parts[0] && !!parts[1];
    if (provider === '189') return parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]);
    return false;
}

export function isDetailNavigationList(list, requestedId = '') {
    if (!Array.isArray(list) || !list.length) return false;
    if (list.some((item) => !item || !clean(item.vod_id) || clean(item.vod_play_url) || clean(item.vod_play_from))) return false;
    const decoded = list.map((item) => decodeStructuredDetailId(item.vod_id));
    const parents = decoded.map((item) => clean(item && (item.vodId || item.parentId || item.parent_id)));
    const requested = decodeStructuredDetailId(requestedId);
    const expectedParent = clean(requested && (requested.vodId || requested.parentId || requested.parent_id)) || clean(requestedId);
    const sameParent = parents[0] && parents.every((id) => id === parents[0]) &&
        (!expectedParent || parents[0] === expectedParent || list.length === 1);
    const explicit = list.every((item, index) => {
        const data = decoded[index];
        return !!(data && ['group', 'share'].includes(data.mode)) ||
            item.vod_tag === 'folder' || (item.style && item.style.type === 'list');
    });
    // Do not flatten ordinary multi-movie search/category results.
    return explicit && (list.length === 1 || !!sameParent);
}

export async function normalizePanDetailResponse(parsed, { panMock, requestedId = '', loadDetail, listShare, maxDepth = 5, maxRequests = 64 } = {}) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    const shares = new Map();
    const leaves = [];
    const diagnostics = [];
    const visited = new Set([clean(requestedId)].filter(Boolean));
    let requests = 0;
    let expanded = false;
    let base = null;
    const addShare = (share) => {
        if (!share) return;
        const old = shares.get(share.key);
        if (!old || (!old.password && share.password)) shares.set(share.key, share);
    };
    const collect = async (doc, depth, currentId) => {
        if (!doc || typeof doc !== 'object') return;
        const captured = Array.isArray(doc._catpaw_pan_shares) ? doc._catpaw_pan_shares : [];
        const capturedProviders = new Set(captured.map((item) => parsePanShareURL(item && item.url, item && item.password)?.provider).filter(Boolean));
        captured.forEach((item) => addShare(parsePanShareURL(item && item.url, item && item.password)));
        const list = Array.isArray(doc.list) ? doc.list : [];
        if (isDetailNavigationList(list, currentId)) {
            expanded = true;
            for (const item of list) {
                const data = decodeStructuredDetailId(item.vod_id);
                if (!base && data && data.meta && typeof data.meta === 'object') base = { ...data.meta };
                if (!base && data && data.vodId) {
                    base = { vod_id: data.vodId };
                    for (const key of ['name', 'pic', 'year', 'content', 'actor', 'director', 'area', 'type']) {
                        if (data[key] != null) base[`vod_${key}`] = data[key];
                    }
                }
                const direct = parsePanShareURL(item.vod_id) ||
                    (data && parsePanShareURL(data.url || data.shareUrl, data.password || data.pwd || data.accessCode));
                if (direct) {
                    if (!base && !data) base = { ...item };
                    addShare(direct);
                    continue;
                }
                const id = clean(item.vod_id);
                if (visited.has(id)) continue;
                if (depth >= maxDepth || requests >= maxRequests || typeof loadDetail !== 'function') {
                    diagnostics.push('详情导航超过解析上限');
                    continue;
                }
                visited.add(id);
                requests += 1;
                try { await collect(await loadDetail(id), depth + 1, id); }
                catch (error) { diagnostics.push(`${clean(item.vod_name) || '详情'}: ${clean(error && error.message)}`); }
            }
        } else {
            if (!base && list[0]) base = { ...list[0] };
            for (const item of list) {
                if (!item || typeof item !== 'object') continue;
                const flags = clean(item.vod_play_from).split('$$$');
                const groups = clean(item.vod_play_url).split('$$$');
                for (let i = 0; i < Math.max(flags.length, groups.length); i += 1) {
                    const flag = flags[i] || '';
                    const group = groups[i] || '';
                    if (!flag && !group) continue;
                    const inputs = extractPanSharesFromSource(flag, group, { placeholders: captured.length > 0 });
                    inputs.forEach(addShare);
                    const provider = getSupportedPanProvider(flag);
                    // Capture evidence belongs to this child detail, not every
                    // sibling navigation branch with a similar display name.
                    leaves.push({ flag, group, inputs, captured: capturedProviders.has(provider) });
                }
            }
        }
        if (doc.message) diagnostics.push(clean(doc.message));
    };
    // An ordinary multiple-item detail response is not permission to combine
    // separate movies. Normalize each independently without sharing captures.
    if (Array.isArray(parsed.list) && parsed.list.length > 1 && !isDetailNavigationList(parsed.list, requestedId)) {
        const items = [];
        for (const item of parsed.list) {
            // Only attach captures whose share identity is already present in
            // this item's fields. Unattributable request-wide captures must not
            // be assigned to another film.
            const flags = clean(item && item.vod_play_from).split('$$$');
            const groups = clean(item && item.vod_play_url).split('$$$');
            const keys = new Set(flags.flatMap((flag, i) => extractPanSharesFromSource(flag, groups[i], { placeholders: true })).map((share) => share.key));
            const captured = (parsed._catpaw_pan_shares || []).filter((entry) => keys.has(parsePanShareURL(entry && entry.url)?.key));
            const result = await normalizePanDetailResponse({ list: [item], _catpaw_pan_shares: captured }, { panMock, requestedId: item && item.vod_id, listShare });
            items.push(result.list[0]);
            if (result.message) diagnostics.push(result.message);
        }
        const { _catpaw_pan_shares, ...rest } = parsed;
        return { ...rest, pan_mock: !!panMock, list: items, ...(diagnostics.length ? { message: Array.from(new Set(diagnostics)).join('；') } : {}) };
    }
    await collect(parsed, 0, clean(requestedId));
    const inputs = Array.from(shares.values());
    const supported = new Array(inputs.length);
    let nextIndex = 0;
    // Bound concurrent provider requests without serialising a detail with
    // many independent shares. Existing list caches still coalesce duplicates.
    const resolveNext = async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++;
        const share = inputs[index];
        if (panMock) {
            supported[index] = { flag: share.flag, group: share.url };
        } else {
            try {
                const response = typeof listShare === 'function' ? await listShare(share) : null;
                const group = clean(response && response.vod_play_url);
                if (!response || response.ok === false || !group) throw new Error(clean(response && response.message) || '未获取到网盘文件列表');
                supported[index] = { flag: share.flag, group };
            } catch (error) {
                const message = clean(error && error.message);
                diagnostics.push(`${share.flag}: ${share.provider === 'baidu' && /errno\s*=\s*-9(?!\d)/i.test(message) ? '分享链接已失效' : message}`);
            }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, inputs.length) }, resolveNext));
    const native = leaves.filter((item) => !item.inputs.length && !item.captured);
    const groups = [...supported.filter(Boolean), ...native];
    const { _catpaw_pan_shares, ...rest } = parsed;
    const item = {
        ...(base || {}),
        ...(expanded && requestedId ? { vod_id: requestedId } : {}),
        vod_play_from: groups.map((entry) => entry.flag).join('$$$'),
        vod_play_url: groups.map((entry) => entry.group).join('$$$'),
    };
    // Navigation cards' list style/folder tag must not escape as the film detail.
    if (expanded) { delete item.style; delete item.vod_tag; }
    return {
        ...rest, pan_mock: !!panMock, list: base || groups.length ? [item] : [],
        ...(diagnostics.length ? { message: Array.from(new Set(diagnostics)).join('；').slice(0, 2000) } : {}),
    };
}

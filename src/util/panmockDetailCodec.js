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

function getDetailNavigationParent(data) {
    // Navigation payloads may retain the movie's original detail URL instead
    // of a vodId. This is still shared movie identity, not a provider/share URL.
    return clean(data && (data.vodId || data.parentId || data.parent_id || data.detailUrl));
}

// Describe a script navigation without following it. The original ID stays on
// the item; clients never need to decode an author's private ID representation.
export function getDetailNavigation(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !clean(item.vod_id) || clean(item.vod_play_url) || clean(item.vod_play_from)) return null;
    const data = decodeStructuredDetailId(item.vod_id);
    const declared = item.vod_navigation && typeof item.vod_navigation === 'object'
        ? item.vod_navigation : null;
    const explicit = item.action && typeof item.action === 'object' ? item.action : null;
    const share = parsePanShareURL(declared && declared.share_url) ||
        parsePanShareURL(item.share_url, item.password || item.pwd || item.passcode || item.accessCode) || parsePanShareURL(item.vod_id) ||
        (data && parsePanShareURL(data.url || data.shareUrl || data.share_url, data.password || data.pwd || data.passcode || data.accessCode));
    const args = (declared && declared.payload) || (explicit && explicit.payload);
    let action = clean((declared && declared.action) || (explicit && explicit.action) ||
        (typeof item.action === 'string' ? item.action : ''));
    // A generic UI action (copy/open/etc.) is not a script API. Custom operations
    // need an explicit navigation descriptor or action+payload, not just a name.
    if (action && !declared && !['detail', 'category'].includes(action) &&
        !(explicit && args && typeof args === 'object' && !Array.isArray(args))) return null;
    if (!action) {
        if (item.action || declared) return null;
        if (item.vod_tag === 'folder') action = 'category';
        else if (share || (data && ['group', 'share'].includes(data.mode))) action = 'detail';
    }
    if (!/^[a-z][a-z0-9_-]*$/i.test(action)) return null;
    const payload = args && typeof args === 'object' && !Array.isArray(args)
        ? { ...args } : { id: item.vod_id, ...(action === 'category' ? { page: 1 } : {}) };
    const provider = (share && share.provider) ||
        getSupportedPanProvider((data && (data.provider || data.providerId)) || item.vod_name);
    return {
        action, payload,
        ...(provider ? { provider } : {}),
        ...(share ? { share_url: share.url, share_flag: share.flag } : {}),
    };
}

export async function normalizePanDetailResponse(parsed, { panMock, listShare, requestedId = '' } = {}) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
    const { _catpaw_pan_shares, ...rest } = parsed;
    if (!Array.isArray(parsed.list)) return { ...rest, pan_mock: !!panMock };
    const diagnostics = [];
    const inputItems = [];
    const shareSlots = new Map();
    for (const item of parsed.list) {
        const nav = getDetailNavigation(item);
        const share = nav && parsePanShareURL(nav.share_url);
        if (share && shareSlots.has(share.key)) {
            const slot = shareSlots.get(share.key);
            const previous = parsePanShareURL(getDetailNavigation(inputItems[slot]).share_url);
            if (!previous.password && share.password) inputItems[slot] = item;
            continue;
        }
        if (share) shareSlots.set(share.key, inputItems.length);
        inputItems.push(item);
    }
    const items = await Promise.all(inputItems.map(async (item) => {
        // Preserve unknown upstream data, including null. Do not turn a schema
        // we cannot handle into a successful empty detail.
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const nav = getDetailNavigation(item);
        if (nav) {
            return {
                ...item,
                ...(!nav.share_url && nav.provider ? { vod_name: `${PAN_NAMES[nav.provider]}网盘` } : {}),
                vod_navigation: nav,
            };
        }
        const captures = Array.isArray(_catpaw_pan_shares) ? _catpaw_pan_shares : [];
        const ownFlags = clean(item.vod_play_from).split('$$$');
        const ownUrls = clean(item.vod_play_url).split('$$$');
        const ownShares = ownFlags.flatMap((flag, i) => extractPanSharesFromSource(flag, ownUrls[i], { placeholders: true }));
        const keys = new Set(ownShares.map(share => share.key));
        const captured = parsed.list.length === 1 ? captures :
            captures.filter(entry => keys.has(parsePanShareURL(entry && entry.url, entry && entry.password)?.key));
        if (!clean(item.vod_play_from) && !clean(item.vod_play_url) && !captured.length) return item;
        const result = await normalizePanDetailItem(item, captured, { panMock, listShare });
        diagnostics.push(...result.diagnostics);
        return result.item;
    }));
    const messages = [parsed.message, ...diagnostics].map(clean).filter(Boolean);
    let vod = parsed.vod;
    if (!vod && items.some(item => item && item.vod_navigation)) {
        const first = items.find(item => item && item.vod_navigation);
        const data = decodeStructuredDetailId(first.vod_id);
        if (data && getDetailNavigationParent(data)) {
            vod = { ...(data.meta || {}), vod_id: requestedId || getDetailNavigationParent(data) };
            for (const key of ['name', 'pic', 'year', 'content', 'actor', 'director', 'area', 'type']) {
                if (data[key] != null && vod[`vod_${key}`] == null) vod[`vod_${key}`] = data[key];
            }
        }
    }
    return {
        ...rest, pan_mock: !!panMock, list: items,
        ...(vod ? { vod } : {}),
        ...(messages.length ? { message: Array.from(new Set(messages)).join('；') } : {}),
    };
}

async function normalizePanDetailItem(item, captured, { panMock, listShare }) {
    const shares = new Map();
    const leaves = [];
    const diagnostics = [];
    const addShare = (share) => {
        if (!share) return;
        const old = shares.get(share.key);
        if (!old || (!old.password && share.password)) shares.set(share.key, share);
    };
    const capturedProviders = new Set(captured.map(entry => parsePanShareURL(entry && entry.url, entry && entry.password)?.provider).filter(Boolean));
    captured.forEach(entry => addShare(parsePanShareURL(entry && entry.url, entry && entry.password)));
    const flags = clean(item.vod_play_from).split('$$$');
    const urls = clean(item.vod_play_url).split('$$$');
    for (let i = 0; i < Math.max(flags.length, urls.length); i += 1) {
        const flag = flags[i] || '';
        const group = urls[i] || '';
        if (!flag && !group) continue;
        const inputs = extractPanSharesFromSource(flag, group, { placeholders: captured.length > 0 });
        inputs.forEach(addShare);
        leaves.push({ flag, group, inputs, captured: capturedProviders.has(getSupportedPanProvider(flag)) });
    }
    const inputs = Array.from(shares.values());
    if (!inputs.length) return { item, diagnostics };
    const supported = new Array(inputs.length);
    // Independent providers may run together; each provider advances one share
    // at a time. The actual list entrypoint also gates across detail requests.
    const queues = new Map();
    inputs.forEach((share, index) => {
        if (!queues.has(share.provider)) queues.set(share.provider, []);
        queues.get(share.provider).push({ share, index });
    });
    await Promise.all(Array.from(queues.values(), async queue => {
      for (const { share, index } of queue) {
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
    }));
    const native = leaves.filter((item) => !item.inputs.length && !item.captured);
    const groups = [...supported.filter(Boolean), ...native];
    return {
        item: { ...item,
            vod_play_from: groups.map(entry => entry.flag).join('$$$'),
            vod_play_url: groups.map(entry => entry.group).join('$$$'),
        }, diagnostics,
    };
}

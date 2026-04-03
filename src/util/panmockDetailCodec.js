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

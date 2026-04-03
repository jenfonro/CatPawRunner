const QUALITY_NAME_RE = /(?:^|[\s[\](){}【】._-])(4k|2160p|1080p|720p)(?=$|[\s[\](){}【】._-])/i;
const FPS_NAME_RE = /(?:^|[\s[\](){}【】._-])((?:120|60))\s*(?:fps|帧)(?=$|[\s[\](){}【】._-])/i;
const RESOLUTION_PAIR_RE = /(\d+)\s*[xX*]\s*(\d+)/;
const RESOLUTION_KV_RE = /width\s*[:=]\s*(\d+).*height\s*[:=]\s*(\d+)/i;
const M3U8_RESOLUTION_RE = /RESOLUTION=(\d+)x(\d+)/gi;

function toStr(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function toIntLike(v) {
  const n = Number(toStr(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function toFloatLike(v) {
  const n = Number(toStr(v).trim());
  return Number.isFinite(n) ? n : 0;
}

export function inferPanQualityLabelFromFilename(name) {
  const matched = String(name || '').trim().match(QUALITY_NAME_RE);
  const token = matched && matched[1] ? matched[1].toLowerCase() : '';
  switch (token) {
    case '4k':
    case '2160p':
      return '4K';
    case '1080p':
      return '1080P';
    case '720p':
      return '720P';
    default:
      return '';
  }
}

export function inferPanQualityLabelFromResolution(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const maxSide = Math.max(w, h);
  if (maxSide >= 2160) return '4K';
  if (maxSide >= 1080) return '1080P';
  if (maxSide >= 720) return '720P';
  return '';
}

function inferResolutionFromItem(item) {
  const it = item && typeof item === 'object' ? item : null;
  if (!it) return { width: 0, height: 0 };

  const widthKeys = ['video_width', 'videoWidth', 'width'];
  const heightKeys = ['video_height', 'videoHeight', 'height'];
  let width = 0;
  let height = 0;
  for (const key of widthKeys) {
    width = toIntLike(it[key]);
    if (width > 0) break;
  }
  for (const key of heightKeys) {
    height = toIntLike(it[key]);
    if (height > 0) break;
  }
  if (width > 0 && height > 0) return { width, height };

  const resolutionRaw = toStr(it.resolution || it.video_resolution || it.videoResolution).trim();
  let m = resolutionRaw.match(RESOLUTION_PAIR_RE);
  if (!m) m = resolutionRaw.match(RESOLUTION_KV_RE);
  if (m && m[1] && m[2]) {
    return { width: toIntLike(m[1]), height: toIntLike(m[2]) };
  }
  return { width: 0, height: 0 };
}

export function inferPanQualityLabel(item, name = '') {
  const byName = inferPanQualityLabelFromFilename(name);
  if (byName) return byName;
  const { width, height } = inferResolutionFromItem(item);
  return inferPanQualityLabelFromResolution(width, height);
}

export function inferPanFPSLabel(item, name = '') {
  const byName = String(name || '').trim().match(FPS_NAME_RE);
  if (byName && byName[1]) {
    const n = Number(byName[1]);
    if (n >= 119) return '120FPS';
    if (n >= 59) return '60FPS';
  }
  const it = item && typeof item === 'object' ? item : null;
  if (!it) return '';
  const fps = toFloatLike(it.fps || it.frameRate || it.frame_rate || it.video_fps);
  if (fps >= 119.0) return '120FPS';
  if (fps >= 59.0) return '60FPS';
  return '';
}

export function buildPanDisplayPrefix({ quality = '', fps = '' } = {}) {
  const q = String(quality || '').trim();
  const f = String(fps || '').trim();
  if (q && f) return `@${q}@${f}`;
  if (q) return `@${q}`;
  if (f) return `@${f}`;
  return '';
}

export function buildPanDisplayName(baseDisplay, item, name = '') {
  const quality = inferPanQualityLabel(item, name);
  const fps = inferPanFPSLabel(item, name);
  return buildPanDisplayNameFromMeta(baseDisplay, { quality, fps });
}

export function buildPanDisplayNameWithQuality(baseDisplay, quality) {
  return buildPanDisplayNameFromMeta(baseDisplay, { quality: String(quality || '').trim(), fps: '' });
}

export function buildPanDisplayNameFromMeta(baseDisplay, { quality = '', fps = '' } = {}) {
  const prefix = buildPanDisplayPrefix({ quality, fps });
  return prefix ? `${prefix}${baseDisplay}` : baseDisplay;
}

export async function detectPanQualityFromM3U8(url, { userAgent = '', fetchImpl } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('empty m3u8 url');
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new Error('fetch unavailable');
  const res = await fetchFn(target, {
    method: 'GET',
    headers: userAgent ? { 'User-Agent': userAgent } : {},
  });
  if (!res || !res.ok) throw new Error(`m3u8 http ${res ? res.status : 0}`);
  const text = await res.text();
  let bestWidth = 0;
  let bestHeight = 0;
  for (const m of text.matchAll(M3U8_RESOLUTION_RE)) {
    const width = toIntLike(m[1]);
    const height = toIntLike(m[2]);
    const bestRank = qualityRankOfResolution(bestWidth, bestHeight);
    const curRank = qualityRankOfResolution(width, height);
    if (curRank > bestRank || (curRank === bestRank && Math.max(width, height) > Math.max(bestWidth, bestHeight))) {
      bestWidth = width;
      bestHeight = height;
    }
  }
  return inferPanQualityLabelFromResolution(bestWidth, bestHeight);
}

function qualityRankOfResolution(width, height) {
  switch (inferPanQualityLabelFromResolution(width, height)) {
    case '4K':
      return 3;
    case '1080P':
      return 2;
    case '720P':
      return 1;
    default:
      return 0;
  }
}

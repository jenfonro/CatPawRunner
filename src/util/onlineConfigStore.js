import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';

function resolveRuntimeRootDir() {
    try {
        // eslint-disable-next-line no-undef
        if (process && process.pkg && typeof process.execPath === 'string' && process.execPath) {
            return path.dirname(process.execPath);
        }
    } catch (_) {}
    const p = typeof process.env.NODE_PATH === 'string' && process.env.NODE_PATH.trim() ? process.env.NODE_PATH.trim() : '';
    return p ? path.resolve(p) : process.cwd();
}

function readJsonFileSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = raw && raw.trim() ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function readTextFileSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return '';
    }
}

function atomicWriteFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = path.resolve(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

function stableHashShort(input) {
    const s = String(input || '');
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}

function writeJsonFileAtomic(filePath, obj) {
    const root = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    atomicWriteFile(filePath, `${JSON.stringify(root, null, 2)}\n`);
}

function sanitizeFileName(name, fallback) {
    const base = path.basename(String(name || '').trim() || String(fallback || '').trim() || 'online.js');
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || 'online.js';
}

function sanitizeFileStem(name, fallback) {
    const raw = String(name || '').trim() || String(fallback || '').trim() || 'online';
    const base = path.basename(raw);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
    const trimmed = safe.replace(/^_+|_+$/g, '').replace(/^\.+|\.+$/g, '');
    return trimmed || 'online';
}

function pickFileNameFromUrl(urlStr) {
    try {
        const u = new URL(String(urlStr || '').trim());
        const base = path.basename(u.pathname || '');
        return base && base !== '/' ? base : '';
    } catch (_) {
        return '';
    }
}

function buildOnlineFileName(urlStr, id) {
    const baseFromUrl = pickFileNameFromUrl(urlStr);
    const base = sanitizeFileName(baseFromUrl || 'online.js', 'online.js');
    const lower = base.toLowerCase();
    const extFromBase = lower.endsWith('.cjs') ? '.cjs' : lower.endsWith('.mjs') ? '.mjs' : lower.endsWith('.js') ? '.js' : '';
    const name = base.replace(/\.(cjs|mjs|js)$/i, '');
    const hash = stableHashShort(id || urlStr);
    return `${name}.${hash}${extFromBase || '.js'}`.replace(/\.{2,}/g, '.');
}

async function downloadText(url) {
    const res = await axios.get(url, {
        timeout: 30000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        maxContentLength: 10 * 1024 * 1024,
        validateStatus: () => true,
    });
    if (!res || res.status < 200 || res.status >= 300) {
        const code = res ? res.status : 0;
        throw new Error(`download failed: status=${code || 'unknown'}`);
    }
    const buf = Buffer.from(res.data || []);
    return buf.toString('utf8');
}

function normalizeOnlineConfigs(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr
        .map((raw) => {
            const it = raw && typeof raw === 'object' ? raw : {};
            const url = typeof it.url === 'string' ? it.url.trim() : typeof raw === 'string' ? raw.trim() : '';
            const name = typeof it.name === 'string' ? it.name.trim() : '';
            const idRaw = typeof it.id === 'string' && it.id.trim() ? it.id.trim() : '';
            const fileNameRaw = typeof it.fileName === 'string' ? it.fileName.trim() : '';
            const entryFn =
                typeof it.entryFn === 'string'
                    ? it.entryFn.trim()
                    : typeof it.entry_fn === 'string'
                      ? it.entry_fn.trim()
                      : '';
            return { url, name, idRaw, fileNameRaw, entryFn };
        })
        .filter((it) => it.url);
}

function pickExtFromUrl(parsedUrl) {
    try {
        const pathname = String(parsedUrl && parsedUrl.pathname ? parsedUrl.pathname : '');
        const ext = path.extname(pathname || '').toLowerCase();
        if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return ext;
    } catch (_) {}
    return '';
}

function pickExtFromFileName(fileNameRaw) {
    const lower = String(fileNameRaw || '').trim().toLowerCase();
    if (lower.endsWith('.cjs')) return '.cjs';
    if (lower.endsWith('.mjs')) return '.mjs';
    if (lower.endsWith('.js')) return '.js';
    return '';
}

function resolveOnlineDir(rootDir) {
    // After refactor, online scripts live directly under `custom_spider/`.
    return path.resolve(rootDir, 'custom_spider');
}

function listOnlineFiles(onlineDir) {
    try {
        if (!fs.existsSync(onlineDir)) return [];
        return fs
            .readdirSync(onlineDir, { withFileTypes: true })
            .filter((d) => d && d.isFile && d.isFile())
            .map((d) => String(d.name || ''))
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

export async function applyOnlineConfigs(options = {}) {
    const rootDir = options && typeof options.rootDir === 'string' && options.rootDir ? options.rootDir : resolveRuntimeRootDir();
    const cfgPath = path.resolve(rootDir, 'config.json');
    const cfg = readJsonFileSafe(cfgPath) || {};
    const hasOnlineConfigs =
        Object.prototype.hasOwnProperty.call(cfg, 'onlineConfigs') || Object.prototype.hasOwnProperty.call(cfg, 'online_configs');
    if (!hasOnlineConfigs) {
        return { rootDir, onlineDir: resolveOnlineDir(rootDir), entry: '', resolved: [], removed: [], changedAny: false, skipped: true };
    }

    const listKey = Object.prototype.hasOwnProperty.call(cfg, 'onlineConfigs') ? 'onlineConfigs' : 'online_configs';
    const rawList = cfg[listKey];

    const items = normalizeOnlineConfigs(
        Object.prototype.hasOwnProperty.call(cfg, 'onlineConfigs') ? cfg.onlineConfigs : cfg.online_configs
    );

    const onlineDir = resolveOnlineDir(rootDir);
    try {
        if (!fs.existsSync(onlineDir)) fs.mkdirSync(onlineDir, { recursive: true });
    } catch (_) {}

    const keepNames = new Set(['.catpaw_online_runtime_bootstrap.cjs']);
    const resolved = [];
    let downloadedAny = false;

    let idsAdded = false;
    const nextList = Array.isArray(rawList) ? rawList.map((v) => (v && typeof v === 'object' ? { ...v } : v)) : [];

    for (let idx = 0; idx < items.length; idx += 1) {
        const it = items[idx];
        let parsed;
        try {
            parsed = new URL(it.url);
        } catch (_) {
            continue;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

        const desiredExt = pickExtFromUrl(parsed) || pickExtFromFileName(it.fileNameRaw) || '.js';
        const baseFromUrl = pickFileNameFromUrl(parsed.toString());
        const fallbackStem = (baseFromUrl || 'online').replace(/\.(cjs|mjs|js)$/i, '');
        const rawStem = it.fileNameRaw ? String(it.fileNameRaw).replace(/\.(cjs|mjs|js)$/i, '') : '';
        const stem = sanitizeFileStem(rawStem, fallbackStem);
        const idEff = it.idRaw || stableHashShort(parsed.toString());
        if (!it.idRaw) {
            // Persist generated ids back to config.json so UIs can read them.
            try {
                const rawItem = nextList[idx];
                if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem) && !rawItem.id) {
                    rawItem.id = idEff;
                    idsAdded = true;
                }
            } catch (_) {}
        }

        const fileName = `${stem}.${idEff}${desiredExt}`.replace(/\.{2,}/g, '.');
        keepNames.add(fileName);

        const destPath = path.resolve(onlineDir, fileName);
        const metaName = `.${fileName}.remote.json`;
        const metaPath = path.resolve(onlineDir, metaName);
        keepNames.add(metaName);

        const localMeta = readJsonFileSafe(metaPath) || {};
        const prevUrl = typeof localMeta.url === 'string' ? localMeta.url.trim() : '';
        const shouldDownload = !fs.existsSync(destPath) || !prevUrl || prevUrl !== parsed.toString();

        try {
            if (shouldDownload) {
                const text = await downloadText(parsed.toString());
                atomicWriteFile(destPath, text || '');
                atomicWriteFile(
                    metaPath,
                    `${JSON.stringify({ url: parsed.toString(), savedAt: Date.now() }, null, 2)}\n`
                );
                downloadedAny = true;
            } else if (!readTextFileSafe(metaPath)) {
                atomicWriteFile(
                    metaPath,
                    `${JSON.stringify({ url: parsed.toString(), savedAt: Date.now() }, null, 2)}\n`
                );
            }
            resolved.push({
                ...it,
                url: parsed.toString(),
                fileName,
                destPath,
                ok: true,
                downloaded: !!shouldDownload,
                id: idEff,
                entryFn: it.entryFn || '',
            });
        } catch (_) {
            // Keep file name reserved even if download failed.
            resolved.push({
                ...it,
                url: parsed.toString(),
                fileName,
                destPath,
                ok: false,
                downloaded: false,
                id: idEff,
                entryFn: it.entryFn || '',
            });
        }
    }

    // Cleanup: remove files not referenced by config (bootstrap + per-file meta are preserved via keepNames).
    const removed = [];
    const files = listOnlineFiles(onlineDir);
    for (const name of files) {
        if (!name) continue;
        if (keepNames.has(name)) continue;
        const p = path.resolve(onlineDir, name);
        try {
            fs.unlinkSync(p);
            removed.push(name);
        } catch (_) {}
    }

    if (idsAdded) {
        try {
            const nextCfg = { ...cfg, [listKey]: nextList };
            writeJsonFileAtomic(cfgPath, nextCfg);
        } catch (_) {}
    }

    const entry = resolved.length ? resolved[0].destPath : '';
    const runtimeChangedAny = downloadedAny || removed.length > 0;
    return { rootDir, onlineDir, entry, resolved, removed, changedAny: runtimeChangedAny, configUpdatedAny: idsAdded };
}

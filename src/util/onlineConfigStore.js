import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';

export function resolveRuntimeRootDir() {
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

export function readJsonObjectSafe(filePath) {
    return readJsonFileSafe(filePath) || {};
}

export function writeJsonObjectAtomic(filePath, obj) {
    writeJsonFileAtomic(filePath, obj);
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

function sanitizeNameSeedForId(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const base = path.basename(raw);
    return base.replace(/\s+/g, ' ').trim();
}

export function buildAutoOnlineRuntimeId(name, urlStr, used) {
    const usedSet = used && typeof used.has === 'function' ? used : new Set();
    const nameSeed = sanitizeNameSeedForId(name).toLowerCase();
    const urlSeed = String(urlStr || '').trim();

    const pick = (seed) => stableHashShort(seed);

    const primary = pick(nameSeed ? `name:${nameSeed}` : `url:${urlSeed}`);
    if (!usedSet.has(primary)) {
        usedSet.add(primary);
        return primary;
    }

    const secondary = pick(`name+url:${nameSeed}:${urlSeed}`);
    if (!usedSet.has(secondary)) {
        usedSet.add(secondary);
        return secondary;
    }

    for (let n = 1; n <= 100; n += 1) {
        const next = pick(`name+url:${nameSeed}:${urlSeed}#${n}`);
        if (usedSet.has(next)) continue;
        usedSet.add(next);
        return next;
    }

    for (let n = 101; n <= 10000; n += 1) {
        const next = pick(`name+url:${nameSeed}:${urlSeed}#${n}`);
        if (usedSet.has(next)) continue;
        usedSet.add(next);
        return next;
    }

    // Extremely unlikely path (massive collisions). Keep deterministic output.
    const fallback = pick(`name+url:${nameSeed}:${urlSeed}:overflow`);
    usedSet.add(fallback);
    return fallback;
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

function resolveAxiosRequestForUrl(urlStr) {
    const raw = String(urlStr || '').trim();
    if (!raw) return { requestUrl: raw, auth: null };
    try {
        const u = new URL(raw);
        const hasUserInfo = typeof u.username === 'string' && u.username.length > 0;
        const requestUrl = hasUserInfo ? `${u.protocol}//${u.host}${u.pathname}${u.search}${u.hash}` : u.toString();
        if (!hasUserInfo) return { requestUrl, auth: null };
        return {
            requestUrl,
            auth: {
                username: decodeURIComponent(u.username || ''),
                password: decodeURIComponent(u.password || ''),
            },
        };
    } catch (_) {
        return { requestUrl: raw, auth: null };
    }
}

async function downloadText(url) {
    const { requestUrl, auth } = resolveAxiosRequestForUrl(url);
    const res = await axios.get(requestUrl, {
        timeout: 30000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        maxContentLength: 10 * 1024 * 1024,
        validateStatus: () => true,
        ...(auth ? { auth } : {}),
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
            const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
            if (!it) return null;
            const url = typeof it.url === 'string' ? it.url.trim() : '';
            if (!url) return null;
            const name = typeof it.name === 'string' ? it.name.trim() : '';
            const idRaw = typeof it.id === 'string' && it.id.trim() ? it.id.trim() : '';
            const fileNameRaw = typeof it.fileName === 'string' ? it.fileName.trim() : '';
            const entryFn = typeof it.entryFn === 'string' ? it.entryFn.trim() : '';
            return { url, name, idRaw, fileNameRaw, entryFn };
        })
        .filter(Boolean);
}

export function getOnlineConfigListAndKey(cfgRoot) {
    const cfg = cfgRoot && typeof cfgRoot === 'object' && !Array.isArray(cfgRoot) ? cfgRoot : {};
    if (Array.isArray(cfg.onlineConfigs)) return { key: 'onlineConfigs', list: cfg.onlineConfigs };
    if (Array.isArray(cfg.online_configs)) return { key: 'online_configs', list: cfg.online_configs };
    return { key: '', list: [] };
}

function normalizeOnlineConfigForSignature(raw) {
    const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const url = typeof it.url === 'string' ? it.url.trim() : '';
    if (!url) return null;
    return {
        id: typeof it.id === 'string' ? it.id.trim() : '',
        url,
        name: typeof it.name === 'string' ? it.name.trim() : '',
        fileName: typeof it.fileName === 'string' ? it.fileName.trim() : '',
        entryFn: typeof it.entryFn === 'string' ? it.entryFn.trim() : '',
    };
}

export function buildOnlineConfigWatchSignature(cfgRoot) {
    const { key, list } = getOnlineConfigListAndKey(cfgRoot);
    const normalized = (Array.isArray(list) ? list : []).map(normalizeOnlineConfigForSignature).filter(Boolean);
    return JSON.stringify({ key, list: normalized });
}

export function hasPendingOnlineConfigStatus(cfgRoot) {
    const { list } = getOnlineConfigListAndKey(cfgRoot);
    return (Array.isArray(list) ? list : []).some((raw) => {
        const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
        if (!it) return false;
        const status = typeof it.status === 'string' ? it.status.trim() : '';
        const updateResult = typeof it.updateResult === 'string' ? it.updateResult.trim() : '';
        return status === 'checking' || updateResult === 'updating';
    });
}

export function markOnlineConfigsCheckingInConfig(cfgPath) {
    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const { key, list } = getOnlineConfigListAndKey(cfgRoot);
    if (!key || !Array.isArray(list) || !list.length) return { changed: false };

    const now = Date.now();
    let changedAny = false;
    const nextList = list.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        const item = { ...raw };
        const url = typeof item.url === 'string' ? item.url.trim() : '';
        if (!url) return item;
        if (item.status !== 'checking') {
            item.status = 'checking';
            changedAny = true;
        }
        if (item.checkedAt !== now) {
            item.checkedAt = now;
            changedAny = true;
        }
        if (Object.prototype.hasOwnProperty.call(item, 'message')) {
            delete item.message;
            changedAny = true;
        }
        return item;
    });

    if (!changedAny) return { changed: false };
    try {
        writeJsonFileAtomic(cfgPath, { ...cfgRoot, [key]: nextList });
        return { changed: true };
    } catch (_) {
        return { changed: false };
    }
}

export function persistOnlineConfigStatePatchesByPath(cfgPath, patches = []) {
    const list = Array.isArray(patches) ? patches : [];
    if (!cfgPath || !list.length) return;

    const cfgRoot = readJsonFileSafe(cfgPath) || {};
    const { key, list: prevList } = getOnlineConfigListAndKey(cfgRoot);
    if (!key || !Array.isArray(prevList) || !prevList.length) return;

    const byId = new Map();
    list.forEach((patch) => {
        const p = patch && typeof patch === 'object' ? patch : null;
        if (!p) return;
        const id = typeof p.id === 'string' ? p.id.trim() : '';
        if (!id) return;
        byId.set(id, p);
    });
    if (!byId.size) return;

    let changedAny = false;
    const nextList = prevList.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        const item = { ...raw };
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id || !byId.has(id)) return item;
        const patch = byId.get(id) || {};

        const assign = (field) => {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) return;
            item[field] = patch[field];
            changedAny = true;
        };

        assign('status');
        assign('checkedAt');
        assign('updateResult');
        assign('updateAt');
        assign('changed');
        assign('updated');
        assign('localMd5');
        assign('remoteMd5');

        if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
            const msg = typeof patch.message === 'string' ? patch.message.trim() : '';
            if (msg) item.message = msg;
            else delete item.message;
            changedAny = true;
        }
        return item;
    });

    if (!changedAny) return;
    try {
        writeJsonFileAtomic(cfgPath, { ...cfgRoot, [key]: nextList });
    } catch (_) {}
}

export function buildLoadingPatchesFromSyncResult(syncResult) {
    const sync = syncResult && typeof syncResult === 'object' ? syncResult : {};
    const applied = sync.applied && typeof sync.applied === 'object' ? sync.applied : {};
    const resolved = Array.isArray(applied.resolved) ? applied.resolved : [];
    const runtimes = Array.isArray(sync.runtimes) ? sync.runtimes : [];
    const runtimeById = new Map(
        runtimes
            .filter((it) => it && typeof it === 'object' && typeof it.id === 'string' && it.id.trim())
            .map((it) => [it.id.trim(), it])
    );

    const patches = [];
    for (const rsRaw of resolved) {
        const rs = rsRaw && typeof rsRaw === 'object' ? rsRaw : null;
        if (!rs) continue;
        const id = typeof rs.id === 'string' ? rs.id.trim() : '';
        if (!id) continue;
        const checkedAt = Number.isFinite(Number(rs.checkedAt)) ? Math.max(1, Math.trunc(Number(rs.checkedAt))) : Date.now();
        const localMd5 = typeof rs.localMd5 === 'string' ? rs.localMd5 : '';
        const remoteMd5 = typeof rs.remoteMd5 === 'string' ? rs.remoteMd5 : '';
        if (!rs.ok) {
            patches.push({
                id,
                status: 'error',
                checkedAt,
                message: (typeof rs.message === 'string' && rs.message.trim()) || 'download failed',
                changed: !!rs.changed,
                localMd5,
                remoteMd5,
            });
            continue;
        }

        const rt = runtimeById.get(id) || null;
        const loaded = !!(rt && rt.ok && !rt.keptPrevious);
        patches.push({
            id,
            status: loaded ? 'pass' : 'error',
            checkedAt,
            message: loaded
                ? ''
                : (rt && typeof rt.message === 'string' && rt.message.trim()) ||
                  (rt && rt.keptPrevious ? 'new url load failed, keeping previous runtime' : 'runtime load failed'),
            changed: !!rs.changed,
            localMd5,
            remoteMd5,
        });
    }
    return patches;
}

export function normalizeOnlineConfigIdSet(raw) {
    const set = new Set();
    const list = Array.isArray(raw) ? raw : [];
    list.forEach((v) => {
        const id = String(v || '').trim();
        if (id) set.add(id);
    });
    return set;
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

function md5Hex(content) {
    try {
        return crypto.createHash('md5').update(Buffer.from(String(content == null ? '' : content), 'utf8')).digest('hex');
    } catch (_) {
        return '';
    }
}

function normalizeMd5Hex(raw) {
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return /^[0-9a-f]{32}$/.test(v) ? v : '';
}

function buildStagedFileName(fileName) {
    const base = sanitizeFileName(String(fileName || '').trim(), 'online.js');
    return `.${base}.staged.${process.pid}.${Date.now()}`;
}

function writeRemoteMetaFile(metaPath, payload = {}) {
    const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const url = typeof p.url === 'string' ? p.url.trim() : '';
    const md5 = normalizeMd5Hex(p.md5);
    const now = Date.now();
    atomicWriteFile(
        metaPath,
        `${JSON.stringify(
            {
                ...(url ? { url } : {}),
                ...(md5 ? { md5 } : {}),
                savedAt: Number.isFinite(Number(p.savedAt)) ? Math.max(1, Math.trunc(Number(p.savedAt))) : now,
                checkedAt: Number.isFinite(Number(p.checkedAt)) ? Math.max(1, Math.trunc(Number(p.checkedAt))) : now,
            },
            null,
            2
        )}\n`
    );
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

export function promoteOnlineStagedScript(options = {}) {
    const stagedPathRaw = options && typeof options.stagedPath === 'string' ? options.stagedPath.trim() : '';
    const destPathRaw = options && typeof options.destPath === 'string' ? options.destPath.trim() : '';
    const metaPathRaw = options && typeof options.metaPath === 'string' ? options.metaPath.trim() : '';
    const urlRaw = options && typeof options.url === 'string' ? options.url.trim() : '';
    const remoteMd5Raw = options && typeof options.remoteMd5 === 'string' ? options.remoteMd5.trim() : '';
    const checkedAtRaw = options && Number.isFinite(Number(options.checkedAt)) ? Math.trunc(Number(options.checkedAt)) : Date.now();
    if (!stagedPathRaw || !destPathRaw || !metaPathRaw || !urlRaw) {
        return { ok: false, message: 'invalid promote arguments' };
    }
    const stagedPath = path.resolve(stagedPathRaw);
    const destPath = path.resolve(destPathRaw);
    const metaPath = path.resolve(metaPathRaw);
    if (!fs.existsSync(stagedPath)) return { ok: false, message: 'staged file not found' };

    const checkedAt = checkedAtRaw > 0 ? checkedAtRaw : Date.now();
    const remoteMd5 = normalizeMd5Hex(remoteMd5Raw) || md5Hex(readTextFileSafe(stagedPath));

    try {
        fs.renameSync(stagedPath, destPath);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'rename failed';
        return { ok: false, message: msg };
    }

    try {
        writeRemoteMetaFile(metaPath, {
            url: urlRaw,
            md5: remoteMd5,
            savedAt: Date.now(),
            checkedAt,
        });
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'meta write failed';
        return { ok: false, message: msg };
    }

    return { ok: true, md5: remoteMd5, checkedAt };
}

export function discardOnlineStagedScript(options = {}) {
    const stagedPathRaw = options && typeof options.stagedPath === 'string' ? options.stagedPath.trim() : '';
    if (!stagedPathRaw) return { ok: true, removed: false };
    const stagedPath = path.resolve(stagedPathRaw);
    try {
        if (!fs.existsSync(stagedPath)) return { ok: true, removed: false };
        fs.unlinkSync(stagedPath);
        return { ok: true, removed: true };
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'remove failed';
        return { ok: false, removed: false, message: msg };
    }
}

export async function applyOnlineConfigs(options = {}) {
    const rootDir = options && typeof options.rootDir === 'string' && options.rootDir ? options.rootDir : resolveRuntimeRootDir();
    const forceRemoteCheckIds = normalizeOnlineConfigIdSet(
        options && Object.prototype.hasOwnProperty.call(options, 'forceRemoteCheckIds') ? options.forceRemoteCheckIds : []
    );
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
    let changedAny = false;
    const usedIds = new Set();

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
        let idEff = it.idRaw || '';
        if (idEff) {
            if (usedIds.has(idEff)) {
                idEff = buildAutoOnlineRuntimeId(it.name || idEff, parsed.toString(), usedIds);
                try {
                    const rawItem = nextList[idx];
                    if (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)) {
                        rawItem.id = idEff;
                        idsAdded = true;
                    }
                } catch (_) {}
            } else {
                usedIds.add(idEff);
            }
        } else {
            // Auto-id now derives from name (fallback: url) so route ids stay stable across url changes.
            idEff = buildAutoOnlineRuntimeId(it.name, parsed.toString(), usedIds);
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
        const prevMd5 = normalizeMd5Hex(localMeta.md5);
        const prevSavedAt =
            Number.isFinite(Number(localMeta.savedAt)) && Number(localMeta.savedAt) > 0 ? Math.trunc(Number(localMeta.savedAt)) : 0;
        const prevCheckedAt =
            Number.isFinite(Number(localMeta.checkedAt)) && Number(localMeta.checkedAt) > 0
                ? Math.trunc(Number(localMeta.checkedAt))
                : 0;

        const url = parsed.toString();
        const localExists = fs.existsSync(destPath);
        const localText = localExists ? readTextFileSafe(destPath) : '';
        const localMd5 = localExists ? md5Hex(localText) : '';
        const shouldFetchRemote = forceRemoteCheckIds.has(idEff) || !localExists || !prevUrl || prevUrl !== url;
        let checkedAt = prevCheckedAt;

        try {
            let remoteChecked = false;
            let downloaded = false;
            let changed = false;
            let needsReload = false;
            let stagedPath = '';
            let remoteMd5 = prevMd5 || localMd5;

            if (shouldFetchRemote) {
                remoteChecked = true;
                checkedAt = Date.now();
                const remoteText = await downloadText(url);
                downloaded = true;
                remoteMd5 = md5Hex(remoteText);

                if (!localExists) {
                    atomicWriteFile(destPath, remoteText || '');
                    writeRemoteMetaFile(metaPath, { url, md5: remoteMd5, savedAt: Date.now(), checkedAt });
                    changed = true;
                    needsReload = true;
                    changedAny = true;
                } else if (remoteMd5 && localMd5 && remoteMd5 === localMd5) {
                    writeRemoteMetaFile(metaPath, {
                        url,
                        md5: remoteMd5,
                        savedAt: prevSavedAt || Date.now(),
                        checkedAt,
                    });
                } else {
                    const stagedName = buildStagedFileName(fileName);
                    keepNames.add(stagedName);
                    stagedPath = path.resolve(onlineDir, stagedName);
                    atomicWriteFile(stagedPath, remoteText || '');
                    changed = true;
                    needsReload = true;
                    changedAny = true;
                }
            } else if (!readTextFileSafe(metaPath)) {
                writeRemoteMetaFile(metaPath, {
                    url,
                    md5: localMd5 || prevMd5,
                    savedAt: prevSavedAt || Date.now(),
                    checkedAt: prevCheckedAt || Date.now(),
                });
                checkedAt = prevCheckedAt || Date.now();
            }

            resolved.push({
                ...it,
                url,
                fileName,
                destPath,
                metaPath,
                stagedPath,
                ok: true,
                downloaded,
                changed,
                needsReload,
                remoteChecked,
                localMd5,
                remoteMd5,
                checkedAt: checkedAt > 0 ? checkedAt : Date.now(),
                id: idEff,
                entryFn: it.entryFn || '',
            });
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'download failed';
            // Keep file name reserved even if download failed.
            resolved.push({
                ...it,
                url,
                fileName,
                destPath,
                metaPath,
                stagedPath: '',
                ok: false,
                downloaded: false,
                changed: false,
                needsReload: false,
                remoteChecked: shouldFetchRemote,
                localMd5,
                remoteMd5: '',
                checkedAt: Date.now(),
                message: msg,
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
    const runtimeChangedAny = changedAny || removed.length > 0;
    return { rootDir, onlineDir, entry, resolved, removed, changedAny: runtimeChangedAny, configUpdatedAny: idsAdded };
}

import path from 'node:path';
import http from 'node:http';
import { applyOnlineConfigs, normalizeOnlineConfigIdSet, persistOnlineConfigStatePatchesByPath } from './onlineConfigStore.js';
import { withOnlineRuntimeOpsLock } from './onlineRuntime.js';
import { syncOnlineRuntimesByDesired } from './onlineRuntimeSync.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(Number(ms) || 0))));
}

function probeRuntimeFullConfig(port, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const p = Number(port || 0);
        if (!Number.isFinite(p) || p <= 0) {
            reject(new Error('invalid port'));
            return;
        }
        const req = http.request(
            {
                method: 'GET',
                hostname: '127.0.0.1',
                port: p,
                path: '/full-config',
                headers: {
                    accept: 'application/json',
                    'accept-encoding': 'identity',
                },
            },
            (res) => {
                const status = res ? Number(res.statusCode || 0) : 0;
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (!(status >= 200 && status < 300)) {
                            const err = new Error(`bad status: ${status || 'unknown'}`);
                            err.status = status;
                            err.body = text;
                            reject(err);
                            return;
                        }
                        const parsed = text && text.trim() ? JSON.parse(text) : null;
                        if (parsed && typeof parsed === 'object') resolve(parsed);
                        else reject(new Error('invalid full-config'));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(Math.max(100, Math.trunc(Number(timeoutMs) || 2500)), () => {
            try {
                req.destroy(new Error('timeout'));
            } catch (_) {}
        });
        req.end();
    });
}

async function waitRuntimeReadyById(portsMap, runtimeId, options = {}) {
    const id = typeof runtimeId === 'string' ? runtimeId.trim() : '';
    if (!id) return { ok: false, message: 'invalid runtime id', port: 0 };
    const map = portsMap && typeof portsMap.get === 'function' ? portsMap : null;
    if (!map) return { ok: false, message: 'onlineRuntimePorts not available', port: 0 };

    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(500, Math.trunc(Number(options.timeoutMs))) : 30000;
    const probeTimeoutMs = Number.isFinite(Number(options.probeTimeoutMs))
        ? Math.max(200, Math.trunc(Number(options.probeTimeoutMs)))
        : 2000;
    const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Math.max(100, Math.trunc(Number(options.intervalMs))) : 500;

    const deadline = Date.now() + timeoutMs;
    let lastErr = 'unreachable';
    while (Date.now() < deadline) {
        const port = Number(map.get(id) || 0);
        if (Number.isFinite(port) && port > 0) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await probeRuntimeFullConfig(port, probeTimeoutMs);
                return { ok: true, message: '', port };
            } catch (e) {
                lastErr = e && e.message ? String(e.message) : 'unreachable';
            }
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
    const finalPort = Number(map.get(id) || 0);
    return { ok: false, message: lastErr || 'timeout', port: Number.isFinite(finalPort) ? finalPort : 0 };
}

export async function syncOnlineRuntimesNow({ rootDir, portsMap, forceRemoteCheckIds = [] } = {}) {
    return withOnlineRuntimeOpsLock(async () => {
        const ids = Array.from(normalizeOnlineConfigIdSet(forceRemoteCheckIds));
        const res = await applyOnlineConfigs({
            rootDir,
            ...(ids.length ? { forceRemoteCheckIds: ids } : {}),
        });

        const map = portsMap && typeof portsMap.get === 'function' ? portsMap : null;
        if (!map) return { ok: false, message: 'onlineRuntimePorts not available', applied: res, runtimes: [] };

        const desired = Array.isArray(res && res.resolved) ? res.resolved : [];
        const runtimeSync = await syncOnlineRuntimesByDesired({ desired, portsMap: map });
        if (!runtimeSync.ok) return { ok: false, message: runtimeSync.message || 'online runtime sync failed', applied: res, runtimes: [] };
        return { ok: true, applied: res, runtimes: runtimeSync.runtimes };
    });
}

export async function runOnlineSyncInBackground({
    rootDir,
    portsMap,
    targetIds = [],
    operation = 'loading',
    onFinishId = null,
} = {}) {
    const ids = Array.from(normalizeOnlineConfigIdSet(targetIds));
    if (!ids.length) return;
    const opMode = operation === 'updating' ? 'updating' : 'loading';
    const cfgPath = path.resolve(rootDir, 'config.json');

    try {
        const sync = await syncOnlineRuntimesNow({
            rootDir,
            portsMap,
            ...(opMode === 'updating' ? { forceRemoteCheckIds: ids } : {}),
        });
        const applied = sync && sync.applied ? sync.applied : null;
        const resolved = applied && Array.isArray(applied.resolved) ? applied.resolved : [];
        const runtimes = sync && Array.isArray(sync.runtimes) ? sync.runtimes : [];
        const resolvedById = new Map(
            resolved
                .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim())
                .map((r) => [r.id.trim(), r])
        );
        const runtimeById = new Map(
            runtimes
                .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.trim())
                .map((r) => [r.id.trim(), r])
        );

        const resolveRuntimeState = async (id, rtRaw) => {
            const rt = rtRaw && typeof rtRaw === 'object' ? rtRaw : null;
            let rtOk = !!(rt && rt.ok);
            let rtMessage = rt && typeof rt.message === 'string' ? rt.message.trim() : '';
            const keptPrevious = !!(rt && rt.keptPrevious);
            if (!rtOk && !keptPrevious) {
                const settled = await waitRuntimeReadyById(portsMap, id, {
                    timeoutMs: 30000,
                    probeTimeoutMs: 2500,
                    intervalMs: 500,
                });
                if (settled.ok) {
                    rtOk = true;
                    rtMessage = '';
                } else if (settled.message) {
                    rtMessage = settled.message;
                }
            }
            return { rtOk, rtMessage, keptPrevious };
        };

        const statusPatches = [];
        const updatePatches = [];
        for (const id of ids) {
            const rs = resolvedById.get(id) || null;
            const rt = runtimeById.get(id) || null;
            const checkedAt = Number.isFinite(Number(rs && rs.checkedAt))
                ? Math.max(1, Math.trunc(Number(rs.checkedAt)))
                : Date.now();
            const localMd5 = rs && typeof rs.localMd5 === 'string' ? rs.localMd5 : '';
            const remoteMd5 = rs && typeof rs.remoteMd5 === 'string' ? rs.remoteMd5 : '';

            if (!rs || !rs.ok) {
                if (opMode === 'loading') {
                    statusPatches.push({
                        id,
                        status: 'error',
                        checkedAt,
                        message: (rs && typeof rs.message === 'string' && rs.message.trim()) || 'download failed',
                        changed: !!(rs && rs.changed),
                        localMd5,
                        remoteMd5,
                    });
                } else {
                    updatePatches.push({
                        id,
                        updateResult: 'error',
                        updateAt: checkedAt,
                        message: (rs && typeof rs.message === 'string' && rs.message.trim()) || 'update download failed',
                        changed: !!(rs && rs.changed),
                        updated: false,
                        localMd5,
                        remoteMd5,
                    });
                }
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const { rtOk, rtMessage, keptPrevious } = await resolveRuntimeState(id, rt);

            if (opMode === 'loading') {
                const loaded = rtOk && !keptPrevious;
                statusPatches.push({
                    id,
                    status: loaded ? 'pass' : 'error',
                    checkedAt,
                    message: loaded ? '' : rtMessage || (keptPrevious ? 'new url load failed, keeping previous runtime' : 'runtime load failed'),
                    changed: !!rs.changed,
                    localMd5,
                    remoteMd5,
                });
                continue;
            }

            const updateOk = rtOk && !keptPrevious;
            updatePatches.push({
                id,
                updateResult: updateOk ? 'pass' : 'error',
                updateAt: checkedAt,
                message: updateOk ? '' : rtMessage || 'update failed',
                changed: !!rs.changed,
                updated: !!(updateOk && rt && rt.updated),
                localMd5,
                remoteMd5,
            });
            if (updateOk) {
                statusPatches.push({
                    id,
                    status: 'pass',
                    checkedAt,
                    message: '',
                    changed: !!rs.changed,
                    localMd5,
                    remoteMd5,
                });
            }
        }

        if (statusPatches.length || updatePatches.length) {
            persistOnlineConfigStatePatchesByPath(cfgPath, [...statusPatches, ...updatePatches]);
        }
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'online sync failed';
        const now = Date.now();
        const patches = ids.map((id) => {
            if (opMode === 'loading') {
                return { id, status: 'error', checkedAt: now, message: msg };
            }
            return { id, updateResult: 'error', updateAt: now, message: msg, updated: false };
        });
        if (patches.length) persistOnlineConfigStatePatchesByPath(cfgPath, patches);
    } finally {
        if (typeof onFinishId === 'function') {
            ids.forEach((id) => {
                try {
                    onFinishId(id);
                } catch (_) {}
            });
        }
    }
}

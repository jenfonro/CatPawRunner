import path from 'node:path';
import { findAvailablePortInRange } from './tool.js';
import { startOnlineRuntime, stopOnlineRuntime, stopAllOnlineRuntimes, setOnlineRuntimeEntry } from './onlineRuntime.js';
import { promoteOnlineStagedScript, discardOnlineStagedScript } from './onlineConfigStore.js';

export async function syncOnlineRuntimesByDesired({ desired = [], portsMap } = {}) {
    const map = portsMap && typeof portsMap.get === 'function' && typeof portsMap.entries === 'function' ? portsMap : null;
    if (!map) return { ok: false, message: 'onlineRuntimePorts not available', runtimes: [] };

    const desiredList = Array.isArray(desired) ? desired.filter((r) => r && r.id && r.destPath) : [];
    const desiredIds = new Set(desiredList.map((r) => String(r.id)));
    if (!desiredIds.size) {
        stopAllOnlineRuntimes();
        map.clear();
        return { ok: true, runtimes: [] };
    }

    for (const [id] of map.entries()) {
        if (!desiredIds.has(id)) {
            stopOnlineRuntime(id);
            map.delete(id);
        }
    }

    const runtimes = [];
    for (const r of desiredList) {
        const id = String(r.id);
        const curPort = Number(map.get(id) || 0);
        const hasCurrent = Number.isFinite(curPort) && curPort > 0;
        const needPort = !hasCurrent;
        const port = needPort ? await findAvailablePortInRange(30000, 39999) : curPort;
        const stagedPath = typeof r.stagedPath === 'string' && r.stagedPath.trim() ? path.resolve(r.stagedPath.trim()) : '';
        const shouldRestart = needPort || !!r.needsReload || !!stagedPath;
        const entryToStart = stagedPath || path.resolve(r.destPath);
        const started = await startOnlineRuntime({ id, port, entry: entryToStart, entryFn: r.entryFn || '' });
        const switched = !!(started && started.started && Number(started.port) > 0);
        const keptPrevious = !switched && hasCurrent;

        let promoteOk = false;
        let promoteErr = '';
        if (stagedPath) {
            if (switched) {
                const promoted = promoteOnlineStagedScript({
                    stagedPath,
                    destPath: r.destPath,
                    metaPath: r.metaPath,
                    url: r.url,
                    remoteMd5: r.remoteMd5 || '',
                    checkedAt: r.checkedAt,
                });
                if (promoted && promoted.ok) {
                    promoteOk = true;
                    setOnlineRuntimeEntry(id, r.destPath);
                } else {
                    promoteErr = promoted && promoted.message ? String(promoted.message) : 'promote failed';
                }
            } else {
                discardOnlineStagedScript({ stagedPath });
            }
        }

        if (switched) map.set(id, Number(started.port));
        else if (needPort) map.delete(id);

        let message = started && started.reason ? String(started.reason) : '';
        if (stagedPath && !switched && keptPrevious) {
            message = message
                ? `new script start failed, keeping previous runtime (${message})`
                : 'new script start failed, keeping previous runtime';
        }
        if (promoteErr) {
            message = message ? `${message}; ${promoteErr}` : promoteErr;
        }

        const effectivePort = switched ? Number(started.port) : hasCurrent ? curPort : 0;
        const changed = !!r.changed;
        const updated = stagedPath ? switched && promoteOk : switched && changed;
        const checkedAt = Number.isFinite(Number(r.checkedAt)) ? Math.trunc(Number(r.checkedAt)) : Date.now();

        runtimes.push({
            id,
            port: effectivePort > 0 ? effectivePort : 0,
            entry: path.resolve(r.destPath),
            testEntry: entryToStart,
            ok: switched || keptPrevious,
            restarted: shouldRestart,
            updated,
            changed,
            remoteChecked: !!r.remoteChecked,
            usedStaged: !!stagedPath,
            promoted: stagedPath ? promoteOk : false,
            keptPrevious,
            message,
            lastStage: started && started.lastStage ? String(started.lastStage) : '',
            checkedAt,
            localMd5: typeof r.localMd5 === 'string' ? r.localMd5 : '',
            remoteMd5: typeof r.remoteMd5 === 'string' ? r.remoteMd5 : '',
        });
    }

    return { ok: true, runtimes };
}

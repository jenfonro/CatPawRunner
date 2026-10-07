import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import { createRequire } from 'node:module';
import adminPlugins from '../src/plugins/api/admin.js';
import { applyOnlineConfigs, readJsonObjectSafe, writeJsonObjectAtomic } from '../src/util/onlineConfigStore.js';
import { restartOnlineConfigNow, runOnlineSyncInBackground } from '../src/util/onlineConfigSyncService.js';
import { getOnlineRuntimeScriptProtocol, getOnlineRuntimeScriptType, startOnlineRuntime, stopOnlineRuntimeAndWait, withOnlineRuntimeOpsLock } from '../src/util/onlineRuntime.js';

const waitFor = async (check) => {
    for (let n = 0; n < 200; n += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('restart did not settle');
};
const fastifyPath = createRequire(import.meta.url).resolve('fastify');
const script = `globalThis.start = async function () {
    const fs = require('node:fs');
    const pidFile = process.env.ONLINE_ID + '.pid';
    let previousPidAlive = false;
    if (fs.existsSync(pidFile)) {
        try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); previousPidAlive = true; } catch (_) {}
    }
    fs.writeFileSync(pidFile, String(process.pid));
    globalThis.server = require(${JSON.stringify(fastifyPath)})();
    globalThis.server.address = () => globalThis.server.server.address();
    globalThis.server.get('/full-config', async () => ({ pid: process.pid, previousPidAlive, video: { sites: [] } }));
    globalThis.server.get('/website/pans/list', async () => ({ code: 0, data: [] }));
    await globalThis.server.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
};`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

test('manual config restart is cold, status-independent and isolated', { timeout: 60000 }, async (t) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-restart-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = rootDir;
    const parentPid = process.pid;
    const portsMap = new Map();
    let downloads = 0;
    let downloadFails = false;
    const source = http.createServer((req, res) => {
        if (req.url === '/fixture.cjs') {
            downloads += 1;
            res.statusCode = downloadFails ? 503 : 200;
            res.end(downloadFails ? 'unavailable' : script);
        } else res.end('{}');
    });
    await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${source.address().port}/fixture.cjs`;
    const cfgPath = path.join(rootDir, 'config.json');
    const ids = ['aaaaaaaaaa', 'bbbbbbbbbb'];
    writeJsonObjectAtomic(cfgPath, { onlineConfigs: ids.map((id) => ({ id, name: id, url, entryFn: 'start', status: 'error', updateResult: 'error' })) });
    const app = Fastify();
    app.decorate('onlineRuntimePorts', portsMap);
    await app.register(adminPlugins[0].plugin, { prefix: '/admin' });
    const runtimeFor = async (id) => (await fetch(`http://127.0.0.1:${portsMap.get(id)}/full-config`)).json();
    const pidFor = async (id) => (await runtimeFor(id)).pid;
    const rowFor = (id) => readJsonObjectSafe(cfgPath).onlineConfigs.find((row) => row.id === id);
    const setRow = (id, patch) => {
        const cfg = readJsonObjectSafe(cfgPath);
        cfg.onlineConfigs = cfg.onlineConfigs.map((row) => row.id === id ? { ...row, ...patch } : row);
        writeJsonObjectAtomic(cfgPath, cfg);
    };
    const requestRestart = (id) => app.inject({ method: 'POST', url: '/admin/online-configs/restart', payload: { id } });
    try {
        for (const id of ids) assert.equal((await restartOnlineConfigNow({ rootDir, portsMap, id })).ok, true);
        const otherPid = await pidFor(ids[1]);
        const otherRow = rowFor(ids[1]);
        const applied = await applyOnlineConfigs({ rootDir, targetIds: [ids[0]], preferLocal: true });
        const entry = applied.resolved[0].destPath;
        const otherFiles = fs.readdirSync(path.dirname(entry)).filter((name) => name.includes(ids[1]));
        const otherBytes = otherFiles.map((name) => fs.readFileSync(path.join(path.dirname(entry), name)));

        await t.test('all previous statuses permit restart, without downloading or changing other configs', async () => {
            for (const status of ['pass', 'error', 'checking', 'unknown']) {
                const oldPid = await pidFor(ids[0]);
                const oldDownloads = downloads;
                setRow(ids[0], { status, updateResult: 'updating', updateAt: 123 });
                const response = await requestRestart(ids[0]);
                assert.equal(response.statusCode, 202);
                assert.equal(response.json().pending, true);
                await waitFor(() => rowFor(ids[0]).status === 'pass');
                assert.notEqual(await pidFor(ids[0]), oldPid);
                assert.equal((await runtimeFor(ids[0])).previousPidAlive, false, 'old process must exit before new entry runs');
                assert.equal(alive(oldPid), false, 'old process must exit before restart completes');
                assert.equal(downloads, oldDownloads, 'restart is not a remote update');
                assert.equal(rowFor(ids[0]).updateResult, 'updating');
                assert.equal(rowFor(ids[0]).updateAt, 123);
                assert.equal(await pidFor(ids[1]), otherPid);
                assert.deepEqual(rowFor(ids[1]), otherRow);
                assert.equal(process.pid, parentPid);
            }
            otherFiles.forEach((name, i) => assert.deepEqual(fs.readFileSync(path.join(path.dirname(entry), name)), otherBytes[i]));
        });

        await t.test('missing/unknown ID never triggers all-config restart; repeated clicks coalesce', async () => {
            assert.equal((await requestRestart('')).statusCode, 400);
            assert.equal((await requestRestart('not-found')).statusCode, 404);
            const first = await requestRestart(ids[0]);
            const second = await requestRestart(ids[0]);
            assert.equal(first.statusCode, 202);
            assert.equal(second.json().skipped, true);
            await waitFor(() => rowFor(ids[0]).status === 'pass');
        });

        await t.test('startup failure stops the previous runtime instead of keeping it', async () => {
            const oldPid = await pidFor(ids[0]);
            fs.writeFileSync(entry, 'process.exit(7);');
            await requestRestart(ids[0]);
            await waitFor(() => rowFor(ids[0]).status === 'error');
            assert.equal(alive(oldPid), false);
            assert.equal(portsMap.has(ids[0]), false);
            assert.match(rowFor(ids[0]).message, /exit:7/);
            assert.equal(await pidFor(ids[1]), otherPid);
        });

        await t.test('download failure affects only the requested config and allows a later retry', async () => {
            fs.unlinkSync(entry);
            downloadFails = true;
            try {
                await requestRestart(ids[0]);
                await waitFor(() => rowFor(ids[0]).status === 'error');
                assert.match(rowFor(ids[0]).message, /503/);
                assert.equal(portsMap.has(ids[0]), false);
                assert.equal(await pidFor(ids[1]), otherPid);
            } finally {
                downloadFails = false;
            }
        });

        await t.test('missing script is recovered even after a failed configuration', async () => {
            assert.equal(fs.existsSync(entry), false);
            const before = downloads;
            await requestRestart(ids[0]);
            await waitFor(() => rowFor(ids[0]).status === 'pass');
            assert.equal(downloads, before + 1);
            assert.equal(await pidFor(ids[1]), otherPid);
        });

        await t.test('restart queued behind an update still executes and status is not overwritten', async () => {
            let release;
            const barrier = withOnlineRuntimeOpsLock(() => new Promise((resolve) => { release = resolve; }));
            await waitFor(() => !!release);
            const update = runOnlineSyncInBackground({ rootDir, portsMap, targetIds: [ids[0]], operation: 'updating' });
            const oldPid = await pidFor(ids[0]);
            await requestRestart(ids[0]);
            release();
            await barrier;
            await update;
            await withOnlineRuntimeOpsLock(async () => {});
            assert.notEqual(await pidFor(ids[0]), oldPid);
            assert.equal(rowFor(ids[0]).status, 'pass');
            assert.equal(rowFor(ids[0]).updateResult, 'pass');
        });

        await t.test('unresponsive target is killed before replacement starts', async () => {
            fs.writeFileSync(entry, `process.on('SIGTERM', () => {});\n${script}`);
            assert.equal((await restartOnlineConfigNow({ rootDir, portsMap, id: ids[0] })).ok, true);
            const oldPid = await pidFor(ids[0]);
            assert.equal((await restartOnlineConfigNow({ rootDir, portsMap, id: ids[0] })).ok, true);
            assert.equal(alive(oldPid), false);
            assert.notEqual(await pidFor(ids[0]), oldPid);
            assert.equal((await runtimeFor(ids[0])).previousPidAlive, false);
            assert.equal(await pidFor(ids[1]), otherPid);
        });

        await t.test('protocol is detected on load and refreshed on replacement; failed hot swap retains it', async () => {
            assert.equal((await getOnlineRuntimeScriptProtocol(ids[0], portsMap.get(ids[0]))).type, 'website-v1');
            const modernScript = script.replace(
                "globalThis.server.get('/website/pans/list', async () => ({ code: 0, data: [] }));",
                "globalThis.server.get('/website/api/credentials', async () => ({ code: 0, data: { quark: { cookie: '' } } }));"
            );
            fs.writeFileSync(entry, modernScript);
            assert.equal((await restartOnlineConfigNow({ rootDir, portsMap, id: ids[0] })).ok, true);
            assert.equal((await getOnlineRuntimeScriptProtocol(ids[0], portsMap.get(ids[0]))).type, 'website-api-v1');
            assert.equal(getOnlineRuntimeScriptType(ids[1]), 'website-v1');
            const settings = (await app.inject({ method: 'GET', url: '/admin/settings' })).json();
            assert.equal(settings.onlineConfigs.find((row) => row.id === ids[0]).scriptType, 'website-api-v1');

            const broken = path.join(path.dirname(entry), 'broken.cjs');
            fs.writeFileSync(broken, 'process.exit(8)');
            const hot = await withOnlineRuntimeOpsLock(() => startOnlineRuntime({
                id: ids[0], port: portsMap.get(ids[0]), entry: broken, forceRestart: true,
            }));
            assert.equal(hot.started, false);
            assert.equal(getOnlineRuntimeScriptType(ids[0]), 'website-api-v1');
            await stopOnlineRuntimeAndWait(ids[0]);
            assert.equal(getOnlineRuntimeScriptType(ids[0]), 'unknown');
        });
    } finally {
        await withOnlineRuntimeOpsLock(async () => { for (const id of ids) await stopOnlineRuntimeAndWait(id); });
        await app.close();
        await new Promise((resolve) => source.close(resolve));
        if (oldRoot === undefined) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

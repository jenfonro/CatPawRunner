import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import { createRequire } from 'node:module';
import router from '../src/router.js';
import {
    startOnlineRuntime, stopOnlineRuntimeAndWait, broadcastOnlineRuntimeMockConfig,
    getOnlineRuntimeCacheIdentity, getOnlineRuntimeScriptProtocol,
} from '../src/util/onlineRuntime.js';
import { makeSpiderRuntime } from './fixtures/spiderRuntime.js';

const waitFor = async (check) => {
    for (let i = 0; i < 100; i += 1) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('fixture did not reach expected state');
};

test('gateway maintains the existing client contract with mock on AND off', { timeout: 60000 }, async (t) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-data-adapter-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = rootDir;
    const id = 'c0ffee1234';
    const ports = new Map();
    const cfgPath = path.join(rootDir, 'config.json');
    const entry = path.join(rootDir, 'same-script-name.cjs');
    let nativePanRequests = 0;
    const nativePan = http.createServer((req, res) => {
        nativePanRequests += 1;
        req.resume();
        let payload;
        if (req.url.includes('/share/sharepage/token')) payload = { status: 200, code: 0, data: { stoken: 'native-fixture-session' } };
        else if (req.url.includes('/share/sharepage/detail')) payload = { status: 200, code: 0, data: { list: [{ fid: 'native-fid', file_name: 'Real.E01.mkv', share_fid_token: 'native-file-token' }] } };
        else if (req.url.startsWith('/share/verify')) payload = { errno: 0, randsk: 'fixture-randsk' };
        else if (req.url.startsWith('/share/list')) payload = { errno: 0, shareid: 123, uk: 456, list: [{ fs_id: 789, server_filename: 'Real.E01.mkv' }] };
        else if (req.url.includes('getShareInfoByCodeV2')) payload = { res_code: 0, shareId: 12345, fileId: '67890', fileName: 'Real.E01.mkv' };
        else if (req.url.includes('getOutLinkInfoV6')) payload = { code: 0, data: { caLst: [], coLst: [{ coID: 'native-co-id', coName: 'Real.E01.mkv', path: '/real-file', coSize: 1024 }] } };
        else { res.statusCode = 404; payload = { error: 'unknown fixture path' }; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
    });
    await new Promise((resolve) => nativePan.listen(0, '127.0.0.1', resolve));
    const options = { fastifyPath: createRequire(import.meta.url).resolve('fastify'), upstreamPort: nativePan.address().port };
    const setMock = (pan_mock) => {
        fs.writeFileSync(cfgPath, JSON.stringify({ pan_mock, panResolver: false, online_runtime_watchdog_enabled: false }));
        broadcastOnlineRuntimeMockConfig({ rootDir });
    };
    const start = async (protocol = 'website-api-v1', version = 'v1') => {
        fs.writeFileSync(entry, makeSpiderRuntime({ ...options, protocol, version }));
        const result = await startOnlineRuntime({ id, port: ports.get(id), entry, entryFn: 'start', forceRestart: true });
        assert.equal(result.started, true, result.reason);
        ports.set(id, result.port);
        return result;
    };
    const app = Fastify();
    app.decorate('onlineRuntimePorts', ports);
    app.decorate('address', () => ({ url: 'http://127.0.0.1' }));
    const inject = (body, headers = {}, method = 'POST', operation = 'detail') => app.inject({
        method, url: `/${id}/spider/sample/3/${operation}`,
        headers, ...(method === 'POST' ? { payload: body } : { query: body }),
    });
    const stats = async () => (await fetch(`http://127.0.0.1:${ports.get(id)}/fixture/stats`)).json();
    const release = async (key) => fetch(`http://127.0.0.1:${ports.get(id)}/fixture/release/${key}`, { method: 'POST' });
    try {
        setMock(true);
        await start();
        await app.register(router);
        await app.ready();
        assert.equal((await getOnlineRuntimeScriptProtocol(id, ports.get(id))).type, 'website-api-v1');
        let mockDetail;
        await t.test('mock detail turns placeholders into five resolvable share routes, including every row', async () => {
            const response = await inject({ id: 'same-detail', multi: true });
            assert.equal(response.statusCode, 200, response.payload);
            mockDetail = response.json();
            assert.equal(mockDetail.pan_mock, true);
            assert.equal(mockDetail.cache, false);
            assert.deepEqual(mockDetail.nativeMetadata, { retained: true });
            for (const row of mockDetail.list) {
                assert.equal(row.vod_play_from, '夸父-quarkshare01$$$优夕-ucshare01$$$百度原画-1publicBaidu01$$$天意-TianyiShare01$$$逸动-mobileShare01');
                assert.equal(row.vod_play_url, '$$$Uc12$$$Bd23$$$Ty34$$$Mb45');
                assert.equal(row.vod_play_url.includes('file-token'), false);
            }
            assert.equal(nativePanRequests, 0, 'all mock pan traffic must be intercepted');
            assert.match(String(response.headers['set-cookie']), /catpaw_runtime_id=/);
            const cached = (await inject({ id: 'same-detail', multi: true })).json();
            assert.equal(cached.cache, true);
            assert.equal((await stats()).details, 1);
            assert.equal(cached.list[0].vod_play_url, mockDetail.list[0].vod_play_url, 'cached native data must be converted once, not twice');
        });

        await t.test('mock-off uses native detail and opaque ID/quality all the way through unified play', async () => {
            setMock(false);
            const detail = (await inject({ id: 'same-detail', multi: true })).json();
            assert.equal(detail.pan_mock, false);
            assert.equal(detail.cache, false);
            assert.ok(nativePanRequests > 0);
            const row = detail.list[0];
            assert.equal(row.vod_play_from, '夸克原画$$$夸克极速$$$UC原画$$$UC极速$$$UC原画(无限)$$$百度原画$$$百度原画(无限)$$$天翼原画$$$移动原画$$$移动极速');
            const playId = row.vod_play_url.split('$$$')[1].split('$')[1];
            assert.equal(JSON.parse(Buffer.from(playId, 'base64')).mode, 'speed');
            const payload = { siteApi: `/${id}/spider/sample/3`, flag: '夸克极速', id: playId };
            const response = await app.inject({
                method: 'POST', url: '/play', payload,
                headers: { host: 'client.example', 'x-forwarded-proto': 'https', 'x-tv-user': 'viewer-one' },
            });
            assert.equal(response.statusCode, 200);
            const play = response.json();
            assert.equal(play.parse, 0);
            assert.equal(play.url, `https://client.example/${id}/native-stream`);
            assert.deepEqual(play.header, { Referer: 'https://example.invalid/', 'User-Agent': 'fixture-player' });
            assert.equal(play.format, 'video/x-matroska');
            assert.deepEqual(play.subtitles, ['fixture.vtt']);
            assert.deepEqual(play.meta, { flag: '夸克极速', id: playId, mode: 'speed', quality: 'speed', tvUser: 'viewer-one', internalHeaderVisible: false });
            await app.inject({ method: 'POST', url: '/play', payload });
            assert.equal((await stats()).plays, 2, 'play must not use the spider result cache');
            const flags = row.vod_play_from.split('$$$');
            const urls = row.vod_play_url.split('$$$');
            for (let i = 0; i < flags.length; i += 1) {
                const nativeId = urls[i].split('$')[1];
                const native = (await inject({ flag: flags[i], id: nativeId }, {}, 'POST', 'play')).json();
                assert.equal(native.meta.id, nativeId);
                assert.equal(native.meta.flag, flags[i]);
                assert.deepEqual(native.header, native.headers);
            }
            assert.equal((await inject({ id: 'same-detail', multi: true })).json().cache, true);
        });

        await t.test('off -> on reuses only mock data, never native tokens or stale mode labels', async () => {
            const before = nativePanRequests;
            setMock(true);
            const result = (await inject({ id: 'same-detail', multi: true })).json();
            assert.equal(result.cache, true);
            assert.equal(result.pan_mock, true);
            assert.deepEqual(result.list, mockDetail.list);
            assert.equal(nativePanRequests, before);
        });

        await t.test('non-cacheable GET, legacy AES-139 and separate-field Tianyi use the same facade', async () => {
            const before = nativePanRequests;
            const get = (await inject({ id: 'get-test' }, {}, 'GET')).json();
            assert.equal(get.pan_mock, true);
            assert.equal(get.list[0].vod_play_url, mockDetail.list[0].vod_play_url);
            const mobile = (await inject({ id: 'legacy-mobile', provider: 'new139', wire: 'encrypted' })).json();
            assert.equal(mobile.list[0].vod_play_from, '逸动-mobileShare01');
            assert.equal(mobile.list[0].vod_play_url, 'Mb45');
            const tianyi = (await inject({ id: 'legacy-tianyi', provider: 'pan189', wire: 'separate' })).json();
            assert.equal(tianyi.list[0].vod_play_from, '天意-TianyiShare01');
            assert.equal(tianyi.list[0].vod_play_url, 'Ty34');
            assert.equal(nativePanRequests, before);
        });

        await t.test('concurrent mode change uses request snapshot and ignores a forged internal header', async () => {
            const before = nativePanRequests;
            const pending = inject({ id: 'waiting-mock', wait: true }, { 'x-catpaw-pan-mock': '0' });
            const promise = pending.then((response) => response.json());
            await waitFor(async () => (await stats()).waiting.includes('waiting-mock'));
            setMock(false);
            await release('waiting-mock');
            const result = await promise;
            assert.equal(result.pan_mock, true);
            assert.equal(result.list[0].vod_play_url, mockDetail.list[0].vod_play_url);
            assert.equal(nativePanRequests, before, 'IPC toggle must not change an in-flight request');
            const native = (await inject({ id: 'forged-on' }, { 'x-catpaw-pan-mock': '1' })).json();
            assert.equal(native.pan_mock, false);
            assert.match(native.list[0].vod_play_url, /^Real\.E01\.mkv\$/);
            const pendingNative = inject({ id: 'waiting-native', wait: true }).then((response) => response.json());
            await waitFor(async () => (await stats()).waiting.includes('waiting-native'));
            setMock(true);
            await release('waiting-native');
            const nativeSnapshot = await pendingNative;
            assert.equal(nativeSnapshot.pan_mock, false);
            assert.match(nativeSnapshot.list[0].vod_play_url, /^Real\.E01\.mkv\$/);
        });

        await t.test('cached native data is isolated by caller headers and query context', async () => {
            setMock(false);
            const body = { id: 'per-user', provider: 'quark' };
            assert.equal((await inject(body, { 'x-tv-user': 'one' })).json().cache, false);
            assert.equal((await inject(body, { 'x-tv-user': 'one' })).json().cache, true);
            assert.equal((await inject(body, { 'x-tv-user': 'two' })).json().cache, false);
            assert.equal((await inject(body, { authorization: 'Bearer fixture-one' })).json().cache, false);
            assert.equal((await inject(body, { authorization: 'Bearer fixture-two' })).json().cache, false);
            assert.equal((await inject(body, { cookie: 'fixture=one' })).json().cache, false);
            assert.equal((await inject(body, { cookie: 'fixture=two' })).json().cache, false);
            for (const query of ['identity=one', 'identity=two']) {
                assert.equal((await app.inject({ method: 'POST', url: `/${id}/spider/sample/3/detail?${query}`, payload: body })).json().cache, false);
            }
            setMock(true);
        });

        await t.test('upstream errors, malformed JSON and media responses are preserved', async () => {
            for (const method of ['POST', 'GET']) {
                const error = await inject({ id: 'http-error' }, {}, method);
                assert.equal(error.statusCode, 410);
                assert.deepEqual(error.json(), { ok: false, message: 'baidu api errno=-9' });
                const applicationError = await inject({ id: 'json-error' }, {}, method);
                assert.deepEqual(applicationError.json(), { ok: false, message: 'baidu api errno=-9' });
                assert.equal((await inject({ id: 'invalid-json' }, {}, method)).payload, '{broken');
                assert.equal((await inject({ id: 'html' }, {}, method)).payload, '<html>upstream error</html>');
            }
            const binary = await inject({ id: 'media' }, {}, 'POST', 'play');
            assert.equal(binary.headers['content-type'], 'video/mp2t');
            assert.deepEqual(binary.rawPayload, Buffer.from([0x47, 0, 0xff, 1]));
            for (const operation of ['home', 'category', 'search']) {
                const result = (await inject({}, {}, 'POST', operation)).json();
                assert.equal(result.list[0].vod_pic, 'https://img1.doubanio.com/view/photo.jpg');
                assert.equal(result.cache, false);
            }
        });

        await t.test('replacement at same ID/name redetects protocol and cannot reuse prior detail/init cache', async () => {
            const previousIdentity = getOnlineRuntimeCacheIdentity(id, ports.get(id));
            const previousPort = ports.get(id);
            await stopOnlineRuntimeAndWait(id);
            await start('website-v1', 'v2');
            assert.equal(ports.get(id), previousPort, 'exercise replacement with the same port as well as ID/name');
            assert.notEqual(getOnlineRuntimeCacheIdentity(id, ports.get(id)), previousIdentity);
            assert.equal((await getOnlineRuntimeScriptProtocol(id, ports.get(id))).type, 'website-v1');
            const result = (await inject({ id: 'same-detail', multi: true })).json();
            assert.equal(result.cache, false);
            assert.equal(result.pan_mock, true);
            assert.equal(result.list[0].vod_name, 'v2');
            assert.equal(result.list[0].vod_play_url, 'Ab12');
            assert.equal((await stats()).inits, 1);
            setMock(false);
            const native = (await inject({ id: 'same-detail', multi: true })).json();
            assert.equal(native.pan_mock, false);
            assert.equal(native.list[0].vod_play_from, '原生-夸父-quarkshare01');
            assert.equal(native.list[0].vod_play_url, 'Ab12.mp4$legacy-opaque-id');
            const played = (await app.inject({ method: 'POST', url: '/play', payload: {
                siteApi: `/${id}/spider/sample/3`, flag: native.list[0].vod_play_from, id: 'legacy-opaque-id',
            } })).json();
            assert.deepEqual(played.meta, { flag: '夸父-quarkshare01', id: 'legacy-opaque-id' });
        });
    } finally {
        await stopOnlineRuntimeAndWait(id);
        await app.close();
        await new Promise((resolve) => nativePan.close(resolve));
        if (oldRoot === undefined) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        const target = fs.realpathSync(rootDir);
        assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(target).startsWith('catpaw-data-adapter-'));
        fs.rmSync(target, { recursive: true, force: true });
    }
});

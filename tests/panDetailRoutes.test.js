import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import router from '../src/router.js';

const encode = data => Buffer.from(JSON.stringify(data)).toString('base64');
const privateId = encode({ providerId: 'baidu', shareId: '1shareA', fileId: 'private-file' });
const completeId = encode({ surl: 'shareA', shareid: '123', uk: '456', fs_id: '789' }) + '|||S01E01.mkv';
const rawDetail = () => ({
    list: [{
        vod_id: 'film', vod_name: 'Example',
        vod_play_from: '百度原画$$$光鸭原画',
        vod_play_url: `File$${privateId}$$$File$native-id`,
    }],
    _catpaw_pan_shares: [{ url: 'https://pan.baidu.com/s/1shareA', password: 'abcd' }],
});

async function fixture(t, rawHandler = () => ({ doc: rawDetail() })) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-detail-routes-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = root;
    const configPath = path.join(root, 'config.json');
    const setConfig = (patch = {}) => fs.writeFileSync(configPath, JSON.stringify({
        pan_mock: true, panResolver: false, panBuiltinResolverEnabled: false, account: {}, ...patch,
    }));
    setConfig();
    const rawCalls = [], panCalls = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        rawCalls.push({ path: req.url, body });
        if (req.url.endsWith('/init')) return res.end('{}');
        if (req.url.endsWith('/play')) {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ url: 'https://media.example/native.mp4', nativeFlag: body.flag, nativeId: body.id }));
        }
        const result = rawHandler(body);
        const text = Buffer.from(JSON.stringify(result.doc));
        res.writeHead(result.status || 200, {
            'content-type': 'application/json',
            ...(result.gzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(result.gzip ? gzipSync(text) : text);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const app = Fastify();
    app.decorate('onlineRuntimePorts', new Map([['aaaaaaaaaa', server.address().port]]));
    // Stub only provider network I/O. The real router, body parsing, flag
    // dispatch, detail codec and TTL/inflight cache are exercised unchanged.
    app.addHook('preHandler', async (req, reply) => {
        if (!/^\/api\/(?:baidu|quark|uc|139|189)\/(?:list|play)$/.test(req.url)) return;
        panCalls.push({ path: req.url, body: req.body, user: req.headers['x-tv-user'] });
        return reply.send(req.url.endsWith('/list')
            ? { ok: true, vod_play_url: `File$${completeId}` }
            : { ok: true, url: 'https://media.example/builtin.mp4' });
    });
    await app.register(router);
    await app.ready();
    t.after(async () => {
        await app.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        if (oldRoot == null) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        const resolvedRoot = fs.realpathSync(root);
        assert.equal(path.dirname(resolvedRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolvedRoot).startsWith('catpaw-detail-routes-'));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    });
    return {
        app, setConfig, rawCalls, panCalls,
        detail: (headers = {}) => app.inject({ method: 'POST', url: '/aaaaaaaaaa/spider/test/3/detail', payload: { id: 'film' }, headers }),
    };
}

test('two modes reuse raw detail cache but keep normalized mode/account/TV-user contexts separate', async t => {
    const fx = await fixture(t);
    let result = (await fx.detail()).json();
    assert.equal(result.pan_mock, true);
    assert.equal(result.list[0].vod_play_from, '百度-abcd$$$光鸭原画');
    assert.equal(result.list[0].vod_play_url, 'https://pan.baidu.com/s/1shareA?pwd=abcd$$$File$native-id');
    assert.equal(result._catpaw_pan_shares, undefined);
    assert.equal(fx.panCalls.length, 0);
    assert.equal((await fx.detail()).json().cache, true);
    const detailCalls = () => fx.rawCalls.filter(call => call.path.endsWith('/detail')).length;
    assert.equal(detailCalls(), 1);

    fx.setConfig({ pan_mock: false });
    result = (await fx.detail()).json();
    assert.equal(result.pan_mock, false);
    assert.equal(result.list[0].vod_play_url, `File$${completeId}$$$File$native-id`);
    assert.equal(detailCalls(), 1, 'switching modes does not refetch the script unnecessarily');
    assert.equal(fx.panCalls[0].path, '/api/baidu/list');
    assert.equal(fx.panCalls[0].body.flag, 'https://pan.baidu.com/s/1shareA?pwd=abcd');
    assert.equal(fx.panCalls[0].body.pwd, 'abcd');
    assert.equal((await fx.detail()).json().cache, true);
    assert.equal(fx.panCalls.length, 1);

    const played = await fx.app.inject({
        method: 'POST', url: '/play',
        payload: { flag: '百度-abcd', id: completeId, siteApi: '/aaaaaaaaaa/spider/test/3' },
    });
    assert.equal(played.statusCode, 200);
    assert.equal(fx.panCalls.at(-1).path, '/api/baidu/play');
    assert.equal(fx.panCalls.at(-1).body.id, completeId);
    assert.equal(fx.panCalls.at(-1).body.siteApi, undefined);

    await fx.detail({ 'x-tv-user': 'different-user' });
    assert.equal(detailCalls(), 2);
    assert.equal(fx.panCalls.at(-1).user, 'different-user');
    fx.setConfig({ pan_mock: false, account: { baidu: { cookie: 'test-account-changed' } } });
    await fx.detail();
    assert.equal(detailCalls(), 3, 'raw data from a different account must not be reused');
});

test('native and unrecognized private IDs retain their script flag and route', async t => {
    const fx = await fixture(t);
    for (const [flag, id] of [['蓝光HDR', 'opaque-native-id'], ['百度原画', privateId], ['光鸭原画', 'duck-id']]) {
        const result = await fx.app.inject({
            method: 'POST', url: '/play', payload: { flag, id, siteApi: '/aaaaaaaaaa/spider/test/3' },
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().nativeFlag, flag);
        assert.equal(result.json().nativeId, id);
    }
    assert.equal(fx.panCalls.length, 0);
});

test('canonical Tianyi password reaches the existing built-in play accessCode parameter', async t => {
    const fx = await fixture(t);
    await fx.app.inject({ method: 'POST', url: '/play', payload: { flag: '天翼-abcd', id: '123*456*S01E01.mkv' } });
    assert.equal(fx.panCalls[0].path, '/api/189/play');
    assert.equal(fx.panCalls[0].body.accessCode, 'abcd');
});

test('an upstream error is not cached or converted into a successful captured detail', async t => {
    let count = 0;
    const fx = await fixture(t, () => ++count === 1
        ? { status: 500, doc: { ...rawDetail(), ok: false, message: 'temporary script failure' } }
        : { doc: rawDetail() });
    const first = await fx.detail();
    assert.equal(first.statusCode, 500);
    assert.equal(first.json().ok, false);
    assert.equal(first.json()._catpaw_pan_shares, undefined);
    const second = await fx.detail();
    assert.equal(second.statusCode, 200);
    assert.equal(count, 2);
    assert.equal(second.json().list[0].vod_play_from, '百度-abcd$$$光鸭原画');
});

test('compressed cached-script detail can be normalized even without a new intercepted request', async t => {
    const fx = await fixture(t, () => {
        const doc = rawDetail();
        delete doc._catpaw_pan_shares;
        return { doc, gzip: true };
    });
    const response = await fx.detail();
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.json().list[0].vod_play_from, '百度$$$光鸭原画');
    assert.match(response.json().list[0].vod_play_url, /^https:\/\/pan\.baidu\.com\/s\/1shareA/);
});

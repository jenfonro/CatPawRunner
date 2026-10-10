import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

let fixtureId = 0;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', ...headers },
});

async function fixture(t, provider, respond) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-provider-input-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = root;
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
        account: { [provider]: { cookie: 'fixture-cookie=not-a-real-account' } },
    }));
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
        const call = { url: new URL(input), method: init.method || 'GET', body: init.body, headers: init.headers };
        calls.push(call);
        return respond(call);
    });
    const app = Fastify();
    t.after(async () => {
        await app.close();
        if (oldRoot == null) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        const resolvedRoot = fs.realpathSync(root);
        assert.equal(path.dirname(resolvedRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolvedRoot).startsWith('catpaw-provider-input-'));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    });
    // Baidu binds fetch on import. Isolate that binding for each fixture.
    const moduleName = provider === 'baidu' ? 'panBaidu' : 'panQuark';
    const { default: plugins } = await import(`../src/plugins/api/${moduleName}.js?provider-input-test=${++fixtureId}`);
    for (const entry of plugins) await app.register(entry.plugin, { prefix: entry.prefix });
    await app.ready();
    return { app, calls };
}

for (const [flag, shorturl] of [
    ['https://pan.baidu.com/s/1share-A_b?pwd=a1b2', 'share-A_b'],
    ['https://pan.baidu.com/s/11share-A_b?pwd=a1b2', '1share-A_b'],
    ['https://pan.baidu.com/share/init?surl=1share-A_b&pwd=a1b2', '1share-A_b'],
    ['百度原画-1legacyShare', 'legacyShare'],
]) {
    test(`Baidu list converts the existing input to a shorturl: ${flag}`, async t => {
        const fx = await fixture(t, 'baidu', call => {
            if (call.url.pathname === '/share/verify') {
                assert.equal(call.url.searchParams.get('surl'), shorturl);
                assert.equal(new URLSearchParams(call.body).get('pwd'), 'a1b2');
                return json({ errno: 0 }, 200, { 'set-cookie': 'BDCLND=fixture-token; Path=/' });
            }
            assert.equal(call.url.pathname, '/share/list');
            assert.equal(call.url.searchParams.get('shorturl'), shorturl);
            return json({
                errno: 0, shareid: '123', uk: '456',
                list: [{ fs_id: '789', server_filename: 'Movie.mkv', isdir: 0 }],
            });
        });
        const response = await fx.app.inject({
            method: 'POST', url: '/api/baidu/list', payload: { flag, pwd: 'a1b2' },
        });
        assert.equal(response.statusCode, 200, response.body);
        const playId = response.json().vod_play_url.split('$')[1].split('|||')[0];
        const decoded = JSON.parse(Buffer.from(playId, 'base64').toString());
        assert.equal(decoded.surl, shorturl);
        assert.equal(decoded.pwd, 'a1b2');
    });
}

for (const [flag, surl, expected] of [
    ['百度-1real-Share-a1b2', '1real-Share', '1real-Share'],
    ['百度-1real-Share', '1real-Share', '1real-Share'],
    ['百度-a1b2', '1real-Share', '1real-Share'],
    ['百度', '1real-Share', '1real-Share'],
    ['百度原画-1legacyShare', undefined, 'legacyShare'],
]) for (const route of ['play', 'share/transfer']) {
    test(`Baidu ${route} preserves share identity for ${flag}`, async t => {
        // Dlink resolution uses native http, not fetch. Keep that final request
        // on loopback as well; these tests never contact a real provider.
        const media = http.createServer((_req, res) => res.end());
        await new Promise(resolve => media.listen(0, '127.0.0.1', resolve));
        t.after(() => new Promise(resolve => { media.close(resolve); media.closeAllConnections(); }));
        const mediaUrl = `http://127.0.0.1:${media.address().port}/Movie.mkv`;
        const fx = await fixture(t, 'baidu', call => {
            switch (call.url.pathname) {
                case '/api/loginStatus': return json({ login_info: { bdstoken: 'fixture-bdstoken' } });
                case '/api/create': return json({ errno: 0, path: '/MeowFilm' });
                case '/share/verify':
                    assert.equal(call.url.searchParams.get('surl'), expected);
                    assert.equal(new URLSearchParams(call.body).get('pwd'), 'a1b2');
                    return json({ errno: 0 });
                case '/share/transfer': return json({ errno: 0 });
                case '/api/mediainfo': return json({ errno: 0, info: { dlink: mediaUrl } });
                default: assert.fail(`Unexpected network call: ${call.url.pathname}`);
            }
        });
        const id = Buffer.from(JSON.stringify({
            surl, shareid: '123', uk: '456', fs_id: '789', pwd: 'a1b2', realName: 'Movie.mkv',
        })).toString('base64') + '|||Movie.mkv';
        const response = await fx.app.inject({
            method: 'POST', url: `/api/baidu/${route}`,
            payload: { flag, id, destPath: '/MeowFilm' },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().ok, true);
        assert.equal(fx.calls.filter(call => call.url.pathname === '/share/verify').length, 1);
    });
}

for (const [status, code, message] of [
    [404, 41011, '分享地址已失效'],
    [200, 41008, '需要提取码'],
]) test(`Quark token error ${code} is not overwritten by a POST to the GET-only directory API`, async t => {
    const fx = await fixture(t, 'quark', call => {
        if (call.url.pathname.endsWith('/token')) {
            assert.equal(call.method, 'POST');
            return json({ code, message }, status);
        }
        return json({ message: "Request method 'POST' not supported" }, 405);
    });
    const response = await fx.app.inject({
        method: 'POST', url: '/api/quark/list', payload: { flag: 'https://pan.quark.cn/s/abcdef123456' },
    });
    assert.equal(response.statusCode, 502);
    assert.ok(response.json().message.includes(message));
    assert.doesNotMatch(response.json().message, /405/);
    assert.ok(fx.calls.every(call => call.url.pathname.endsWith('/token')));
});

for (const empty of [false, true]) {
    test(`Quark directory uses GET with the token and preserves an empty list (empty=${empty})`, async t => {
        const fx = await fixture(t, 'quark', call => {
            if (call.url.pathname.endsWith('/token')) {
                assert.equal(call.method, 'POST');
                assert.equal(JSON.parse(call.body).passcode, 'a1b2');
                return json({ code: 0, data: { stoken: 'fixture-stoken' } });
            }
            assert.ok(call.url.pathname.endsWith('/detail'));
            assert.equal(call.method, 'GET');
            assert.equal(call.body, undefined);
            assert.equal(call.url.searchParams.get('pwd_id'), 'abcdef123456');
            assert.equal(call.url.searchParams.get('stoken'), 'fixture-stoken');
            return json({ code: 0, data: { list: empty ? [] : [
                { fid: 'fixture-fid', share_fid_token: 'fixture-file-token', file_type: 1, file_name: 'Movie.mkv' },
            ] } });
        });
        const response = await fx.app.inject({
            method: 'POST', url: '/api/quark/list',
            payload: { flag: 'https://pan.quark.cn/s/abcdef123456', passcode: 'a1b2' },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().ok, true);
        if (empty) assert.equal(response.json().vod_play_url, '');
        else assert.match(response.json().vod_play_url, /abcdef123456\*fixture-stoken\*fixture-fid\*fixture-file-token/);
        assert.ok(fx.calls.filter(call => call.url.pathname.endsWith('/detail')).every(call => call.method === 'GET'));
    });
}

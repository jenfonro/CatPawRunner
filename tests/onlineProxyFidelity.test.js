import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Fastify from 'fastify';
import router from '../src/router.js';

async function fixture(t, handler = () => ({}), panMock = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-proxy-fidelity-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = root;
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ pan_mock: panMock, account: {} }));
    const calls = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const call = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        calls.push(call);
        const result = handler(call) || {};
        const raw = result.raw ?? JSON.stringify(result.doc ?? {});
        res.writeHead(result.status || 200, { 'content-type': 'application/json', ...result.headers });
        res.end(raw);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const app = Fastify();
    app.decorate('onlineRuntimePorts', new Map([['aaaaaaaaaa', server.address().port], ['bbbbbbbbbb', server.address().port]]));
    await app.register(router);
    await app.ready();
    t.after(async () => {
        await app.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        if (oldRoot == null) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        const resolvedRoot = fs.realpathSync(root);
        assert.equal(path.dirname(resolvedRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolvedRoot).startsWith('catpaw-proxy-fidelity-'));
        fs.rmSync(resolvedRoot, { recursive: true, force: true });
    });
    return { app, calls };
}

for (const prefix of ['/aaaaaaaaaa', '/online/aaaaaaaaaa']) {
    for (const method of ['GET', 'POST']) {
        test(`${prefix} ${method}: explicit init is forwarded intact and suppresses only the redundant automatic init`, async t => {
            const fx = await fixture(t, call => call.path.includes('/init')
                ? { raw: '{"message":"script init response","keep":true}', headers: { 'x-script-init': 'kept' } }
                : { doc: { list: [] } });
            const spider = `${prefix}/spider/${encodeURIComponent('易听测试')}/3`;
            const init = {
                method, url: `${spider}/init?ext=kept%2Bvalue`,
                headers: { 'x-script-request': 'kept' },
                ...(method === 'POST' ? { payload: { ext: { custom: 'preserved' } } } : {}),
            };
            const response = await fx.app.inject(init);
            assert.equal(response.payload, '{"message":"script init response","keep":true}');
            assert.equal(response.headers['x-script-init'], 'kept');
            await fx.app.inject({ method: 'POST', url: `${spider}/home`, payload: {} });
            await fx.app.inject({ method: 'POST', url: `${spider}/category`, payload: { id: 'singerlist', page: 1 } });
            const initCalls = () => fx.calls.filter(call => new URL(call.path, 'http://local').pathname.endsWith('/init'));
            assert.equal(initCalls().length, 1);
            assert.equal(initCalls()[0].method, method);
            assert.equal(initCalls()[0].path, `/spider/${encodeURIComponent('易听测试')}/3/init?ext=kept%2Bvalue`);
            assert.equal(initCalls()[0].headers['x-script-request'], 'kept');
            if (method === 'POST') assert.deepEqual(JSON.parse(initCalls()[0].body), init.payload);
            await fx.app.inject(init);
            assert.equal(initCalls().length, 2, 'a caller may still intentionally reinitialize the script');
        });
    }
}

test('implicit initialization still happens once per runtime/site/type, including concurrent first requests', async t => {
    const fx = await fixture(t, () => ({ doc: { list: [] } }));
    for (const [id, site, type] of [
        ['aaaaaaaaaa', 'test', '3'], ['aaaaaaaaaa', 'other', '3'],
        ['aaaaaaaaaa', 'test', '4'], ['bbbbbbbbbb', 'test', '3'],
    ]) {
        const prefix = `/${id}/spider/${site}/${type}`;
        await Promise.all(['home', 'search'].map(action => fx.app.inject({ method: 'POST', url: `${prefix}/${action}`, payload: {} })));
        await fx.app.inject({ method: 'POST', url: `${prefix}/category`, payload: {} });
    }
    assert.equal(fx.calls.filter(call => call.path.endsWith('/init')).length, 4);
});

test('a failed explicit init keeps the script status/body and does not count as successful initialization', async t => {
    let initCount = 0;
    const fx = await fixture(t, call => call.path.endsWith('/init') && ++initCount === 1
        ? { status: 500, raw: 'original init error', headers: { 'content-type': 'text/plain' } }
        : { doc: { list: [] } });
    const prefix = '/aaaaaaaaaa/spider/test/3';
    const result = await fx.app.inject({ method: 'POST', url: `${prefix}/init`, payload: {} });
    assert.equal(result.statusCode, 500);
    assert.equal(result.payload, 'original init error');
    await fx.app.inject({ method: 'POST', url: `${prefix}/home`, payload: {} });
    assert.equal(initCount, 2);
});

test('successful explicit init through one alias also suppresses redundant init through the other alias', async t => {
    const fx = await fixture(t);
    await fx.app.inject({ method: 'POST', url: '/online/aaaaaaaaaa/spider/test/3/init', payload: {} });
    await fx.app.inject({ method: 'POST', url: '/aaaaaaaaaa/spider/test/3/home', payload: {} });
    assert.equal(fx.calls.filter(call => call.path.endsWith('/init')).length, 1);
});

test('a website path resembling init must not suppress the actual spider initialization', async t => {
    const fx = await fixture(t, call => call.path.startsWith('/website/')
        ? { raw: 'original website response', headers: { 'content-type': 'text/plain' } }
        : { doc: { list: [] } });
    const response = await fx.app.inject({
        method: 'GET', url: '/website/spider/website-scope/3/init',
        headers: { cookie: 'catpaw_runtime_id=aaaaaaaaaa' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload, 'original website response');
    await fx.app.inject({ method: 'POST', url: '/aaaaaaaaaa/spider/website-scope/3/home', payload: {} });
    assert.deepEqual(fx.calls.map(call => call.path), [
        '/website/spider/website-scope/3/init', '/spider/website-scope/3/init', '/spider/website-scope/3/home',
    ]);
});

test('explicit init only registers its own runtime, site and type', async t => {
    const fx = await fixture(t);
    await fx.app.inject({ method: 'POST', url: '/aaaaaaaaaa/spider/test/3/init', payload: {} });
    for (const [runtime, site, type] of [
        ['aaaaaaaaaa', 'test', '3'], ['aaaaaaaaaa', 'other', '3'],
        ['aaaaaaaaaa', 'test', '4'], ['bbbbbbbbbb', 'test', '3'],
    ]) {
        await fx.app.inject({ method: 'POST', url: `/${runtime}/spider/${site}/${type}/home`, payload: {} });
    }
    assert.deepEqual(fx.calls.filter(call => call.path.endsWith('/init')).map(call => call.path), [
        '/spider/test/3/init', '/spider/other/3/init', '/spider/test/4/init', '/spider/test/3/init',
    ]);
});

for (const panMock of [true, false]) {
    test(`error fidelity (pan_mock=${panMock}): returned errors remain visible; a swallowed error is not invented`, async t => {
        let returned = {};
        const fx = await fixture(t, call => call.path.endsWith('/init') ? {} : returned, panMock);
        let seq = 0;
        for (const action of ['home', 'category', 'detail', 'search', 'play']) {
            for (const example of [
                { status: 500, doc: { statusCode: 500, error: 'Internal Server Error', message: "Cannot read properties of undefined (reading 'children')" } },
                { status: 500, raw: '1040 Too many connections', headers: { 'content-type': 'text/plain' } },
                { status: 200, doc: { ok: false, message: 'original business error', list: [] } },
                { status: 200, doc: { code: 400, msg: 'original msg', error: 'original error', list: [] } },
                { status: 200, doc: { list: [] } },
            ]) {
                returned = example;
                const response = await fx.app.inject({
                    method: 'POST', url: `/aaaaaaaaaa/spider/test/3/${action}`, payload: { id: `mode-${panMock}-case-${++seq}` },
                });
                assert.equal(response.statusCode, example.status, action);
                if (example.raw != null) assert.equal(response.payload, example.raw, action);
                else {
                    const actual = response.json();
                    for (const [key, value] of Object.entries(example.doc)) assert.deepEqual(actual[key], value, `${action}.${key}`);
                    if (!example.doc.message && !example.doc.msg && !example.doc.error) {
                        assert.equal(actual.message, undefined, action);
                        assert.equal(actual.msg, undefined, action);
                        assert.equal(actual.error, undefined, action);
                        assert.equal(actual.ok, undefined, action);
                    }
                }
            }
        }
    });
}

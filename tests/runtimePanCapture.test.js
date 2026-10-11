import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as zlib from 'node:zlib';
import { createRuntimePanCapture } from '../src/util/runtimePanCapture.js';
import * as spiderRoutes from '../src/util/spiderRouteMatcher.js';

test('the actual runtime wrapper scopes new capture to POST detail/category requests', () => {
    const source = fs.readFileSync(new URL('../src/util/onlineRuntime.js', import.meta.url), 'utf8');
    const start = source.indexOf('globalThis.__catpaw_runtime_with_request = ');
    const end = source.indexOf('const __sanitizeSeg', start);
    assert.ok(start >= 0 && end > start);
    // Evaluate this actual bootstrap-template fragment with the same route
    // predicate interpolation. No child script or external network is needed.
    const generated = new Function('isSpiderPanDetailRequest', `return \`${source.slice(start, end)}\`;`)(
        spiderRoutes.isSpiderPanDetailRequest,
    );
    const als = new AsyncLocalStorage();
    const context = {
        globalThis: {}, __siteAls: als,
        __extractSiteFromReqUrl: () => 'test:3',
        __panCapture: { wrapResponse: res => { res.wrapped = true; } },
    };
    vm.runInNewContext(generated, context);
    const handle = (_req, res) => ({ captured: !!als.getStore().panShares, wrapped: !!res.wrapped, site: als.getStore().site });
    const wrap = context.globalThis.__catpaw_runtime_with_request;
    for (const action of ['home', 'search', 'init', 'play', 'proxy', 'resources', 'refresh']) {
        assert.deepEqual(wrap({ method: 'POST', url: `/spider/test/3/${action}` }, {}, handle),
            { captured: false, wrapped: false, site: 'test:3' }, action);
    }
    for (const action of ['detail', 'category']) {
        assert.deepEqual(wrap({ method: 'POST', url: `/spider/test/3/${action}?page=1` }, {}, handle),
            { captured: true, wrapped: true, site: 'test:3' });
        for (const method of ['GET', 'PUT']) {
            assert.deepEqual(wrap({ method, url: `/spider/test/3/${action}` }, {}, handle),
                { captured: false, wrapped: false, site: 'test:3' }, `${method} ${action}`);
        }
    }
});

async function fixture(t, handler) {
    const als = new AsyncLocalStorage();
    const capture = createRuntimePanCapture({
        getStore: () => als.getStore(),
        extractCreds: (_provider, _host, path, _headers, body) => ({
            ...Object.fromEntries(new URL(path, 'https://capture.invalid').searchParams),
            ...(body ? JSON.parse(body) : {}),
        }),
        placeholderCache: {},
        getTianyiCache: () => ({}),
        zlib,
    });
    const server = http.createServer((req, res) => {
        const store = req.url.startsWith('/detail') ? { panShares: new Map() } : {};
        als.run(store, async () => {
            capture.wrapResponse(res, store);
            try { await handler(req, res, capture); }
            catch (error) { res.destroy(error); }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return (path = '/detail') => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path }, res => {
            const chunks = [];
            res.on('error', reject);
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode }));
        }).on('error', reject);
    });
}

const record = (capture, id = 'shareA', password = '') =>
    capture.record('quark', { path: '/share/token', body: JSON.stringify({ pwd_id: id, passcode: password }) });

test('response bridge appends per-request metadata without corrupting chunked JSON or headers', async t => {
    let callbacks = 0;
    const get = await fixture(t, (_req, res, capture) => {
        record(capture, 'shareA', 'abcd');
        const body = JSON.stringify({ list: [{ vod_name: 'Example' }] });
        res.writeHead(200, 'OK', ['Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)), 'ETag', '"stale"', 'X-Test', 'kept']);
        res.flushHeaders();
        res.write(body.slice(0, 12), () => { callbacks += 1; });
        res.end(body.slice(12), () => { callbacks += 1; });
    });
    const result = await get();
    const body = JSON.parse(result.body);
    assert.equal(body.list[0].vod_name, 'Example');
    assert.equal(body._catpaw_pan_shares.length, 1);
    assert.equal(body._catpaw_pan_shares[0].password, 'abcd');
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers['x-test'], 'kept');
    assert.ok(result.headers['content-length'] == null || Number(result.headers['content-length']) === result.body.length);
    assert.equal(callbacks, 2);
});

test('compressed JSON is rewritten as valid uncompressed JSON when capture metadata is present', async t => {
    for (const [encoding, compress] of [
        ['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync],
    ]) {
        const get = await fixture(t, (_req, res, capture) => {
            record(capture);
            const body = compress(Buffer.from('{"list":[]}'));
            res.writeHead(200, { 'content-encoding': encoding, 'content-length': body.length, 'content-type': 'application/json' });
            res.end(body);
        });
        const result = await get();
        assert.equal(result.headers['content-encoding'], undefined);
        assert.equal(JSON.parse(result.body)._catpaw_pan_shares.length, 1);
        assert.ok(result.headers['content-length'] == null || Number(result.headers['content-length']) === result.body.length);
    }
});

test('concurrent detail requests never share captures; same-share repeated capture only enriches passwords', async t => {
    const get = await fixture(t, async (req, res, capture) => {
        const id = new URL(req.url, 'http://local').searchParams.get('id');
        record(capture, id, id === 'shareA' ? 'abcd' : '');
        await new Promise(resolve => setTimeout(resolve, id === 'shareA' ? 15 : 1));
        record(capture, id);
        res.end('{"list":[]}');
    });
    const results = await Promise.all([get('/detail?id=shareA'), get('/detail?id=shareB')]);
    const captures = results.map(result => JSON.parse(result.body)._catpaw_pan_shares);
    assert.deepEqual(captures.map(items => items.length), [1, 1]);
    assert.equal(captures[0][0].url, 'https://pan.quark.cn/s/shareA');
    assert.equal(captures[0][0].password, 'abcd');
    assert.equal(captures[1][0].url, 'https://pan.quark.cn/s/shareB');
    assert.equal(captures[1][0].password, '');
});

test('capture does not silently discard distinct shares after an arbitrary item count', async t => {
    const get = await fixture(t, (_req, res, capture) => {
        for (let index = 0; index < 300; index += 1) record(capture, `share${index}`);
        record(capture, 'share299', 'abcd');
        res.end('{"list":[]}');
    });
    const captures = JSON.parse((await get()).body)._catpaw_pan_shares;
    assert.equal(captures.length, 300);
    assert.equal(captures[299].url, 'https://pan.quark.cn/s/share299');
    assert.equal(captures[299].password, 'abcd');
});

test('native play and malformed/non-object detail bodies remain byte-for-byte unchanged', async t => {
    for (const [path, body] of [['/play', '{"url":"native"}'], ['/detail', '{"broken"'], ['/detail', '[]']]) {
        const get = await fixture(t, (_req, res, capture) => {
            record(capture);
            res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
            res.end(body);
        });
        assert.equal((await get(path)).body.toString(), body);
    }
});

test('no-capture compressed response retains its original representation and encoding', async t => {
    const compressed = zlib.gzipSync(Buffer.from('{"list":[]}'));
    const get = await fixture(t, (_req, res) => {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
        res.end(compressed);
    });
    const result = await get();
    assert.equal(result.headers['content-encoding'], 'gzip');
    assert.deepEqual(result.body, compressed);
});

test('oversize streaming details fall back to native streaming without dropping chunks', async t => {
    const first = Buffer.alloc(8 * 1024 * 1024, 65);
    const get = await fixture(t, (_req, res, capture) => {
        record(capture);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write(first);
        res.write('B');
        res.end('C');
    });
    const result = await get();
    assert.equal(result.body.length, first.length + 2);
    assert.deepEqual(result.body.subarray(0, first.length), first);
    assert.equal(result.body.subarray(-2).toString(), 'BC');
});

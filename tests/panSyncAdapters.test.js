import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import adminPlugins from '../src/plugins/api/admin.js';
import { detectOnlineScriptProtocol } from '../src/util/onlineScriptAdapters.js';
import { readJsonObjectSafe, writeJsonObjectAtomic } from '../src/util/onlineConfigStore.js';

const legacyPaths = {
    '/website/quark/cookie': '',
    '/website/uc/cookie': '',
    '/website/baidu/cookie': '',
    '/website/115/cookie': '',
    '/website/tianyi/account': { username: '', password: '' },
    '/website/pan123/account': { username: '', password: '' },
    '/website/bili/cookie': '',
    '/website/wuming/cookie': '',
};
const credentials = {
    quark: { cookie: '' }, uc: { cookie: '' }, baidu: { cookie: '' },
    pan115: { cookie: '' }, pan123: { account: '', password: '' },
    pan189: { account: '', password: '', cookie: '' }, bili: { cookie: '' },
    new139: { session: '' },
};
const modernPaths = [
    '/website/api/credential/quark/cookie', '/website/api/credential/uc/cookie',
    '/website/api/credential/baidu/cookie', '/website/api/pan115/cookie',
    '/website/api/pan189/account', '/website/api/pan123/account', '/website/api/bili/cookie',
];

async function mockScript(mode) {
    const app = Fastify();
    const calls = [];
    const overrides = new Map();
    app.all('/*', async (req, reply) => {
        calls.push({ method: req.method, path: req.url, body: req.body });
        const override = overrides.get(`${req.method} ${req.url}`);
        if (override) return reply.code(override.status || 200).send(override.data);
        if (mode === 'unknown') return reply.type('text/html').send('<html>not a management API</html>');
        if (req.method === 'GET') {
            if (mode === 'legacy' && req.url === '/website/pans/list') return { code: 0, data: [{ key: 'quark', name: '夸克' }] };
            if (mode === 'legacy' && Object.hasOwn(legacyPaths, req.url)) return { code: 0, data: legacyPaths[req.url] };
            if (mode === 'modern' && req.url === '/website/api/credentials') return { code: 0, data: credentials };
        }
        const supported = mode === 'legacy' ? Object.hasOwn(legacyPaths, req.url) : modernPaths.includes(req.url);
        if (req.method === 'PUT' && supported) return { code: 0 };
        return reply.code(404).send({ message: 'not found' });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    return { app, calls, overrides, port: app.server.address().port };
}

test('sync dispatches each credential to every compatible native script API', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catpaw-pan-sync-'));
    const oldRoot = process.env.NODE_PATH;
    process.env.NODE_PATH = root;
    const cfgPath = path.join(root, 'config.json');
    writeJsonObjectAtomic(cfgPath, { proxy: 'unchanged' });
    fs.writeFileSync(path.join(root, 'db.json'), '{"untouched":true}');
    const legacy = await mockScript('legacy');
    const modern = await mockScript('modern');
    const unknown = await mockScript('unknown');
    const ports = new Map([['aaaaaaaaaa', legacy.port], ['bbbbbbbbbb', modern.port], ['cccccccccc', unknown.port]]);
    const app = Fastify();
    app.decorate('onlineRuntimePorts', ports);
    await app.register(adminPlugins[0].plugin, { prefix: '/admin' });
    const sync = async (pans) => {
        const response = await app.inject({ method: 'POST', url: '/admin/pan/sync', payload: { pans } });
        assert.equal(response.statusCode, 200);
        return response.json();
    };
    const writes = (script) => script.calls.filter((call) => call.method === 'PUT');
    try {
        await t.test('read-only identification stores only protocol and field names', async () => {
            const old = await detectOnlineScriptProtocol(legacy.port);
            const next = await detectOnlineScriptProtocol(modern.port);
            assert.equal(old.type, 'website-v1');
            assert.equal(next.type, 'website-api-v1');
            assert.deepEqual(next.fields.pan123, ['account', 'password']);
            assert.equal((await detectOnlineScriptProtocol(unknown.port)).type, 'unknown');
            assert.equal(writes(legacy).length + writes(modern).length + writes(unknown).length, 0);
        });

        await t.test('mixed scripts keep their routes and receive the correct field names', async () => {
            const result = await sync({
                quark: { cookie: 'test-quark-cookie' }, uc: { cookie: 'test-uc-cookie' }, baidu: { cookie: 'test-baidu-cookie' },
                '189': { username: 'test-user', password: 'test-pass' },
                pan123: { username: 'test-user123', password: 'test-pass123' },
                '115': { cookie: 'test-115-cookie' }, bili: { cookie: 'test-bili-cookie' },
                wuming: { cookie: 'test-wuming-cookie' },
            });
            assert.equal(result.okCount, 8);
            assert.equal(result.failCount, 0);
            assert.equal(writes(legacy).length, 8);
            assert.equal(writes(modern).length, 7);
            assert.equal(writes(unknown).length, 0);
            assert.deepEqual(writes(legacy).find((c) => c.path === '/website/tianyi/account').body, { username: 'test-user', password: 'test-pass' });
            assert.deepEqual(writes(modern).find((c) => c.path === '/website/api/pan189/account').body, { account: 'test-user', password: 'test-pass' });
            assert.deepEqual(writes(modern).find((c) => c.path === '/website/api/credential/quark/cookie').body, { value: 'test-quark-cookie' });
            assert.deepEqual(writes(modern).find((c) => c.path === '/website/api/pan115/cookie').body, { value: 'test-115-cookie' });
            assert.equal(result.results.find((r) => r.key === 'quark').scripts.filter((r) => !r.skipped).length, 2);
            assert.equal(result.results.find((r) => r.key === 'wuming').scripts[1].skipped, true);
            const cfg = readJsonObjectSafe(cfgPath);
            assert.equal(cfg.proxy, 'unchanged');
            assert.equal(cfg.account.quark.cookie, 'test-quark-cookie');
            assert.equal(cfg.account['189'].username, 'test-user');
            assert.equal(fs.readFileSync(path.join(root, 'db.json'), 'utf8'), '{"untouched":true}');
            assert.doesNotMatch(JSON.stringify(result), /test-quark-cookie|test-pass/);
        });

        await t.test('139 and TV credentials remain builtin-only when no compatible native save API exists', async () => {
            const before = writes(legacy).length + writes(modern).length;
            const result = await sync({
                '139': { authorization: 'test-139' },
                quark_tv: { refresh_token: 'test-q-refresh', device_id: 'test-q-device' },
                uc_tv: { refreshToken: 'test-u-refresh', deviceId: 'test-u-device' },
            });
            assert.equal(result.okCount, 3);
            assert.equal(result.failCount, 0);
            assert.equal(writes(legacy).length + writes(modern).length, before);
            assert.ok(result.results.every((r) => r.builtin.ok && !r.builtin.skipped && r.scripts.every((s) => s.skipped)));
            const cfg = readJsonObjectSafe(cfgPath);
            assert.equal(cfg.account['139'].authorization, 'test-139');
            assert.equal(cfg.account.quark_tv.refresh_token, 'test-q-refresh');
            assert.equal(cfg.account.uc_tv.device_id, 'test-u-device');
        });

        await t.test('resolver support alone does not imply a credential save endpoint', async () => {
            const before = writes(legacy).length;
            legacy.overrides.set('GET /website/quark/cookie', { status: 404, data: {} });
            const result = await sync({ quark: { cookie: 'another-cookie' } });
            assert.equal(writes(legacy).length, before);
            assert.equal(result.results[0].scripts[0].skipped, true);
            assert.equal(result.results[0].scripts[1].skipped, false);
            legacy.overrides.clear();
        });

        await t.test('a script failure does not stop other scripts or builtin persistence', async () => {
            legacy.overrides.set('PUT /website/quark/cookie', { data: { code: -1, message: 'save refused' } });
            const before = writes(modern).length;
            const result = await sync({ quark: { cookie: 'still-save-modern' } });
            assert.equal(result.okCount, 0);
            assert.equal(result.failCount, 1);
            assert.equal(writes(modern).length, before + 1);
            assert.equal(result.results[0].builtin.ok, true);
            assert.equal(result.results[0].scripts[0].ok, false);
            assert.equal(result.results[0].scripts[1].ok, true);
            assert.match(result.results[0].message, /aaaaaaaaaa: save refused/);
            assert.equal(readJsonObjectSafe(cfgPath).account.quark.cookie, 'still-save-modern');
            legacy.overrides.clear();
        });

        await t.test('HTML success, malformed success codes and SMS confirmation are not successful saves', async () => {
            for (const data of ['<html>error</html>', { code: null }, { code: -1, msg: 'refused' }, { code: 0, sms: true, msg: 'enter SMS' }]) {
                modern.overrides.set('PUT /website/api/pan189/account', { data });
                const result = await sync({ '189': { username: 'test-user', password: 'test-pass' } });
                assert.equal(result.failCount, 1);
                assert.equal(result.results[0].scripts[1].ok, false);
            }
            modern.overrides.clear();
        });

        await t.test('missing modern capability and unsupported/empty accounts never generate writes', async () => {
            modern.overrides.set('GET /website/api/credentials', { data: { code: 0, data: { quark: { cookie: '' } } } });
            const before = writes(modern).length;
            const result = await sync({ '115': { cookie: 'test-cookie' }, quark: { cookie: '' }, nonexistent: { cookie: 'test-cookie' } });
            assert.equal(writes(modern).length, before);
            assert.equal(result.results[0].scripts[1].skipped, true);
            assert.equal(result.results[1].skipped, true);
            assert.equal(result.results[2].skipped, true);
            modern.overrides.clear();
        });

        await t.test('no runtimes does not prevent builtin credentials being saved', async () => {
            ports.clear();
            const result = await sync({ quark: { cookie: 'offline-cookie' }, '139': { authorization: 'offline-auth' } });
            assert.equal(result.okCount, 2);
            assert.equal(readJsonObjectSafe(cfgPath).account.quark.cookie, 'offline-cookie');
            assert.ok(result.results.every((r) => r.scripts.length === 0));
        });
    } finally {
        await app.close();
        await Promise.all([legacy.app.close(), modern.app.close(), unknown.app.close()]);
        if (oldRoot === undefined) delete process.env.NODE_PATH;
        else process.env.NODE_PATH = oldRoot;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

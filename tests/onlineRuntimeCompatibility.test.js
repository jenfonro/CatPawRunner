import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as nodeCrypto from 'node:crypto';

const source = fs.readFileSync(new URL('../src/util/onlineRuntime.js', import.meta.url), 'utf8');

function fragment(startText, endText) {
    const start = source.indexOf(startText);
    const end = source.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, startText);
    // Exercise the generated bootstrap, including its template escaping.
    return new Function(`return \`${source.slice(start, end)}\`;`)();
}

function runtimeHelpers() {
    const context = { Buffer, URL, nodeCrypto, globalThis: {} };
    vm.runInNewContext([
        `const __tryParseJson = raw => { try { return JSON.parse(raw); } catch (_) { return null; } };`,
        fragment('const __parseUrlEncoded = ', 'const __panCapture = '),
        fragment('const __sanitizeSeg = ', '/* Tape (record/replay)'),
        fragment('const __pan139MockPayloadFor = ', 'const __pan139Interceptor = '),
        fragment('const ensureConfigDefaults = ', 'const patchBodyShape = '),
        `globalThis.helpers = {
            defaults: ensureConfigDefaults, creds: __extractInterceptCreds,
            mock139: __pan139MockPayloadFor, cache: __placeholderCache,
        };`,
    ].join('\n'), context);
    return context.globalThis.helpers;
}

const aesKey = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8');
function encrypt(value) {
    const iv = Buffer.alloc(16, 7);
    const cipher = nodeCrypto.createCipheriv('aes-128-cbc', aesKey, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
}
function decrypt(value) {
    const bytes = Buffer.from(value, 'base64');
    const decipher = nodeCrypto.createDecipheriv('aes-128-cbc', aesKey, bytes.subarray(0, 16));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
}

const outlinkPath = '/orchestration/personalCloud-rebuild/outside/v1.0/IOutLink/getOutLinkInfoV6';
const plainObject = value => JSON.parse(JSON.stringify(value));

test('Baidu defaults provide an empty cookie without replacing a configured cookie or other config', () => {
    const { defaults } = runtimeHelpers();
    for (const initial of [undefined, {}, { baidu: {} }, { baidu: null }, { baidu: { cookie: null } }]) {
        const server = { config: initial };
        defaults(server);
        assert.equal(server.config.baidu.cookie, '');
        assert.equal(server.config.baidu.cookie.replace(/BDUSS=/g, ''), '');
    }
    const server = { config: { baidu: { cookie: 'BDUSS=test-only;', extra: true }, custom: { keep: 1 } } };
    defaults(server);
    defaults(server);
    assert.equal(server.config.baidu.cookie, 'BDUSS=test-only;');
    assert.equal(server.config.baidu.extra, true);
    assert.equal(server.config.custom.keep, 1);
});

for (const protocol of ['plain-json', 'aes-json-string', 'aes-raw']) {
    const bodyFor = value => protocol === 'plain-json' ? JSON.stringify(value)
        : protocol === 'aes-json-string' ? JSON.stringify(encrypt(value)) : encrypt(value);

    test(`139 ${protocol}: capture preserves share, folder, file and password fields`, () => {
        const { creds } = runtimeHelpers();
        for (const requestName of ['getOutLinkInfoReq', 'dlFromOutLinkReq', 'dlFromOutLinkReqV3']) {
            for (const passwordKey of ['passwd', 'passwdStr', 'password', 'pwd']) {
                const body = bodyFor({
                    [requestName]: { linkID: 'shareA', pCaID: 'folderA', contentId: 'fileA', [passwordKey]: 'abcd' },
                });
                assert.deepEqual(plainObject(creds('139', 'caiyun.feixin.10086.cn', outlinkPath, {}, body)), {
                    linkID: 'shareA', pCaID: 'folderA', contentId: 'fileA', passwd: 'abcd', hasPassword: true,
                });
            }
        }
    });

    test(`139 ${protocol}: mock answers in the request protocol and keeps distinct shares/folders`, () => {
        const { mock139, cache } = runtimeHelpers();
        const ids = [];
        for (const [share, folder, password] of [
            ['shareA', 'root', 'abcd'], ['shareA', 'folderA', 'abcd'], ['shareB', 'root', ''],
        ]) {
            const response = mock139({
                path: outlinkPath,
                body: bodyFor({ getOutLinkInfoReq: { linkID: share, pCaID: folder, passwd: password } }),
            });
            assert.equal(response.kind, 'outlink_info');
            const payload = JSON.parse(response.payload);
            assert.equal(typeof payload, protocol === 'plain-json' ? 'object' : 'string');
            const result = protocol === 'plain-json' ? payload : decrypt(payload);
            assert.equal(result.code, 0);
            assert.equal(result.data.caLst, null);
            assert.equal(result.data.coLst.length, 1);
            assert.equal(result.data.coLst[0].coName, `${password || 'nopass'}.mp4`);
            ids.push(result.data.coLst[0].coID);
            assert.deepEqual(plainObject(cache['139'].get(share)), { shareCode: share, password });
        }
        assert.equal(new Set(ids).size, 3);
        assert.equal(cache['139'].size, 2, 'do not deduplicate different shares by provider name');
    });
}

test('139 compatibility does not reinterpret unrelated endpoints or change other provider extraction', () => {
    const { creds, mock139 } = runtimeHelpers();
    assert.deepEqual(plainObject(creds('139', '', '/unrelated', {}, '{"linkID":"not-a-share"}')), {});
    assert.equal(mock139({ path: '/unrelated', body: '{}' }).kind, 'blocked');
    assert.deepEqual(plainObject(creds('baidu', '', '/share?shorturl=shareA', {}, 'pwd=abcd')), {
        shorturl: 'shareA', pwd: 'abcd', hasPassword: true,
    });
    assert.deepEqual(plainObject(creds('quark', '', '/share/token', {}, '{"pwd_id":"shareB","passcode":"efgh"}')), {
        pwd_id: 'shareB', passcode: 'efgh', hasPassword: true,
    });
});

test('139 generated AES decoders preserve base64 s characters and tolerate whitespace/url-safe padding', () => {
    const { creds, mock139 } = runtimeHelpers();
    const encoded = encrypt({ getOutLinkInfoReq: { linkID: 'shareA', pCaID: 'folderA', passwd: 'abcd' } });
    assert.ok(encoded.includes('s'), 'fixture must exercise the bootstrap escape regression');
    const variants = [
        encoded.replace(/(.{12})/g, '$1 \n\t'),
        encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    ];
    for (const value of variants) {
        const body = JSON.stringify(value);
        assert.equal(creds('139', '', outlinkPath, {}, body).linkID, 'shareA');
        const response = mock139({ path: outlinkPath, body });
        assert.equal(response.kind, 'outlink_info');
        assert.equal(decrypt(JSON.parse(response.payload)).data.coLst[0].coName, 'abcd.mp4');
    }
});

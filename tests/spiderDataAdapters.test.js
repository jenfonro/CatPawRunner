import test from 'node:test';
import assert from 'node:assert/strict';
import { getOnlineScriptDataAdapter } from '../src/util/onlineScriptAdapters.js';
import {
    legacySpiderDataAdapter, panServiceSpiderDataAdapter, parseSpiderOperation,
    rewritePanServiceMockDetailFields,
} from '../src/util/spiderDataAdapters.js';
import { buildSpiderCacheKey, getOrCreateSpiderCache } from '../src/util/runtimeSpiderCache.js';

const encode = (item) => Buffer.from(JSON.stringify(item)).toString('base64');
const episode = (providerId, shareId, playToken = {}, mode = 'original', name = '[874.0MB]nopass.mp4') =>
    `${name}$${encode({ providerId, shareId, fileId: 'file-1', name, playToken: JSON.stringify(playToken), mode, quality: mode })}`;
const rewrite = (flags, urls) => rewritePanServiceMockDetailFields(flags.join('$$$'), urls.join('$$$'));

test('data adapters use detected protocol, never runtime IDs, filenames or site names', () => {
    assert.equal(getOnlineScriptDataAdapter({ type: 'website-v1' }), legacySpiderDataAdapter);
    assert.equal(getOnlineScriptDataAdapter({ type: 'website-api-v1', filename: 'anything.cjs' }), panServiceSpiderDataAdapter);
    assert.equal(getOnlineScriptDataAdapter('website-api-v1').id, 'pan-service-v1');
    assert.equal(getOnlineScriptDataAdapter({ type: 'unknown', filename: 'index.a28bca10d1.js' }), legacySpiderDataAdapter);
    assert.equal(getOnlineScriptDataAdapter(undefined), legacySpiderDataAdapter);
    for (const operation of ['home', 'category', 'search', 'detail', 'play']) {
        assert.equal(parseSpiderOperation(`/spider/arbitrary/3/${operation}?id=1`), operation);
    }
    for (const path of ['/website/api/credentials', '/spider/a/3/play/proxy', '/api/quark/list', '/spider/a/3/init']) {
        assert.equal(parseSpiderOperation(path), '');
    }
});

test('native mode preserves the full detail and opaque playback ID round trip', () => {
    const row = {
        vod_id: 'detail-1', vod_name: 'Sample', vod_pic: '/cover.jpg', subtitle: ['captions'],
        vod_play_from: '夸克原画#01$$$夸克极速#01$$$百度原画(无限)',
        vod_play_url: [
            episode('quark', 'quark01', { stoken: 'native-test-token', fileName: 'E01.mkv' }),
            episode('quark', 'quark01', { stoken: 'native-test-token', fileName: 'E01.mkv' }, 'speed'),
            episode('baidu', '1public01', { shareId: '12345', uk: '456', pwd: 'aB12' }, 'unlimited'),
        ].join('$$$'),
    };
    const source = { list: [row], msg: 'ok', extra: { value: 1 }, pan_mock: true };
    const snapshot = structuredClone(source);
    const normalized = panServiceSpiderDataAdapter.response(source, { operation: 'detail', panMock: false });
    assert.deepEqual(normalized, { ...source, pan_mock: false });
    assert.deepEqual(source, snapshot);
    const body = { flag: row.vod_play_from.split('$$$')[1], id: row.vod_play_url.split('$$$')[1].split('$')[1], subtitle: 'x' };
    assert.equal(panServiceSpiderDataAdapter.request(body, { operation: 'play', panMock: false }), body);
    assert.equal(JSON.parse(Buffer.from(body.id, 'base64')).quality, 'speed');
    for (const operation of ['home', 'category', 'search']) {
        assert.equal(panServiceSpiderDataAdapter.response(source, { operation, panMock: true }), source);
    }
});

test('mock mode maps all five providers to existing flags and access-code slots', () => {
    const result = rewrite(
        ['夸克原画', '夸克极速', 'UC原画', 'UC极速', 'UC原画(无限)', '百度原画', '百度原画(无限)', '天翼原画', '移动原画', '移动极速'],
        [
            episode('quark', 'quark01'), episode('quark', 'quark01', {}, 'speed'),
            episode('uc', 'ucshare01', { fileName: 'Ab12.mp4' }), episode('uc', 'ucshare01', { fileName: 'Ab12.mp4' }, 'speed'),
            episode('uc', 'ucshare01', { fileName: 'Ab12.mp4' }, 'unlimited'),
            episode('baidu', '1public01', { shareId: 'numeric-private-id', pwd: 'bC23' }),
            episode('baidu', '1public01', { shareId: 'numeric-private-id', pwd: 'bC23' }, 'unlimited'),
            episode('pan189', 'Tianyi01', { shareId: 'numeric-private-id', fileName: 'Tianyi01-Cd34.MP4' }),
            episode('new139', 'mobile01', { shareCode: 'mobile01', passCode: 'De45' }),
            episode('new139', 'mobile01', { shareCode: 'mobile01', passCode: 'De45' }, 'speed'),
        ],
    );
    assert.deepEqual(result, {
        vod_play_from: '夸父-quark01$$$优夕-ucshare01$$$百度原画-1public01$$$天意-Tianyi01$$$逸动-mobile01',
        vod_play_url: '$$$Ab12$$$bC23$$$Cd34$$$De45',
    });
    assert.equal(result.vod_play_from.includes('numeric-private-id'), false);
});

test('mock conversion preserves multi-share order and avoids duplicate flag/password collisions', () => {
    const result = rewrite(
        ['夸克原画#01', '夸克极速#01', '夸克原画#02', '夸克极速#02', '夸克原画(无限)#01'],
        [
            episode('quark', 'share01'), episode('quark', 'share01', { passcode: 'Ab12' }, 'speed'),
            episode('quark', 'share02', { passcode: 'Cd34' }), episode('quark', 'share02', { passcode: 'Cd34' }, 'speed'),
            episode('quark', 'share01', { passcode: 'conflict' }, 'unlimited'),
        ],
    );
    assert.deepEqual(result, { vod_play_from: '夸父-share01$$$夸父-share02', vod_play_url: 'Ab12$$$Cd34' });
});

test('passcode sentinels only apply to placeholders, not explicit access-code fields', () => {
    const urls = [
        episode('quark', 'share01', { fileName: 'nopass.mp4' }),
        episode('uc', 'share02', { fileName: 'root12.mp4' }),
        episode('baidu', 'share03', { pwd: 'root12', fileName: 'nopass.mp4' }),
        episode('new139', 'share04', { passCode: '', fileName: 'NotAPassword.mp4' }),
        episode('pan189', 'Tianyi01', { fileName: 'Tianyi01_Ab12-nopass.MP4' }),
        episode('pan189', 'Tianyi02', { fileName: 'Tianyi02-nopass.MP4' }),
    ];
    assert.deepEqual(rewrite(urls.map(() => 'native'), urls).vod_play_url.split('$$$'), ['', '', 'root12', '', 'Ab12', '']);
});

test('direct, unknown-provider and malformed tracks pass through without inventing share IDs', () => {
    const unsupported = episode('pan115', 'share01', { pickCode: 'native-pick-code' });
    const badIds = [
        'movie$https://example.invalid/play.m3u8',
        'movie$not base64', 'movie$' + encode({ providerId: 'quark', fileId: '1' }),
        'movie$' + encode({ providerId: 'quark', shareId: 'bad#share', fileId: '1' }),
        'movie$' + encode({ providerId: 'pan189', shareId: 'bad_id', fileId: '1' }),
        'movie$' + 'a'.repeat(128 * 1024 + 1),
    ];
    const nativeURLs = [unsupported, ...badIds];
    const flags = nativeURLs.map((_, i) => `native-${i}`);
    const result = rewrite([...flags, '夸克原画'], [...nativeURLs, episode('quark', 'share02')]);
    assert.equal(result.vod_play_from, [...flags, '夸父-share02'].join('$$$'));
    assert.equal(result.vod_play_url, [...nativeURLs, ''].join('$$$'));
    const mixed = `${episode('quark', 'share02')}#movie$bad`;
    assert.deepEqual(rewrite(['mixed'], [mixed]), { vod_play_from: 'mixed', vod_play_url: mixed });
});

test('all detail rows normalize; legacy protocol still uses its existing codec', () => {
    const modern = { vod_play_from: '夸克原画', vod_play_url: episode('quark', 'share01') };
    const source = { list: [modern, null, { ...modern, vod_name: 'other' }], msg: 'ok' };
    const result = panServiceSpiderDataAdapter.response(source, { operation: 'detail', panMock: true });
    for (const index of [0, 2]) {
        assert.equal(result.list[index].vod_play_from, '夸父-share01');
        assert.equal(result.list[index].vod_play_url, '');
    }
    assert.equal(result.list[1], null);
    assert.equal(source.list[0].vod_play_from, '夸克原画');
    const legacy = { list: [
        { vod_play_from: '夸父-share01', vod_play_url: '[874MB]Ab12.mp4$opaque-old-id' },
        { vod_play_from: '百度原画-share02#01', vod_play_url: 'nopass.mp4$opaque-old-id' },
    ] };
    const old = legacySpiderDataAdapter.response(legacy, { operation: 'detail', panMock: true });
    assert.equal(old.list[0].vod_play_url, 'Ab12');
    assert.equal(old.list[1].vod_play_from, '百度原画-share02');
    assert.equal(old.list[1].vod_play_url, '');
    const native = legacySpiderDataAdapter.response(legacy, { operation: 'detail', panMock: false });
    assert.equal(native.pan_mock, false);
    for (let i = 0; i < legacy.list.length; i += 1) {
        assert.equal(native.list[i].vod_play_from, `原生-${legacy.list[i].vod_play_from}`);
        assert.equal(native.list[i].vod_play_url, legacy.list[i].vod_play_url);
    }
});

test('legacy native flags avoid builtin dispatch and restore exactly on play without changing IDs', () => {
    const flags = ['夸父-share01', '优夕-share02', '百度原画-share03#01', '天意-share04', '逸动-share05', '直连', '原生-夸父-custom', '原生-direct'];
    const source = { list: [{ vod_play_from: flags.join('$$$'), vod_play_url: flags.map(() => 'E01.mkv$opaque-id').join('$$$') }] };
    const result = legacySpiderDataAdapter.response(source, { operation: 'detail', panMock: false });
    const nativeFlags = result.list[0].vod_play_from.split('$$$');
    assert.equal(nativeFlags[5], '直连');
    assert.equal(nativeFlags[6], '原生-原生-夸父-custom');
    for (let i = 0; i < flags.length; i += 1) {
        const body = { flag: nativeFlags[i], id: 'opaque-id', extension: 'retained' };
        assert.deepEqual(legacySpiderDataAdapter.request(body, { operation: 'play' }), { ...body, flag: flags[i] });
        assert.equal(legacySpiderDataAdapter.request(body, { operation: 'search' }), body);
    }
    assert.equal(result.list[0].vod_play_url, source.list[0].vod_play_url);
    const grouped = legacySpiderDataAdapter.response({ list: [{ vod_play_from: '夸父-share01|||优夕-share02', vod_play_url: 'one|||two' }] }, { operation: 'detail', panMock: false });
    assert.equal(grouped.list[0].vod_play_from, '原生-夸父-share01|||原生-优夕-share02');
    const reserved = legacySpiderDataAdapter.response({ list: [{ vod_play_from: '原生-direct', vod_play_url: 'E01$direct-id' }] }, { operation: 'detail', panMock: true });
    assert.equal(reserved.list[0].vod_play_from, '原生-原生-direct');
});

test('play normalization retains native extension fields and never fabricates successful error payloads', () => {
    const play = { parse: 0, url: ['original', 'https://example.invalid/file'], headers: { Referer: 'https://example.invalid/' }, format: 'video/x-iso', subtitles: ['x'], report: { value: 1 } };
    assert.deepEqual(panServiceSpiderDataAdapter.response(play, { operation: 'play' }), { ...play, header: play.headers });
    const existing = { ...play, header: { 'User-Agent': 'player' } };
    assert.equal(panServiceSpiderDataAdapter.response(existing, { operation: 'play' }), existing);
    for (const error of [null, 'invalid', [], { ok: false, message: 'baidu api errno=-9' }]) {
        for (const adapter of [legacySpiderDataAdapter, panServiceSpiderDataAdapter]) {
            assert.equal(adapter.response(error, { operation: 'detail', panMock: true }), error);
        }
    }
});

test('cache contexts isolate modes, native credentials, runtime generations and data protocols', async () => {
    const base = { runtimeId: '123456789a', method: 'POST', forwardPath: '/spider/test/3/detail', body: { id: 'cache-test' } };
    const context = { panMock: true, runtimeInstance: '1', dataProtocol: 'pan-service-v1', tvUser: 'one' };
    const key = buildSpiderCacheKey({ ...base, context });
    const reordered = { ...base, context: { tvUser: 'one', dataProtocol: 'pan-service-v1', runtimeInstance: '1', panMock: true } };
    assert.equal(buildSpiderCacheKey(reordered), key);
    for (const patch of [{ panMock: false }, { runtimeInstance: '2' }, { dataProtocol: 'cat-open-v1' }, { tvUser: 'two' }]) {
        assert.notEqual(buildSpiderCacheKey({ ...base, context: { ...context, ...patch } }), key);
    }
    let loads = 0;
    const loader = async () => ({ entry: { value: ++loads }, cacheable: true });
    assert.equal((await getOrCreateSpiderCache(key, loader)).hit, false);
    assert.equal((await getOrCreateSpiderCache(key, loader)).hit, true);
    const off = buildSpiderCacheKey({ ...base, context: { ...context, panMock: false } });
    assert.equal((await getOrCreateSpiderCache(off, loader)).hit, false);
    assert.equal((await getOrCreateSpiderCache(key, loader)).entry.value, 1);
    assert.equal(loads, 2);
});

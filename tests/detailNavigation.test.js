import test from 'node:test';
import assert from 'node:assert/strict';
import { getDetailNavigation, normalizePanDetailResponse } from '../src/util/panmockDetailCodec.js';
import { runPanListTask } from '../src/util/panListQueue.js';

const movie = { detailUrl: 'https://site.example/movie/1', name: 'Movie', year: '2026' };
const card = (mode, provider, url, extra = {}) => ({
    vod_id: 'different-author:' + Buffer.from(JSON.stringify({ ...movie, mode, provider, url })).toString('base64url'),
    vod_name: provider, ...extra,
});
const noRequests = { listShare: () => assert.fail('eager list') };

for (const panMock of [false, true]) {
    test(`navigation remains layered and keeps original script actions (${panMock})`, async () => {
        const input = { list: [
            card('group', 'baidu', '', { vod_tag: 'folder' }),
            card('group', 'quark', '', { vod_tag: 'folder' }),
            card('group', 'collect'),
            { vod_id: 'opaque', vod_name: 'Special', action: { action: 'resources', payload: { cursor: 'xyz', id: 'actual-id' } } },
        ] };
        const snapshot = JSON.stringify(input);
        const out = await normalizePanDetailResponse(input, { panMock, requestedId: 'original-movie', ...noRequests });
        assert.equal(out.list.length, 4);
        assert.deepEqual(out.list.map(x => x.vod_id), input.list.map(x => x.vod_id));
        assert.deepEqual(out.list.map(x => x.vod_navigation.action), ['category', 'category', 'detail', 'resources']);
        assert.deepEqual(out.list[3].vod_navigation.payload, { cursor: 'xyz', id: 'actual-id' });
        assert.equal(out.list[0].vod_name, '百度网盘');
        assert.equal(out.list[2].vod_name, 'collect');
        assert.equal(out.vod.vod_name, 'Movie');
        assert.equal(out.vod.vod_id, 'original-movie');
        assert.equal(out.vod.vod_year, '2026');
        assert.equal(JSON.stringify(input), snapshot);
    });
}

test('unknown structures/null/native data stay visible; layout alone is not an endpoint', async () => {
    const list = [null, 'upstream-invalid', { vod_id: 'opaque', vod_name: 'Unknown', style: { type: 'list' } },
        { vod_id: 'native', vod_play_from: '光鸭原画', vod_play_url: 'File$private-id', custom: { keep: true } }];
    const out = await normalizePanDetailResponse({ list, _catpaw_pan_shares: [], message: 'upstream diagnostic' }, { panMock: false });
    assert.deepEqual(out.list, list);
    assert.equal(out.message, 'upstream diagnostic');
    assert.equal(out._catpaw_pan_shares, undefined);
    assert.equal(getDetailNavigation(list[2]), null);
    assert.deepEqual((await normalizePanDetailResponse({ list: [] }, { panMock: false })).list, []);
});

test('only supported actual shares deduplicate, preserving a supplied password and all distinct shares', async () => {
    const out = await normalizePanDetailResponse({ list: [
        card('share', 'quark', 'https://pan.quark.cn/s/shareA'),
        card('share', 'quark', 'https://pan.quark.cn/s/shareA?pwd=1234'),
        card('share', 'quark', 'https://pan.quark.cn/s/shareB'),
        card('share', 'duck', 'https://unsupported.example/duck'),
        card('share', 'duck', 'https://unsupported.example/duck'),
    ] }, { panMock: false, ...noRequests });
    assert.equal(out.list.length, 4);
    assert.deepEqual(out.list.slice(0, 2).map(x => x.vod_navigation.share_flag), ['夸克-shareA-1234', '夸克-shareB']);
    assert.equal(out.list[2].vod_navigation.share_url, undefined);
    assert.equal(out.list[3].vod_id, out.list[2].vod_id, 'unsupported data is not silently deduplicated');
});

test('navigation is not limited to 64 items and a mixed native leaf is not erased', async () => {
    const list = Array.from({ length: 75 }, (_, i) => card('share', 'baidu', `https://pan.baidu.com/s/1share${i}`));
    const native = { vod_id: 'native', vod_play_from: '蓝光HDR', vod_play_url: 'E1$opaque***id' };
    list.push(native);
    const out = await normalizePanDetailResponse({ list }, { panMock: false, ...noRequests });
    assert.equal(out.list.length, 76);
    assert.deepEqual(out.list.at(-1), native);
    assert.equal(out.message, undefined);
});

test('request-wide captures cannot erase another film or unknown sibling', async () => {
    const a = { vod_id: 'a', vod_play_from: '百度', vod_play_url: 'https://pan.baidu.com/s/1shareA' };
    const b = { vod_id: 'b', vod_play_from: '百度未知线路', vod_play_url: 'E1$private-native' };
    const unknown = { vod_id: 'unknown', custom: true };
    const out = await normalizePanDetailResponse({ list: [a, b, unknown],
        _catpaw_pan_shares: [{ url: 'https://pan.baidu.com/s/1shareA', password: 'abcd' }],
    }, { panMock: true });
    assert.equal(out.list[0].vod_play_from, '百度-shareA-abcd');
    assert.deepEqual(out.list.slice(1), [b, unknown]);
});

test('one list per provider, different providers overlap, failures release the queue', async () => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { started = resolve; });
    const order = [];
    const first = runPanListTask('baidu', async () => { order.push('a'); started(); await gate; throw Error('expected'); });
    const caught = first.catch(error => error.message);
    await begun;
    const second = runPanListTask('baidu', async () => { order.push('b'); });
    await runPanListTask('quark', async () => { order.push('q'); });
    assert.deepEqual(order, ['a', 'q']);
    release();
    assert.equal(await caught, 'expected');
    await second;
    assert.deepEqual(order, ['a', 'q', 'b']);
});

test('ordinary complete detail list jobs are grouped by provider, not a global three slots', async () => {
    const urls = ['https://pan.baidu.com/s/1shareA', 'https://pan.baidu.com/s/1shareB',
        'https://pan.quark.cn/s/shareC', 'https://drive.uc.cn/s/shareD',
        'https://cloud.189.cn/t/shareE', 'https://caiyun.139.com/m/i?shareF'];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const active = new Set(), started = [];
    const work = normalizePanDetailResponse({ list: [{ vod_play_from: urls.map(() => 'source').join('$$$'),
        vod_play_url: urls.join('$$$') }] }, { panMock: false, listShare: async share => {
        assert.equal(active.has(share.provider), false);
        active.add(share.provider); started.push(share.provider);
        if (started.length === 5) release();
        await held;
        active.delete(share.provider);
        return { ok: true, vod_play_url: `E$${share.shareId}` };
    } });
    const timeout = setTimeout(() => release(), 1500);
    try { await work; } finally { clearTimeout(timeout); }
    assert.equal(new Set(started.slice(0, 5)).size, 5);
    assert.equal(started.length, 6);
});

test('UI action words are not guessed as navigation APIs', async () => {
    const list = [
        { vod_id: 'copy-id', vod_name: '夸克', action: 'copy' },
        { vod_id: 'unknown-folder', vod_tag: 'folder', action: { action: 'open' } },
    ];
    const out = await normalizePanDetailResponse({ list }, { panMock: false, ...noRequests });
    assert.deepEqual(out.list, list);
    assert.equal(out.list.some(item => item.vod_navigation), false);
    assert.equal(getDetailNavigation({ vod_id: '123', action: 'detail' }).action, 'detail');
    assert.equal(getDetailNavigation({ vod_id: 'custom', vod_navigation: { action: 'resources', payload: { cursor: 1 } } }).action, 'resources');
});

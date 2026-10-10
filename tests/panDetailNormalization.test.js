import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getSupportedPanProvider, parsePanShareURL, extractPanSharesFromSource,
    isBuiltinPanPlayId, isDetailNavigationList, normalizePanDetailResponse,
} from '../src/util/panmockDetailCodec.js';

const encode = (data, prefix = '') => prefix + Buffer.from(JSON.stringify(data)).toString('base64');
const film = (flags, urls, extra = {}) => ({
    list: [{ vod_id: 'film', vod_name: 'Example', vod_play_from: flags, vod_play_url: urls, ...extra }],
});
const group = (provider, mode = 'group', url = '') => ({
    vod_id: encode({ vodId: 'film', name: 'Example', mode, provider, url }, 'nav:'),
    vod_name: provider, style: { type: 'list' },
});

test('actual provider name variants identify only the five supported providers', () => {
    for (const [provider, labels] of Object.entries({
        baidu: ['百度网盘', '百度原画(无限)#02', 'baidu'],
        quark: ['夸克原画#01', '夸克极速', '夸父-shareA', 'quark', '夸克-baidu'],
        uc: ['UC网盘', 'uc原画', '优夕-shareA', 'UC-quark'],
        '189': ['天翼', '天意-shareA', 'pan189'],
        '139': ['移动云盘', '逸动-shareA', 'new139'],
    })) for (const label of labels) assert.equal(getSupportedPanProvider(label), provider, label);
    for (const label of ['光鸭', '迅雷原画', '蓝光HDR', 'duck', 'lucky', '光鸭-baidu']) assert.equal(getSupportedPanProvider(label), '');
});

test('real URL identity, password and mobile hash paths are independent of display flags', () => {
    for (const [url, provider, id, password] of [
        ['https://pan.baidu.com/s/1Abcdef?pwd=1234', 'baidu', 'Abcdef', '1234'],
        ['https://pan.baidu.com/share/init?surl=Abcdef&pwd=1234', 'baidu', 'Abcdef', '1234'],
        ['https://pan.quark.cn/s/Abcdef', 'quark', 'Abcdef', ''],
        ['https://drive.uc.cn/s/Abcdef?passcode=a1b2', 'uc', 'Abcdef', 'a1b2'],
        ['https://cloud.189.cn/web/share?code=Abcdef&accessCode=x9', '189', 'Abcdef', 'x9'],
        ['https://caiyun.139.com/m/i?Abcdef&pwd=1234', '139', 'Abcdef', '1234'],
        ['https://yun.139.com/w/i/Abcdef', '139', 'Abcdef', ''],
        ['https://yun.139.com/shareweb/#/w/i/Abcdef?pwd=a1b2', '139', 'Abcdef', 'a1b2'],
    ]) {
        const share = parsePanShareURL(url);
        assert.deepEqual([share.provider, share.shareId, share.password], [provider, id, password]);
        const name = { baidu: '百度', quark: '夸克', uc: 'UC', '189': '天翼', '139': '移动' }[provider];
        assert.equal(share.flag, `${name}-${id}${password ? `-${password}` : ''}`);
        assert.equal(parsePanShareURL(share.url).key, share.key);
        assert.equal(extractPanSharesFromSource('arbitrary', url).length, 1);
    }
    for (const url of ['https://pan.baidu.com.evil.test/s/1abcdef', 'https://user@pan.quark.cn/s/abcdef', 'file:///abcdef', 'https://caiyun.139.com/m/i?pwd=1234']) {
        assert.equal(parsePanShareURL(url), null, url);
    }
    assert.deepEqual(extractPanSharesFromSource('百度-1234', ''), []);
});

test('all five providers keep share identity and optional password in the same flag in both modes', async () => {
    const urls = [
        'https://pan.baidu.com/s/11share-A_b',
        'https://pan.quark.cn/s/abcdef123456',
        'https://drive.uc.cn/s/shareA',
        'https://cloud.189.cn/t/shareA',
        'https://caiyun.139.com/m/i?shareA',
    ];
    for (const url of urls) for (const password of ['', 'a1b2']) {
        const share = parsePanShareURL(url, password);
        const flags = [];
        for (const panMock of [true, false]) {
            const out = await normalizePanDetailResponse(film('原线路', share.url), {
                panMock,
                listShare: async input => {
                    assert.equal(input.shareId, share.shareId);
                    assert.equal(input.password, password);
                    return { ok: true, vod_play_url: 'File$complete-file-id' };
                },
            });
            flags.push(out.list[0].vod_play_from);
            assert.equal(out.list[0].vod_play_from, share.flag);
        }
        assert.equal(flags[0], flags[1]);
        assert.ok(flags[0].includes(share.shareId));
    }
});

test('a canonical flag password is read after the complete known share ID, not by splitting hyphens', () => {
    const url = 'https://pan.baidu.com/s/11share-A_b-abcd';
    for (const [flag, pass] of [
        ['百度-1share-A_b-abcd', ''],
        ['百度-1share-A_b-abcd-a1b2', 'a1b2'],
        ['百度-otherShare-a1b2', ''],
    ]) {
        const [share] = extractPanSharesFromSource(flag, url);
        assert.equal(share.shareId, '1share-A_b-abcd');
        assert.equal(share.password, pass);
    }
    const [share] = extractPanSharesFromSource('百度-1share-A_b-abcd-a1b2', `${url}?pwd=c3d4`);
    assert.equal(share.password, 'c3d4', 'actual URL credentials remain authoritative');
});

test('an explicit access code appended to a share URL is extracted before invoking script detail', async () => {
    for (const url of [
        'https://pan.quark.cn/s/shareA（访问码：a1b2）',
        'https://pan.quark.cn/s/shareA (提取码: a1b2)',
    ]) {
        const share = parsePanShareURL(url);
        assert.ok(share);
        assert.equal(share.flag, '夸克-shareA-a1b2');
        assert.equal(share.url, 'https://pan.quark.cn/s/shareA?pwd=a1b2');
        assert.equal(parsePanShareURL(url, 'c3d4').password, 'c3d4', 'explicit caller password still takes precedence');
        for (const panMock of [true, false]) {
            const calls = [];
            const result = await normalizePanDetailResponse({ list: [group('quark', 'share', url)] }, {
                panMock, requestedId: 'film',
                loadDetail: async () => assert.fail('the script must not discard a known access code'),
                listShare: async entry => {
                    calls.push(entry);
                    return { ok: true, vod_play_url: 'Movie$shareA*stoken*fid*ftoken***Movie.mkv' };
                },
            });
            assert.equal(result.list[0].vod_play_from, '夸克-shareA-a1b2');
            assert.equal(calls.length, panMock ? 0 : 1);
            if (!panMock) assert.equal(calls[0].password, 'a1b2');
        }
    }
    assert.equal(parsePanShareURL('https://pan.quark.cn.evil.test/s/shareA（访问码：a1b2）'), null);
    assert.equal(parsePanShareURL('https://user@pan.quark.cn/s/shareA（访问码：a1b2）'), null);
});

test('two script quality lines for one share become one entrance, without dropping distinct shares or native IDs', async () => {
    const native = 'https://cover.example/pic*Author*1:20****opaque-E65';
    const first = encode({ providerId: 'quark', shareId: 'shareA', fileId: 'file', playToken: 'private-secret', mode: 'raw' });
    const second = encode({ providerId: 'quark', shareId: 'shareA', fileId: 'file', mode: 'fast' });
    const other = encode({ providerId: 'quark', shareId: 'shareB', fileId: 'file' });
    const input = film('蓝光HDR$$$夸克原画$$$夸克极速$$$夸克原画#02$$$光鸭原画', `第1集$${native}$$$File$${first}$$$File$${second}$$$File$${other}$$$File$native-private`);
    input._catpaw_pan_shares = [{ url: 'https://pan.quark.cn/s/shareA', password: 'abcd' }];
    const snapshot = JSON.stringify(input);
    const out = await normalizePanDetailResponse(input, { panMock: true });
    assert.equal(out.list[0].vod_play_from, '夸克-shareA-abcd$$$夸克-shareB$$$蓝光HDR$$$光鸭原画');
    assert.deepEqual(out.list[0].vod_play_url.split('$$$'), [
        'https://pan.quark.cn/s/shareA?pwd=abcd', 'https://pan.quark.cn/s/shareB',
        `第1集$${native}`, 'File$native-private',
    ]);
    assert.equal(JSON.stringify(input), snapshot, 'raw cache data is immutable');
    assert.equal(JSON.stringify(out).includes('private-secret'), false);
    assert.equal(out._catpaw_pan_shares, undefined);
});

test('runner mode reuses list results, preserves full IDs, and does not fall back to private IDs on list failure', async () => {
    const input = film('百度原画$$$夸克原画$$$HDR', [
        'File$' + encode({ providerId: 'baidu', shareId: '1deadShare', fileId: 'private' }),
        'File$' + encode({ providerId: 'quark', shareId: 'liveShare', fileId: 'private' }),
        'Episode$original-id',
    ].join('$$$'));
    const calls = [];
    const out = await normalizePanDetailResponse(input, {
        panMock: false,
        listShare: async (share) => {
            calls.push(share);
            if (share.provider === 'baidu') return { ok: false, message: 'baidu api errno=-9' };
            return { ok: true, vod_play_url: 'Episode$liveShare*stoken*fid*fileToken***S01E01.mkv' };
        },
    });
    assert.equal(calls.length, 2);
    assert.equal(out.pan_mock, false);
    assert.equal(out.list[0].vod_play_from, '夸克-liveShare$$$HDR');
    assert.match(out.list[0].vod_play_url, /liveShare\*stoken\*fid\*fileToken/);
    assert.match(out.message, /失效|-9/);
    assert.equal(out.list[0].vod_play_url.includes('private'), false);
});

test('navigation groups expand original IDs; unsupported and untagged collection leaves survive', async () => {
    const q = group('quark');
    const uc = group('uc');
    const unsupported = group('guangya');
    const native = group('collect');
    const children = new Map([
        [q.vod_id, { list: [group('quark', 'share', 'https://pan.quark.cn/s/shareA'), group('quark', 'share', 'https://pan.quark.cn/s/shareB')] }],
        [uc.vod_id, { list: [group('uc', 'share', 'https://drive.uc.cn/s/shareC')] }],
        [unsupported.vod_id, film('光鸭原画', 'Episode$native-gy')],
        [native.vod_id, film('蓝光HDR', 'Episode$native-hdr')],
    ]);
    const calls = [];
    const out = await normalizePanDetailResponse({ list: [q, uc, unsupported, native] }, {
        panMock: true, requestedId: 'film',
        loadDetail: async (id) => { calls.push(id); assert.ok(children.has(id)); return children.get(id); },
    });
    assert.equal(calls.length, 4, 'supported share cards need no redundant private list request');
    assert.equal(out.list[0].vod_name, 'Example');
    assert.equal(out.list[0].vod_id, 'film');
    assert.equal(out.list[0].style, undefined);
    assert.equal(out.list[0].vod_play_from, '夸克-shareA$$$夸克-shareB$$$UC-shareC$$$光鸭原画$$$蓝光HDR');
});

for (const panMock of [false, true]) {
    test(`a navigation card with a share URL as vod_id bypasses script detail (pan_mock=${panMock})`, async () => {
        const url = 'https://yun.139.com/shareweb/#/w/i/shareA?pwd=1234';
        const card = { vod_id: url, vod_name: 'Example movie', style: { type: 'list' } };
        const calls = [];
        const options = {
            panMock, requestedId: 'film',
            loadDetail: async () => assert.fail('raw share URLs must not be sent back to script detail'),
            listShare: async (share) => {
                calls.push(share);
                return { ok: true, vod_play_url: 'Episode$contentId*shareA***S01E01.mkv' };
            },
        };
        const out = await normalizePanDetailResponse({ list: [card] }, options);
        assert.equal(out.list[0].vod_id, 'film');
        assert.equal(out.list[0].vod_name, 'Example movie');
        assert.equal(out.list[0].vod_play_from, '移动-shareA-1234');
        assert.equal(out.list[0].style, undefined);
        assert.equal(calls.length, panMock ? 0 : 1);
        assert.equal(out.list[0].vod_play_url, panMock
            ? 'https://caiyun.139.com/m/i?shareA&pwd=1234'
            : 'Episode$contentId*shareA***S01E01.mkv');

        // A resource search may list unrelated films as raw share cards.
        // Recognize their shares, but do not combine those films into one.
        const other = { ...card, vod_id: url.replace('shareA', 'shareB'), vod_name: 'Other movie' };
        const separate = await normalizePanDetailResponse({ list: [card, other] }, options);
        assert.equal(separate.list.length, 2);
        assert.equal(separate.list[0].vod_name, 'Example movie');
        assert.equal(separate.list[1].vod_name, 'Other movie');
        assert.deepEqual(separate.list.map(item => item.vod_play_from), ['移动-shareA-1234', '移动-shareB-1234']);
    });
}

test('capture replacement is scoped to its child detail and never another sibling provider label', async () => {
    const a = group('a'), b = group('b');
    const out = await normalizePanDetailResponse({ list: [a, b] }, {
        panMock: true, requestedId: 'film', loadDetail: async (id) => id === a.vod_id
            ? { ...film('百度网盘', 'placeholder'), _catpaw_pan_shares: [{ url: 'https://pan.baidu.com/s/1shareA' }] }
            : film('百度未知自定义线路', 'Episode$native-id'),
    });
    assert.equal(out.list[0].vod_play_from, '百度-shareA$$$百度未知自定义线路');
});

test('ordinary multiple films are not flattened, empty responses stay empty and navigation limits are visible', async () => {
    const movies = [film('HDR', 'One$idA').list[0], { ...film('HDR', 'Two$idB').list[0], vod_id: 'other' }];
    assert.equal(isDetailNavigationList(movies), false);
    const out = await normalizePanDetailResponse({ list: movies }, { panMock: true });
    assert.equal(out.list.length, 2);
    assert.equal(out.list[1].vod_play_url, 'Two$idB');
    assert.deepEqual((await normalizePanDetailResponse({ list: [], message: 'empty' }, { panMock: false })).list, []);
    const limited = await normalizePanDetailResponse({ list: [group('quark')] }, { panMock: true, requestedId: 'film', maxRequests: 0 });
    assert.match(limited.message, /上限/);
});

test('only complete compatible IDs dispatch to built-in play, not new script private payloads', () => {
    assert.equal(isBuiltinPanPlayId('baidu', encode({ providerId: 'baidu', shareId: 'abc', fileId: 'def' })), false);
    assert.equal(isBuiltinPanPlayId('baidu', encode({ surl: 'abc', shareid: '1', uk: '2', fs_id: '3' }) + '|||file.mkv'), true);
    assert.equal(isBuiltinPanPlayId('quark', 'share*token*fid*ftoken***file.mkv'), true);
    assert.equal(isBuiltinPanPlayId('139', 'content*link***file.mkv'), true);
    assert.equal(isBuiltinPanPlayId('189', '123*456*file.mkv'), true);
    assert.equal(isBuiltinPanPlayId('189', 'native*opaque*id'), false);
});

test('navigation card count does not discard direct shares that need no child requests', async () => {
    const list = Array.from({ length: 70 }, (_, i) => group('quark', 'share', `https://pan.quark.cn/s/share${i}`));
    const out = await normalizePanDetailResponse({ list }, { panMock: true, requestedId: 'film', maxRequests: 1 });
    assert.equal(out.list[0].vod_play_from.split('$$$').length, 70);
    assert.equal(out.list[0].vod_play_url.split('$$$').length, 70);
    assert.equal(out.message, undefined);
});

test('Tianyi numeric internal IDs are not converted to public share codes without evidence', async () => {
    const id = encode({ providerId: 'pan189', shareId: '12345678', fileId: '987654321' });
    assert.deepEqual(extractPanSharesFromSource('天翼原画', `File$${id}`), []);
    const out = await normalizePanDetailResponse(film('天翼原画', `File$${id}`), { panMock: true });
    assert.equal(out.list[0].vod_play_from, '天翼原画');
    assert.equal(out.list[0].vod_play_url, `File$${id}`);
});

test('Baidu IDs with filename suffixes parse regardless of Base64 padding', () => {
    for (let size = 0; size < 3; size += 1) {
        const id = encode({ surl: 'shareA', shareid: '1', uk: '2', fs_id: '3', extra: 'a'.repeat(size) }) + '|||S01E01.mkv';
        assert.equal(isBuiltinPanPlayId('baidu', id), true);
        assert.equal(extractPanSharesFromSource('百度', `File$${id}`)[0].shareId, 'shareA');
    }
});

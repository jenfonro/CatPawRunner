// A synthetic protocol implementation. All non-intercepted requests use a
// loopback-only lookup, so mock-off tests never contact real pan services.
export function makeSpiderRuntime(options) {
    return `globalThis.fixtureOptions = ${JSON.stringify(options)};\nglobalThis.start = ${fixtureStart.toString()};`;
}

async function fixtureStart() {
    const { fastifyPath, upstreamPort, protocol = 'website-api-v1', version = 'v1' } = globalThis.fixtureOptions;
    const http = require('node:http');
    const zlib = require('node:zlib');
    const crypto = require('node:crypto');
    const app = require(fastifyPath)({ serverFactory: globalThis.catServerFactory });
    globalThis.server = app;
    app.address = () => app.server.address();
    const stats = { details: 0, plays: 0, inits: 0, queries: 0 };
    const waiting = new Map();
    const requestPan = (hostname, path, body) => new Promise((resolve, reject) => {
        const bytes = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const req = http.request({
            hostname, port: upstreamPort, path, method: bytes ? 'POST' : 'GET', family: 4,
            lookup: (_host, _options, cb) => cb(null, '127.0.0.1', 4),
            headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {},
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    let raw = Buffer.concat(chunks);
                    if (res.headers['content-encoding'] === 'br') raw = zlib.brotliDecompressSync(raw);
                    resolve(JSON.parse(raw.toString('utf8')));
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('fixture pan timeout')));
        req.end(bytes);
    });
    const key = Buffer.from('PVGDwmcvfs1uV3d1');
    const encrypt = (data) => {
        const iv = Buffer.alloc(16, 7);
        const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
        return Buffer.concat([iv, cipher.update(JSON.stringify(data)), cipher.final()]).toString('base64');
    };
    const decrypt = (data) => {
        const raw = Buffer.from(data, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, raw.subarray(0, 16));
        return JSON.parse(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString());
    };
    const resolveShare = async (providerId, wire) => {
        const shareId = { quark: 'quarkshare01', uc: 'ucshare01', baidu: '1publicBaidu01', pan189: 'TianyiShare01', new139: 'mobileShare01' }[providerId];
        const passcode = { quark: '', uc: 'Uc12', baidu: 'Bd23', pan189: 'Ty34', new139: 'Mb45' }[providerId];
        let fileId, fileName, playToken;
        if (providerId === 'quark' || providerId === 'uc') {
            const host = providerId === 'quark' ? 'drive.quark.cn' : 'pc-api.uc.cn';
            const token = await requestPan(host, '/1/clouddrive/share/sharepage/token', { pwd_id: shareId, passcode });
            const detail = await requestPan(host, '/1/clouddrive/share/sharepage/detail?' + new URLSearchParams({ pwd_id: shareId, pdir_fid: '0', stoken: token.data.stoken }));
            const item = detail.data.list[0];
            fileId = item.fid;
            fileName = item.file_name;
            playToken = { fid: fileId, shareFidToken: item.share_fid_token, shareId, stoken: token.data.stoken, fileName };
        } else if (providerId === 'baidu') {
            const surl = shareId.slice(1);
            await requestPan('pan.baidu.com', '/share/verify?surl=' + surl, 'pwd=' + passcode);
            const detail = await requestPan('pan.baidu.com', '/share/list?surl=' + surl);
            const item = detail.list[0];
            fileId = String(item.fs_id);
            fileName = item.server_filename;
            playToken = { fsId: fileId, name: fileName, uk: String(detail.uk), shareId: String(detail.shareid), surl, pwd: passcode, tempCookie: 'fixture-cookie' };
        } else if (providerId === 'pan189') {
            const query = wire === 'separate'
                ? new URLSearchParams({ shareCode: shareId, accessCode: passcode })
                : new URLSearchParams({ shareCode: `${shareId}（访问码：${passcode}）` });
            const detail = await requestPan('cloud.189.cn', '/api/open/share/getShareInfoByCodeV2.action?' + query);
            fileId = String(detail.fileId);
            fileName = detail.fileName;
            playToken = { shareId: String(detail.shareId), fileId, fileName };
        } else {
            const request = { getOutLinkInfoReq: { linkID: shareId, passwd: passcode, pCaID: 'root', coSrt: 0, eNum: 200 } };
            let detail = await requestPan('share-kd-njs.yun.139.com', '/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6', wire === 'encrypted' ? JSON.stringify(encrypt(request)) : request);
            if (wire === 'encrypted') detail = decrypt(detail);
            const item = detail.data.coLst[0];
            fileId = item.coID;
            fileName = item.coName;
            playToken = { shareCode: shareId, passCode: passcode, contentId: fileId, path: item.path, fileName, fastUrl: '', playUrls: {} };
        }
        return { providerId, shareId, fileId, name: fileName, playToken: JSON.stringify(playToken) };
    };
    app.get('/full-config', async () => ({ video: { sites: [] } }));
    if (protocol === 'website-api-v1') {
        app.get('/website/api/credentials', async () => ({ code: 0, data: { quark: { cookie: '' }, pan189: { account: '', password: '' } } }));
    } else if (protocol === 'website-v1') {
        app.get('/website/pans/list', async () => ({ code: 0, data: [] }));
    }
    app.get('/fixture/stats', async () => ({ ...stats, waiting: [...waiting.keys()], pid: process.pid }));
    app.post('/fixture/release/:id', async (req) => {
        waiting.get(req.params.id)?.();
        waiting.delete(req.params.id);
        return { ok: true };
    });
    app.route({
        method: ['GET', 'POST'], url: '/spider/:site/3/:operation',
        handler: async (req, reply) => {
            const { operation } = req.params;
            const body = req.method === 'GET' ? req.query : req.body || {};
            if (operation === 'init') { stats.inits += 1; return {}; }
            if (operation === 'play') {
                stats.plays += 1;
                if (body.id === 'media') return reply.type('video/mp2t').send(Buffer.from([0x47, 0, 0xff, 1]));
                if (protocol !== 'website-api-v1') return {
                    parse: 0, url: 'https://example.invalid/legacy.mkv', header: {},
                    meta: { flag: body.flag, id: body.id },
                };
                const item = JSON.parse(Buffer.from(body.id, 'base64').toString('utf8'));
                if (item.name.endsWith('.mp4')) return reply.code(409).send({ ok: false, message: 'mock placeholder is not playable' });
                return {
                    parse: 0, url: `http://127.0.0.1:${app.address().port}/native-stream`,
                    headers: { Referer: 'https://example.invalid/', 'User-Agent': 'fixture-player' },
                    format: 'video/x-matroska', subtitles: ['fixture.vtt'],
                    meta: { flag: body.flag, id: body.id, mode: item.mode, quality: item.quality, tvUser: req.headers['x-tv-user'] || '', internalHeaderVisible: 'x-catpaw-pan-mock' in req.headers },
                };
            }
            if (operation !== 'detail') {
                stats.queries += 1;
                return { list: [{ vod_id: 'sample', vod_name: 'Sample', vod_pic: '/image?url=https%3A%2F%2Fimg1.doubanio.com%2Fview%2Fphoto.jpg' }] };
            }
            stats.details += 1;
            if (body.wait) await new Promise((resolve) => waiting.set(body.id, resolve));
            if (body.id === 'http-error') return reply.code(410).send({ ok: false, message: 'baidu api errno=-9' });
            if (body.id === 'json-error') return { ok: false, message: 'baidu api errno=-9' };
            if (body.id === 'invalid-json') return reply.type('application/json').send('{broken');
            if (body.id === 'html') return reply.type('text/html').send('<html>upstream error</html>');
            if (protocol !== 'website-api-v1') return { list: [{ vod_name: version, vod_play_from: '夸父-quarkshare01', vod_play_url: 'Ab12.mp4$legacy-opaque-id' }] };
            const providers = body.provider ? [body.provider] : ['quark', 'uc', 'baidu', 'pan189', 'new139'];
            const shares = await Promise.all(providers.map((provider) => resolveShare(provider, body.wire)));
            const flags = [];
            const urls = [];
            for (const item of shares) {
                const modes = item.providerId === 'pan189' ? ['original'] : item.providerId === 'uc' ? ['original', 'speed', 'unlimited'] : item.providerId === 'baidu' ? ['original', 'unlimited'] : ['original', 'speed'];
                for (const mode of modes) {
                    flags.push({ quark: '夸克', uc: 'UC', baidu: '百度', pan189: '天翼', new139: '移动' }[item.providerId] + { original: '原画', speed: '极速', unlimited: '原画(无限)' }[mode]);
                    urls.push(item.name + '$' + Buffer.from(JSON.stringify({ ...item, mode, quality: mode })).toString('base64'));
                }
            }
            const row = { vod_id: body.id, vod_name: version, vod_year: '2026', vod_play_from: flags.join('$$$'), vod_play_url: urls.join('$$$') };
            return { list: body.multi ? [row, { ...row, vod_id: 'second' }] : [row], nativeMetadata: { retained: true } };
        },
    });
    await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
}

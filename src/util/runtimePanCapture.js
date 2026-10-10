// Embedded in the online runtime bootstrap. This is a request-scoped bridge for
// the existing interceptors, not a second share cache or a client-side protocol.
export function createRuntimePanCapture({ getStore, extractCreds, placeholderCache, getTianyiCache, zlib }) {
    const text = (value) => String(value == null ? '' : value).trim();
    const validId = (value) => /^[A-Za-z0-9_-]{4,256}$/.test(value);

    function record(provider, meta) {
        const store = getStore();
        if (!store || !store.panShares) return;
        try {
            const p = text(meta && meta.path);
            const u = new URL(p, 'https://capture.invalid');
            const q = u.searchParams;
            const creds = extractCreds(provider, '', p, {}, text(meta && meta.body)) || {};
            let id = '';
            let password = '';
            if (provider === 'quark' || provider === 'uc') {
                id = text(creds.pwd_id);
                password = text(creds.passcode);
            } else if (provider === 'baidu') {
                id = text(q.get('surl') || q.get('shorturl') || creds.shorturl);
                if (!id) {
                    const match = /^\/s\/1([A-Za-z0-9_-]+)/.exec(u.pathname);
                    if (match) id = match[1];
                }
                password = text(creds.pwd || q.get('pwd'));
            } else if (provider === 'tianyi') {
                id = text(creds.shareCode);
                password = text(creds.accessCode);
                if (!id) {
                    const cache = getTianyiCache() || {};
                    id = text(
                        (cache.byShareId && cache.byShareId.get(text(q.get('shareId')))) ||
                        (cache.byFileId && cache.byFileId.get(text(q.get('fileId') || q.get('shareDirFileId'))))
                    );
                }
                if (!id) {
                    const match = /^\/t\/([A-Za-z0-9_-]+)/.exec(u.pathname);
                    if (match) id = match[1];
                }
            } else if (provider === '139') {
                id = text(creds.linkID);
                password = text(creds.passwd);
            }
            if (!validId(id)) return;
            const cached = placeholderCache[provider] && placeholderCache[provider].get(id);
            password = password || text(cached && cached.password);
            const bases = {
                quark: 'https://pan.quark.cn/s/',
                uc: 'https://drive.uc.cn/s/',
                baidu: 'https://pan.baidu.com/s/1',
                tianyi: 'https://cloud.189.cn/t/',
                '139': 'https://caiyun.139.com/m/i?',
            };
            const base = bases[provider];
            if (!base) return;
            const key = provider + ':' + id;
            if (store.panShares.size >= 256 && !store.panShares.has(key)) return;
            const previous = store.panShares.get(key);
            store.panShares.set(key, {
                provider,
                url: base + id,
                password: password || text(previous && previous.password),
            });
        } catch (_) {}
    }

    function wrapResponse(res, store) {
        if (!store.panShares) return;
        const originalWrite = res.write;
        const originalEnd = res.end;
        const originalWriteHead = res.writeHead;
        const originalFlushHeaders = res.flushHeaders;
        const limit = 8 * 1024 * 1024;
        let chunks = [];
        let bytes = 0;
        let head = null;
        let passthrough = false;
        const release = () => {
            res.write = originalWrite;
            res.end = originalEnd;
            res.writeHead = originalWriteHead;
            res.flushHeaders = originalFlushHeaders;
            if (head && !res.headersSent) originalWriteHead.apply(res, head);
        };
        const removeHeader = (name) => {
            res.removeHeader(name);
            if (!head) return;
            const index = typeof head[1] === 'string' ? 2 : 1;
            const headers = head[index];
            if (Array.isArray(headers)) {
                head[index] = headers.flatMap((value, i) => i % 2 === 0 && String(value).toLowerCase() !== name ? [value, headers[i + 1]] : []);
            } else if (headers) {
                head[index] = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== name));
            }
        };
        // Detail JSON must be complete before its capture metadata is appended.
        res.flushHeaders = function () {};
        res.writeHead = function (...args) {
            head = args;
            // Keep headers available to the script without committing them yet.
            const headers = args[typeof args[1] === 'string' ? 2 : 1];
            if (headers && !Array.isArray(headers)) {
                for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
            } else if (Array.isArray(headers)) {
                for (let i = 0; i < headers.length; i += 2) res.setHeader(headers[i], headers[i + 1]);
            }
            res.statusCode = args[0];
            if (typeof args[1] === 'string') res.statusMessage = args[1];
            return res;
        };
        res.write = function (chunk, encoding, callback) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
            chunks.push(buf);
            bytes += buf.length;
            if (bytes > limit) {
                passthrough = true;
                release();
                for (const part of chunks) originalWrite.call(res, part);
                chunks = [];
            }
            const cb = typeof encoding === 'function' ? encoding : callback;
            if (typeof cb === 'function') queueMicrotask(cb);
            return true;
        };
        res.end = function (chunk, encoding, callback) {
            if (passthrough) return originalEnd.call(res, chunk, encoding, callback);
            if (chunk != null && typeof chunk !== 'function') {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
            }
            let body = Buffer.concat(chunks);
            try {
                if (body.length > limit) throw new Error('detail too large');
                let decoded = body;
                const encoding = text(res.getHeader('content-encoding')).toLowerCase();
                if (encoding && encoding !== 'identity') {
                    const method = { gzip: 'gunzipSync', deflate: 'inflateSync', br: 'brotliDecompressSync' }[encoding];
                    if (!method || !zlib) throw new Error('unsupported detail encoding');
                    decoded = zlib[method](body, { maxOutputLength: limit });
                }
                const parsed = JSON.parse(decoded.toString('utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && store.panShares.size) {
                    parsed._catpaw_pan_shares = Array.from(store.panShares.values());
                    body = Buffer.from(JSON.stringify(parsed));
                    for (const name of ['content-length', 'content-encoding', 'etag']) removeHeader(name);
                }
            } catch (_) {}
            release();
            const cb = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback;
            return originalEnd.call(res, body, cb);
        };
    }
    return { record, wrapResponse };
}

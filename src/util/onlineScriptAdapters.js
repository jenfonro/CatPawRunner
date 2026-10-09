import axios from 'axios';

const cookie = (path, field = 'cookie') => ({ path, fields: { [field]: 'cookie' } });
const account = (path, field = 'username') => ({ path, fields: { [field]: 'username', password: 'password' } });
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hasFields = (value, fields) => isObject(value) && fields.every((field) => typeof value[field] === 'string');

// These are management protocols, not author/file-name guesses. A new protocol
// supplies its own read-only probe and explicit credential-to-native-route map.
const adapters = [
    {
        type: 'website-v1',
        probe: '/website/pans/list',
        identify: (data) => {
            const list = Array.isArray(data) ? data : data?.list;
            return Array.isArray(list) && list.every((item) => isObject(item) && typeof item.key === 'string');
        },
        credentials: {
            baidu: cookie('/website/baidu/cookie'),
            quark: cookie('/website/quark/cookie'),
            uc: cookie('/website/uc/cookie'),
            '115': cookie('/website/115/cookie'),
            '189': account('/website/tianyi/account'),
            pan123: account('/website/pan123/account'),
            bili: cookie('/website/bili/cookie'),
            wuming: cookie('/website/wuming/cookie'),
            yunchao: account('/website/yunchao/account'),
            pan123ziyuan: cookie('/website/pan123ziyuan/cookie'),
        },
    },
    {
        type: 'website-api-v1',
        probe: '/website/api/credentials',
        identify: (data) => isObject(data) && (
            hasFields(data.quark, ['cookie']) || hasFields(data.uc, ['cookie']) ||
            hasFields(data.pan123, ['account', 'password']) || hasFields(data.pan189, ['account', 'password'])
        ),
        credentials: {
            baidu: { ...cookie('/website/api/credential/baidu/cookie', 'value'), provider: 'baidu', required: ['cookie'] },
            quark: { ...cookie('/website/api/credential/quark/cookie', 'value'), provider: 'quark', required: ['cookie'] },
            uc: { ...cookie('/website/api/credential/uc/cookie', 'value'), provider: 'uc', required: ['cookie'] },
            '115': { ...cookie('/website/api/pan115/cookie', 'value'), provider: 'pan115', required: ['cookie'] },
            '189': { ...account('/website/api/pan189/account', 'account'), provider: 'pan189', required: ['account', 'password'] },
            pan123: { ...account('/website/api/pan123/account', 'account'), provider: 'pan123', required: ['account', 'password'] },
            bili: { ...cookie('/website/api/bili/cookie'), provider: 'bili', required: ['cookie'] },
            pan123ziyuan: { ...cookie('/website/api/credential/pan123ziyuan/cookie', 'value'), provider: 'pan123ziyuan', required: ['cookie'] },
        },
    },
];

async function request(port, path, method = 'GET', body) {
    try {
        const response = await axios.request({
            url: `http://127.0.0.1:${port}${path}`,
            method,
            data: body,
            headers: { accept: 'application/json' },
            proxy: false,
            timeout: method === 'GET' ? 2000 : 8000,
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
            validateStatus: () => true,
        });
        return { status: response.status, data: response.data };
    } catch (error) {
        // Do not return/log Axios errors containing request bodies (credentials).
        return { status: 0, data: null, error: error.code || 'request failed' };
    }
}

function responseMessage(data, credentials) {
    if (!isObject(data)) return '';
    let message = [data.message, data.msg, data.desc].find((value) => typeof value === 'string' && value.trim()) || '';
    // Native errors may echo submitted values. Expose a bounded diagnostic, not
    // credentials, stack traces, or the full response/request object.
    const secrets = Object.values(credentials || {})
        .filter((value) => typeof value === 'string' && value)
        .flatMap((value) => [value, value.trim(), JSON.stringify(value).slice(1, -1)])
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    for (const secret of new Set(secrets)) message = message.split(secret).join('[redacted]');
    return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function responseState(response, credentials) {
    const { status, data } = response;
    const message = responseMessage(data, credentials);
    if (!(status >= 200 && status < 300)) {
        const reason = response.error || `HTTP ${status}`;
        return { ok: false, message: message ? `${reason}: ${message}` : reason };
    }
    if (!isObject(data)) return { ok: false, message: 'invalid script response' };
    const success = Object.prototype.hasOwnProperty.call(data, 'code') ? data.code === 0 || data.code === '0' : data.success === true;
    if (!success) return { ok: false, message: message || 'script save failed' };
    if (data.sms || data.status === 'waiting') {
        return { ok: false, message: '请到原脚本管理页面完成短信验证或登录确认' };
    }
    return { ok: true, message: '' };
}

export async function detectOnlineScriptProtocol(port) {
    const probes = await Promise.all(adapters.map(async (adapter) => {
        const response = await request(port, adapter.probe);
        if (!responseState(response).ok || !adapter.identify(response.data.data)) return null;
        // Store field names only, never cache or expose saved credential values.
        const fields = {};
        if (isObject(response.data.data)) {
            for (const [key, value] of Object.entries(response.data.data)) {
                if (isObject(value)) fields[key] = Object.keys(value).filter((name) => typeof value[name] === 'string');
            }
        }
        return { type: adapter.type, fields };
    }));
    return probes.find(Boolean) || { type: 'unknown', fields: {} };
}

export async function syncOnlineScriptCredential({ port, protocol, key, value }) {
    const adapter = adapters.find((item) => item.type === protocol.type);
    const rule = adapter && Object.prototype.hasOwnProperty.call(adapter.credentials, key) ? adapter.credentials[key] : null;
    const skip = (message) => ({ ok: true, skipped: true, message });
    if (!rule) return skip(adapter ? '脚本协议不支持此账号同步' : '未识别脚本管理协议');
    const sourceFields = Object.values(rule.fields);
    if (!hasFields(value, sourceFields) || sourceFields.some((field) => !value[field].trim())) return skip('empty credential');
    if (rule.provider) {
        const fields = protocol.fields[rule.provider] || [];
        if (!rule.required.every((field) => fields.includes(field))) return skip('脚本未提供此账号保存能力');
    } else {
        // Legacy /pans/list is a resolver list, not a credential API list.
        // Verify the native read endpoint before sending any credentials.
        const probe = await request(port, rule.path);
        if (probe.status === 404 || probe.status === 405) return skip('脚本未提供此账号保存接口');
        const state = responseState(probe, value);
        if (!state.ok) return { ...state, skipped: false };
        const data = probe.data.data;
        const compatible = sourceFields.length === 1 ? typeof data === 'string' : hasFields(data, ['username', 'password']);
        if (!compatible) return skip('脚本账号接口格式不兼容');
    }
    const body = Object.fromEntries(Object.entries(rule.fields).map(([target, source]) => [target, value[source]]));
    const result = responseState(await request(port, rule.path, 'PUT', body), value);
    return { ...result, skipped: false };
}

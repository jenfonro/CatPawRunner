import adminPlugins from './admin.js';
import pan139Plugins from './pan139.js';
import pan189Plugins from './pan189.js';
import panBaiduPlugins from './panBaidu.js';
import panQuarkPlugins from './panQuark.js';
import panUcPlugins from './panUc.js';
import m3u8Plugins from './m3u8.js';

export const apiPlugins = [
    ...(Array.isArray(adminPlugins) ? adminPlugins : []),
    ...(Array.isArray(pan139Plugins) ? pan139Plugins : []),
    ...(Array.isArray(pan189Plugins) ? pan189Plugins : []),
    ...(Array.isArray(panBaiduPlugins) ? panBaiduPlugins : []),
    ...(Array.isArray(panQuarkPlugins) ? panQuarkPlugins : []),
    ...(Array.isArray(panUcPlugins) ? panUcPlugins : []),
    ...(Array.isArray(m3u8Plugins) ? m3u8Plugins : []),
];

export default apiPlugins;

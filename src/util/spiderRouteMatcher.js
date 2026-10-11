export const SPIDER_CACHE_ROUTE_RE = /^\/spider\/[^/]+\/\d+\/(?:home|category|search|detail)$/i;

export function isSpiderCacheRoutePath(pathName) {
    return SPIDER_CACHE_ROUTE_RE.test(String(pathName || ''));
}

// Only these script operations participate in the detail/navigation protocol.
// Unknown custom operations keep their original execution and streaming path.
export function isSpiderPanDetailRequest(method, pathName) {
    return String(method || '').toUpperCase() === 'POST' &&
        /^\/spider\/[^/]+\/\d+\/(?:detail|category)\/?(?:\?|$)/i.test(String(pathName || ''));
}


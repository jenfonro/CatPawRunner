export const SPIDER_CACHE_ROUTE_RE = /^\/spider\/[^/]+\/\d+\/(?:home|category|search|detail)$/i;

export function isSpiderCacheRoutePath(pathName) {
    return SPIDER_CACHE_ROUTE_RE.test(String(pathName || ''));
}


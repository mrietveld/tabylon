import {MAX_TABS, MINIMUM_GROUP_SIZE} from './contracts.js';

export const ORGANIZER_DEFAULT_SCOPES = Object.freeze([
    'ungrouped-current-window',
    'current-group',
    'all',
]);

export function createOrganizerPageUrl(pageUrl, tabIds = []) {
    const selectedTabIds = (Array.isArray(tabIds) ? tabIds : [])
        .filter(tabId => Number.isSafeInteger(tabId) && tabId >= 0);

    if (!selectedTabIds.length) {
        return pageUrl;
    }

    const query = new URLSearchParams({
        scope: 'selected',
        tabId: selectedTabIds.join(','),
    });
    return `${pageUrl}?${query}`;
}

export function normalizeOrganizerMinimumGroupSize(value) {
    if (typeof value === 'string' && !value.trim()) {
        return undefined;
    }

    const size = Number(value);
    if (!Number.isFinite(size)) {
        return undefined;
    }

    return Math.min(MAX_TABS, Math.max(MINIMUM_GROUP_SIZE, Math.round(size)));
}

export function normalizeOrganizerServiceUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }

    try {
        const url = new URL(value.trim());
        return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeOrganizerDefaultScope(value) {
    return ORGANIZER_DEFAULT_SCOPES.includes(value) ? value : undefined;
}

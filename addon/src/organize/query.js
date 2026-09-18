const DEFAULT_SCOPE = 'ungrouped-current-window';
const SCOPES = new Set([
    DEFAULT_SCOPE,
    'current-group',
    'selected',
    'all',
]);

function parseTabId(value) {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) {
        return null;
    }

    const tabId = Number(normalized);
    return Number.isSafeInteger(tabId) ? tabId : null;
}

export function parseOrganizerQuery(search = '', fallbackScope = DEFAULT_SCOPE) {
    const query = new URLSearchParams(search);
    const selectedTabIds = [];
    const seen = new Set();

    for (const value of query.getAll('tabId').flatMap(item => item.split(','))) {
        const tabId = parseTabId(value);
        if (tabId !== null && !seen.has(tabId)) {
            seen.add(tabId);
            selectedTabIds.push(tabId);
        }
    }

    if (selectedTabIds.length) {
        return {scope: 'selected', selectedTabIds};
    }

    const requestedScope = query.getAll('scope').find(scope => SCOPES.has(scope) && scope !== 'selected');
    const normalizedFallback = SCOPES.has(fallbackScope) && fallbackScope !== 'selected'
        ? fallbackScope
        : DEFAULT_SCOPE;
    return {
        scope: requestedScope ?? normalizedFallback,
        selectedTabIds,
    };
}

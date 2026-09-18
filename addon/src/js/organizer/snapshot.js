import {createGroupingRequest, ORGANIZER_SCOPES} from './contracts.js';

function fail(message) {
    throw new TypeError(message);
}

function tabId(tab) {
    return tab.id;
}

function defaultGroupId() {
    return null;
}

function isInScope(tab, {scope, currentWindowId, currentGroupId, selectedTabIds, getGroupId}) {
    switch (scope) {
        case 'ungrouped-current-window':
            return tab.windowId === currentWindowId && (getGroupId(tabId(tab)) ?? null) === null;
        case 'current-group':
            return currentGroupId != null && getGroupId(tabId(tab)) === currentGroupId;
        case 'selected':
            return selectedTabIds.has(tabId(tab));
        case 'all':
            return true;
        default:
            fail(`scope must be one of: ${ORGANIZER_SCOPES.join(', ')}`);
    }
}

export function selectTabsForScope(tabs, {
    scope,
    currentWindowId = null,
    currentGroupId = null,
    selectedTabIds = [],
    getGroupId = defaultGroupId,
    isCanNotBeHidden,
} = {}) {
    if (!Array.isArray(tabs)) {
        fail('tabs must be an array');
    }
    if (!ORGANIZER_SCOPES.includes(scope)) {
        fail(`scope must be one of: ${ORGANIZER_SCOPES.join(', ')}`);
    }
    if (typeof isCanNotBeHidden !== 'function') {
        fail('isCanNotBeHidden must be a function');
    }

    const selectedIds = new Set(selectedTabIds);
    const selectionContext = {
        scope,
        currentWindowId,
        currentGroupId,
        selectedTabIds: selectedIds,
        getGroupId,
    };
    const selectedTabs = [];
    const skipped = [];

    for (const tab of tabs) {
        if (!isInScope(tab, selectionContext)) {
            continue;
        }
        if (tab.pinned === true) {
            skipped.push({tabId: tabId(tab), reason: 'pinned'});
        } else if (isCanNotBeHidden(tab)) {
            skipped.push({tabId: tabId(tab), reason: 'unsupported'});
        } else {
            selectedTabs.push(tab);
        }
    }

    return {tabs: selectedTabs, skipped};
}

export function normalizeOrganizerTab(tab, groupId = null) {
    const normalizedGroupId = groupId ?? null;
    const fingerprint = {
        tabId: tabId(tab),
        windowId: tab.windowId,
        url: tab.url,
        groupId: normalizedGroupId,
    };

    return {
        tabId: tabId(tab),
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        active: tab.active === true,
        audible: tab.audible === true,
        discarded: tab.discarded === true,
        groupId: normalizedGroupId,
        fingerprint,
    };
}

export async function collectSnapshot({
    scope,
    currentWindowId = null,
    currentGroupId = null,
    selectedTabIds = [],
    minimumGroupSize,
} = {}, {
    getTabs,
    getGroupId = defaultGroupId,
    isCanNotBeHidden,
    createRequestId = () => crypto.randomUUID(),
    now = () => new Date().toISOString(),
} = {}) {
    if (typeof getTabs !== 'function') {
        fail('getTabs must be a function');
    }
    if (typeof isCanNotBeHidden !== 'function') {
        fail('isCanNotBeHidden must be a function');
    }

    const selected = selectTabsForScope(await getTabs(), {
        scope,
        currentWindowId,
        currentGroupId,
        selectedTabIds,
        getGroupId,
        isCanNotBeHidden,
    });
    const normalizedTabs = selected.tabs.map(tab => normalizeOrganizerTab(tab, getGroupId(tabId(tab)) ?? null));
    const request = createGroupingRequest(normalizedTabs, {minimumGroupSize, scope});

    return {
        requestId: createRequestId(),
        capturedAt: now(),
        scope,
        tabs: normalizedTabs,
        skipped: selected.skipped,
        request,
    };
}

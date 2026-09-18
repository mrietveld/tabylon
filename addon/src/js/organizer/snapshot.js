import {createGroupingRequest, ORGANIZER_SCOPES} from './contracts.js';

function fail(message) {
    throw new TypeError(message);
}

function tabId(tab) {
    return tab.id;
}

function defaultGroupId(tab) {
    return tab.groupId ?? null;
}

function defaultIsCanNotBeHidden(tab) {
    return tab.pinned === true;
}

function isInScope(tab, {scope, currentWindowId, currentGroupId, selectedTabIds, getGroupId}) {
    switch (scope) {
        case 'ungrouped-current-window':
            return tab.windowId === currentWindowId && getGroupId(tab) === null;
        case 'current-group':
            return currentGroupId != null && getGroupId(tab) === currentGroupId;
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
    isCanNotBeHidden = defaultIsCanNotBeHidden,
} = {}) {
    if (!Array.isArray(tabs)) {
        fail('tabs must be an array');
    }
    if (!ORGANIZER_SCOPES.includes(scope)) {
        fail(`scope must be one of: ${ORGANIZER_SCOPES.join(', ')}`);
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
    isCanNotBeHidden = defaultIsCanNotBeHidden,
    createRequestId = () => crypto.randomUUID(),
    now = () => new Date().toISOString(),
} = {}) {
    if (typeof getTabs !== 'function') {
        fail('getTabs must be a function');
    }

    const selected = selectTabsForScope(await getTabs(), {
        scope,
        currentWindowId,
        currentGroupId,
        selectedTabIds,
        getGroupId,
        isCanNotBeHidden,
    });
    const normalizedTabs = selected.tabs.map(tab => normalizeOrganizerTab(tab, getGroupId(tab)));
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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    collectSnapshot,
    normalizeOrganizerTab,
    selectTabsForScope,
} from '../src/js/organizer/snapshot.js';

const browserTabs = [
    {id: 1, windowId: 10, title: 'Inbox', url: 'https://example.test/inbox', active: true},
    {id: 2, windowId: 10, title: 'Project', url: 'https://example.test/project'},
    {id: 3, windowId: 10, title: 'Pinned', url: 'https://example.test/pinned', pinned: true},
    {id: 4, windowId: 20, title: 'Other window', url: 'https://example.test/other'},
    {id: 5, windowId: 10, title: 'Protected', url: 'https://example.test/protected'},
];

const groupByTabId = new Map([[1, null], [2, 'project'], [3, null], [4, null], [5, null]]);
const context = overrides => ({
    currentWindowId: 10,
    currentGroupId: 'project',
    selectedTabIds: [2, 4],
    getGroupId: tab => groupByTabId.get(tab.id) ?? null,
    isCanNotBeHidden: tab => tab.id === 5,
    ...overrides,
});

function selectedIds(result) {
    return result.tabs.map(tab => tab.id);
}

test('selectTabsForScope selects only ungrouped tabs in the current window and reports in-scope exclusions', () => {
    const result = selectTabsForScope(browserTabs, context({scope: 'ungrouped-current-window'}));

    assert.deepEqual(selectedIds(result), [1]);
    assert.deepEqual(result.skipped, [
        {tabId: 3, reason: 'pinned'},
        {tabId: 5, reason: 'unsupported'},
    ]);
});

test('selectTabsForScope selects the current STG group without considering other scopes', () => {
    const result = selectTabsForScope(browserTabs, context({scope: 'current-group'}));

    assert.deepEqual(selectedIds(result), [2]);
    assert.deepEqual(result.skipped, []);
});

test('selectTabsForScope selects explicitly selected IDs across windows', () => {
    const result = selectTabsForScope(browserTabs, context({scope: 'selected'}));

    assert.deepEqual(selectedIds(result), [2, 4]);
    assert.deepEqual(result.skipped, []);
});

test('selectTabsForScope selects every eligible tab for all scope and records pinned and unsupported reasons', () => {
    const result = selectTabsForScope(browserTabs, context({scope: 'all'}));

    assert.deepEqual(selectedIds(result), [1, 2, 4]);
    assert.deepEqual(result.skipped, [
        {tabId: 3, reason: 'pinned'},
        {tabId: 5, reason: 'unsupported'},
    ]);
});

test('normalizeOrganizerTab preserves display hints, STG membership, and an apply fingerprint', () => {
    const normalized = normalizeOrganizerTab({
        id: 17,
        windowId: 3,
        title: 'Release notes',
        url: 'https://example.test/release',
        active: true,
        audible: true,
        discarded: false,
    }, 'release');

    assert.deepEqual(normalized, {
        tabId: 17,
        windowId: 3,
        title: 'Release notes',
        url: 'https://example.test/release',
        active: true,
        audible: true,
        discarded: false,
        groupId: 'release',
        fingerprint: {
            tabId: 17,
            windowId: 3,
            url: 'https://example.test/release',
            groupId: 'release',
        },
    });
});

test('collectSnapshot captures a validated service request while retaining the full snapshot', async () => {
    const snapshot = await collectSnapshot({
        scope: 'ungrouped-current-window',
        currentWindowId: 10,
        minimumGroupSize: 2,
    }, {
        getTabs: async () => browserTabs,
        getGroupId: tab => groupByTabId.get(tab.id) ?? null,
        isCanNotBeHidden: tab => tab.id === 5,
        createRequestId: () => 'request-789',
        now: () => '2026-09-18T12:00:00.000Z',
    });

    assert.deepEqual(snapshot, {
        requestId: 'request-789',
        capturedAt: '2026-09-18T12:00:00.000Z',
        scope: 'ungrouped-current-window',
        tabs: [{
            tabId: 1,
            windowId: 10,
            title: 'Inbox',
            url: 'https://example.test/inbox',
            active: true,
            audible: false,
            discarded: false,
            groupId: null,
            fingerprint: {
                tabId: 1,
                windowId: 10,
                url: 'https://example.test/inbox',
                groupId: null,
            },
        }],
        skipped: [
            {tabId: 3, reason: 'pinned'},
            {tabId: 5, reason: 'unsupported'},
        ],
        request: {
            tabs: [{tabId: 1, title: 'Inbox', url: 'https://example.test/inbox'}],
            minimumGroupSize: 2,
            scope: 'ungrouped-current-window',
        },
    });
});

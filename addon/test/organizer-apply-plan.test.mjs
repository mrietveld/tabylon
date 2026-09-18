import assert from 'node:assert/strict';
import test from 'node:test';

import {applyDraft, preflightDraft} from '../src/js/organizer/apply-plan.js';

function draftFixture({groups, unassignedTabIds = []} = {}) {
    const tabs = [
        {tabId: 1, windowId: 10, title: 'One', url: 'https://example.test/1', groupId: 'old-a'},
        {tabId: 2, windowId: 10, title: 'Two', url: 'https://example.test/2', groupId: 'old-a'},
        {tabId: 3, windowId: 20, title: 'Three', url: 'https://example.test/3', groupId: 'old-b'},
        {tabId: 4, windowId: 20, title: 'Four', url: 'https://example.test/4', groupId: null},
        {tabId: 5, windowId: 20, title: 'Five', url: 'https://example.test/5', groupId: null},
    ].map(tab => ({
        ...tab,
        active: false,
        audible: false,
        discarded: false,
        fingerprint: {
            tabId: tab.tabId,
            windowId: tab.windowId,
            url: tab.url,
            groupId: tab.groupId,
        },
    }));

    return {
        requestId: 'request-1',
        planId: 'plan-1',
        scope: 'all',
        summary: 'A plan',
        warnings: [],
        snapshot: {
            requestId: 'request-1',
            capturedAt: '2026-09-18T12:00:00.000Z',
            scope: 'all',
            tabs,
            skipped: [],
            request: {
                tabs: tabs.map(({tabId, title, url}) => ({tabId, title, url})),
                options: {minimumGroupSize: 2, scope: 'all'},
            },
        },
        groups: groups ?? [
            {id: 'draft-a', name: 'First', reason: 'First reason', tabIds: [1, 2]},
            {id: 'draft-b', name: 'Second', reason: 'Second reason', tabIds: [3, 4]},
        ],
        unassignedTabIds: unassignedTabIds.length ? unassignedTabIds : [5],
    };
}

function liveTabsFor(draft) {
    return draft.snapshot.tabs.map(tab => ({
        id: tab.tabId,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        pinned: false,
        audible: tab.audible,
        discarded: tab.discarded,
    }));
}

function operationFixture(draft, overrides = {}) {
    const memberships = new Map(draft.snapshot.tabs.map(tab => [tab.tabId, tab.groupId]));
    const events = [];
    let nextGroup = 0;

    const operations = {
        async getTabs() {
            return liveTabsFor(draft);
        },
        getTabGroup(tabId) {
            return memberships.get(tabId);
        },
        async addGroup(_windowId, _tabIds, name) {
            const group = {id: `created-${++nextGroup}`};
            events.push(['add', name, group.id]);
            return group;
        },
        async moveTabs(tabIds, groupId) {
            events.push(['move', [...tabIds], groupId]);
            tabIds.forEach(tabId => memberships.set(tabId, groupId));
        },
        async restoreTabs(tabIds, groupId) {
            events.push(['restore', [...tabIds], groupId]);
            tabIds.forEach(tabId => memberships.set(tabId, groupId));
        },
        async removeGroup(groupId) {
            events.push(['remove', groupId]);
        },
        ...overrides,
    };

    return {events, memberships, operations};
}

test('preflight reports every kind of assigned-tab drift and ignores unassigned tabs', () => {
    const draft = draftFixture();
    const liveTabs = liveTabsFor(draft)
        .filter(tab => tab.id !== 1 && tab.id !== 5)
        .map(tab => {
            if (tab.id === 2) return {...tab, url: 'https://changed.test/2'};
            if (tab.id === 3) return {...tab, windowId: 99};
            return tab;
        });
    const membership = new Map([[2, 'old-a'], [3, 'old-b'], [4, 'new-membership']]);

    const result = preflightDraft(draft, liveTabs, tabId => membership.get(tabId));

    assert.deepEqual(result, {
        ok: false,
        missingTabIds: [1],
        urlChangedTabIds: [2],
        windowChangedTabIds: [3],
        groupChangedTabIds: [4],
    });
});

test('apply creates and moves groups in draft order', async () => {
    const draft = draftFixture();
    const {events, operations} = operationFixture(draft);

    const result = await applyDraft(draft, operations);

    assert.equal(result.success, true);
    assert.equal(result.failure, null);
    assert.deepEqual(result.createdGroups, [
        {draftGroupId: 'draft-a', groupId: 'created-1', tabIds: [1, 2]},
        {draftGroupId: 'draft-b', groupId: 'created-2', tabIds: [3, 4]},
    ]);
    assert.deepEqual(result.rollbackFailures, []);
    assert.deepEqual(events, [
        ['add', 'First', 'created-1'],
        ['move', [1, 2], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3, 4], 'created-2'],
    ]);
});

test('apply compensates failed work in reverse group order', async () => {
    const draft = draftFixture();
    const fixture = operationFixture(draft);
    const baseMoveTabs = fixture.operations.moveTabs;
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        await baseMoveTabs(tabIds, groupId);
        if (groupId === 'created-2') {
            throw new Error('second move failed after changing membership');
        }
    };

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.success, false);
    assert.deepEqual(result.failure, {
        stage: 'move-tabs',
        draftGroupId: 'draft-b',
        groupId: 'created-2',
        message: 'second move failed after changing membership',
    });
    assert.deepEqual(result.rollbackFailures, []);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(fixture.events, [
        ['add', 'First', 'created-1'],
        ['move', [1, 2], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3, 4], 'created-2'],
        ['restore', [3], 'old-b'],
        ['restore', [4], null],
        ['remove', 'created-2'],
        ['restore', [1, 2], 'old-a'],
        ['remove', 'created-1'],
    ]);
});

test('apply reports rollback failure and never removes a group that still owns a tab', async () => {
    const draft = draftFixture({
        groups: [
            {id: 'draft-a', name: 'First', reason: 'First reason', tabIds: [4]},
            {id: 'draft-b', name: 'Second', reason: 'Second reason', tabIds: [3]},
        ],
        unassignedTabIds: [1, 2, 5],
    });
    const fixture = operationFixture(draft);
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        fixture.events.push(['move', [...tabIds], groupId]);
        tabIds.forEach(tabId => fixture.memberships.set(tabId, groupId));
        if (groupId === 'created-2') throw new Error('stop');
    };
    fixture.operations.restoreTabs = async (tabIds, groupId) => {
        fixture.events.push(['restore', [...tabIds], groupId]);
        if (groupId === null) throw new Error('ungrouped restoration is unsafe');
        tabIds.forEach(tabId => fixture.memberships.set(tabId, groupId));
    };

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.deepEqual(result.rollbackFailures, [
        {
            stage: 'restore-tabs',
            draftGroupId: 'draft-a',
            groupId: 'created-1',
            originalGroupId: null,
            tabIds: [4],
            message: 'ungrouped restoration is unsafe',
        },
        {
            stage: 'remove-group',
            draftGroupId: 'draft-a',
            groupId: 'created-1',
            remainingTabIds: [4],
            message: 'Created group still contains tabs after rollback; removal was skipped.',
        },
    ]);
    assert.deepEqual(fixture.events, [
        ['add', 'First', 'created-1'],
        ['move', [4], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3], 'created-2'],
        ['restore', [3], 'old-b'],
        ['remove', 'created-2'],
        ['restore', [4], null],
    ]);
});

test('rollback verifies all live tabs before removing a created group', async () => {
    const draft = draftFixture();
    const fixture = operationFixture(draft);
    fixture.operations.getTabs = async () => [
        ...liveTabsFor(draft),
        {id: 99, windowId: 30, url: 'https://unrelated.test/'},
    ];
    fixture.memberships.set(99, null);
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        fixture.events.push(['move', [...tabIds], groupId]);
        tabIds.forEach(tabId => fixture.memberships.set(tabId, groupId));
        if (groupId === 'created-1') fixture.memberships.set(99, groupId);
        if (groupId === 'created-2') throw new Error('stop');
    };

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.rolledBack, false);
    assert.deepEqual(result.rollbackFailures, [{
        stage: 'remove-group',
        draftGroupId: 'draft-a',
        groupId: 'created-1',
        remainingTabIds: [99],
        message: 'Created group still contains tabs after rollback; removal was skipped.',
    }]);
    assert.equal(fixture.events.some(event => event[0] === 'remove' && event[1] === 'created-1'), false);
});

test('preflight failure performs no group or tab mutations', async () => {
    const draft = draftFixture();
    const {events, operations} = operationFixture(draft, {
        async getTabs() {
            return liveTabsFor(draft).filter(tab => tab.id !== 2);
        },
    });

    const result = await applyDraft(draft, operations);

    assert.equal(result.success, false);
    assert.equal(result.failure.stage, 'preflight');
    assert.deepEqual(result.preflight.missingTabIds, [2]);
    assert.deepEqual(events, []);
});

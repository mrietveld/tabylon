import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyDraft,
    createTrackedAddGroupOperation,
    preflightDraft,
} from '../src/js/organizer/apply-plan.js';

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
            return tabIds.map(id => ({id}));
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
        {draftGroupId: 'draft-a', groupId: 'created-1', sourceTabIds: [1, 2], tabIds: [1, 2]},
        {draftGroupId: 'draft-b', groupId: 'created-2', sourceTabIds: [3, 4], tabIds: [3, 4]},
    ]);
    assert.deepEqual(result.rollbackFailures, []);
    assert.deepEqual(events, [
        ['add', 'First', 'created-1'],
        ['move', [1], 'created-1'],
        ['move', [2], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3], 'created-2'],
        ['move', [4], 'created-2'],
    ]);
});

test('apply compensates failed work in reverse group order', async () => {
    const draft = draftFixture();
    const fixture = operationFixture(draft);
    const baseMoveTabs = fixture.operations.moveTabs;
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        if (tabIds[0] === 4) {
            fixture.events.push(['move', [...tabIds], groupId]);
            return [];
        }
        return baseMoveTabs(tabIds, groupId);
    };

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.success, false);
    assert.deepEqual(result.failure, {
        stage: 'move-tabs',
        draftGroupId: 'draft-b',
        groupId: 'created-2',
        sourceTabId: 4,
        reason: 'empty-result',
        returnedTabIds: [],
        message: 'Moving tab 4 did not return exactly one live tab.',
    });
    assert.deepEqual(result.rollbackFailures, []);
    assert.equal(result.rolledBack, false);
    assert.deepEqual(result.retainedGroups, [
        {draftGroupId: 'draft-b', groupId: 'created-2', remainingTabIds: []},
        {draftGroupId: 'draft-a', groupId: 'created-1', remainingTabIds: []},
    ]);
    assert.deepEqual(fixture.events, [
        ['add', 'First', 'created-1'],
        ['move', [1], 'created-1'],
        ['move', [2], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3], 'created-2'],
        ['move', [4], 'created-2'],
        ['restore', [3], 'old-b'],
        ['restore', [2], 'old-a'],
        ['restore', [1], 'old-a'],
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
        if (groupId === 'created-2') return [];
        tabIds.forEach(tabId => fixture.memberships.set(tabId, groupId));
        return tabIds.map(id => ({id}));
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
    ]);
    assert.deepEqual(result.retainedGroups, [
        {draftGroupId: 'draft-b', groupId: 'created-2', remainingTabIds: []},
        {draftGroupId: 'draft-a', groupId: 'created-1', remainingTabIds: [4]},
    ]);
    assert.deepEqual(fixture.events, [
        ['add', 'First', 'created-1'],
        ['move', [4], 'created-1'],
        ['add', 'Second', 'created-2'],
        ['move', [3], 'created-2'],
        ['restore', [4], null],
    ]);
});

test('rollback never removes created groups even when restored membership appears empty', async () => {
    const draft = draftFixture();
    const fixture = operationFixture(draft);
    fixture.operations.removeGroup = async () => assert.fail('rollback must retain created groups');
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        fixture.events.push(['move', [...tabIds], groupId]);
        if (tabIds[0] === 4) return [];
        tabIds.forEach(tabId => fixture.memberships.set(tabId, groupId));
        return tabIds.map(id => ({id}));
    };

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.rolledBack, false);
    assert.deepEqual(result.rollbackFailures, []);
    assert.deepEqual(result.retainedGroups, [
        {draftGroupId: 'draft-b', groupId: 'created-2', remainingTabIds: []},
        {draftGroupId: 'draft-a', groupId: 'created-1', remainingTabIds: []},
    ]);
    assert.equal(fixture.events.some(event => event[0] === 'remove'), false);
});

test('apply records recreated tab IDs and compensates with those actual IDs', async () => {
    const draft = draftFixture({
        groups: [
            {id: 'draft-a', name: 'First', reason: 'First reason', tabIds: [1]},
            {id: 'draft-b', name: 'Second', reason: 'Second reason', tabIds: [3]},
        ],
        unassignedTabIds: [2, 4, 5],
    });
    const fixture = operationFixture(draft);
    let tabQuery = 0;
    fixture.operations.moveTabs = async (tabIds, groupId) => {
        fixture.events.push(['move', [...tabIds], groupId]);
        if (tabIds[0] === 1) {
            fixture.memberships.delete(1);
            fixture.memberships.set(101, groupId);
            return [{id: 101}];
        }
        return [];
    };
    fixture.operations.getTabs = async () => ++tabQuery === 1
        ? liveTabsFor(draft)
        : [
            ...liveTabsFor(draft).filter(tab => tab.id !== 1),
            {id: 101, windowId: 10, url: 'https://example.test/1'},
        ];

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.success, false);
    assert.deepEqual(result.createdGroups[0], {
        draftGroupId: 'draft-a',
        groupId: 'created-1',
        sourceTabIds: [1],
        tabIds: [101],
    });
    assert.deepEqual(fixture.events.slice(-1), [['restore', [101], 'old-a']]);
});

test('apply reports empty, malformed, and multiple single-tab move results precisely', async t => {
    const cases = [
        {name: 'empty', returned: [], reason: 'empty-result', returnedTabIds: []},
        {name: 'malformed', returned: [{}], reason: 'malformed-result', returnedTabIds: []},
        {name: 'multiple', returned: [{id: 1}, {id: 101}], reason: 'multiple-results', returnedTabIds: [1, 101]},
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const draft = draftFixture();
            const fixture = operationFixture(draft, {
                async moveTabs() {
                    return item.returned;
                },
            });

            const result = await applyDraft(draft, fixture.operations);

            assert.equal(result.success, false);
            assert.equal(result.failure.stage, 'move-tabs');
            assert.equal(result.failure.sourceTabId, 1);
            assert.equal(result.failure.reason, item.reason);
            assert.deepEqual(result.failure.returnedTabIds, item.returnedTabIds);
            assert.deepEqual(result.retainedGroups, [
                {draftGroupId: 'draft-a', groupId: 'created-1', remainingTabIds: []},
            ]);
        });
    }
});

test('apply reports group IDs discovered after a late add rejection as retained', async () => {
    const draft = draftFixture();
    const error = Object.assign(new Error('menu update failed'), {
        createdGroupIds: ['late-created'],
        groupCreationUncertain: false,
    });
    const fixture = operationFixture(draft, {
        async addGroup() {
            throw error;
        },
    });

    const result = await applyDraft(draft, fixture.operations);

    assert.equal(result.success, false);
    assert.deepEqual(result.failure.retainedGroupIds, ['late-created']);
    assert.equal(result.failure.groupCreationUncertain, false);
    assert.deepEqual(result.retainedGroups, [{
        draftGroupId: 'draft-a',
        groupId: 'late-created',
        remainingTabIds: [],
    }]);
});

test('tracked add operation discovers groups persisted before add rejects', async () => {
    const groups = [{id: 'existing'}];
    const addGroup = createTrackedAddGroupOperation({
        getGroups: async () => groups.map(group => ({...group})),
        addGroup: async () => {
            groups.push({id: 'late-created'});
            throw new Error('menu update failed');
        },
    });

    await assert.rejects(
        addGroup(null, [], 'New group'),
        error => {
            assert.equal(error.message, 'Group creation failed after it may have been persisted.');
            assert.deepEqual(error.createdGroupIds, ['late-created']);
            assert.equal(error.groupCreationUncertain, false);
            return true;
        },
    );
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

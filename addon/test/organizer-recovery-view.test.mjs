import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createdGroupDetails,
    preflightChangeDetails,
    removeStaleAssignedTabs,
    retainedGroupDetails,
    rollbackFailureDetails,
} from '../src/organize/recovery.js';

test('success details expose each created group name and exact tab count', () => {
    const details = createdGroupDetails({
        success: true,
        createdGroups: [
            {draftGroupId: 'draft-a', groupId: 'created-a', name: 'Research', tabIds: [101, 102]},
            {draftGroupId: 'draft-b', groupId: 'created-b', name: 'Planning', tabCount: 1},
        ],
    });

    assert.deepEqual(details, [
        {groupId: 'created-a', name: 'Research', tabCount: 2},
        {groupId: 'created-b', name: 'Planning', tabCount: 1},
    ]);
});

test('failure details preserve retained identities, remaining tab IDs, and rollback tab IDs', () => {
    const result = {
        failure: {retainedGroupIds: ['created-b']},
        retainedGroups: [{
            draftGroupId: 'draft-a',
            groupId: 'created-a',
            remainingTabIds: [101, 102],
        }],
        rollbackFailures: [{
            stage: 'restore-tabs',
            draftGroupId: 'draft-a',
            groupId: 'created-a',
            tabIds: [102],
            message: 'Restore failed.',
        }],
    };

    assert.deepEqual(retainedGroupDetails(result), [
        {
            draftGroupId: 'draft-a',
            groupId: 'created-a',
            remainingTabIds: [101, 102],
            remainingTabCount: 2,
        },
        {
            draftGroupId: null,
            groupId: 'created-b',
            remainingTabIds: null,
            remainingTabCount: null,
        },
    ]);
    assert.deepEqual(rollbackFailureDetails(result), [{
        stage: 'restore-tabs',
        groupId: 'created-a',
        tabIds: [102],
        message: 'Restore failed.',
    }]);
});

test('removing stale assigned tabs also removes groups made empty', () => {
    const draft = {
        requestId: 'request-1',
        planId: 'plan-1',
        summary: '',
        warnings: [],
        snapshot: {
            requestId: 'request-1',
            tabs: [{tabId: 1}, {tabId: 2}, {tabId: 3}],
        },
        groups: [
            {id: 'draft-a', name: 'One', reason: '', tabIds: [1]},
            {id: 'draft-b', name: 'Two', reason: '', tabIds: [2, 3]},
        ],
        unassignedTabIds: [],
    };
    const preflight = {
        ok: false,
        missingTabIds: [1],
        urlChangedTabIds: [2],
        windowChangedTabIds: [2],
        groupChangedTabIds: [],
    };

    const updated = removeStaleAssignedTabs(draft, preflight);

    assert.deepEqual(updated.groups, [
        {id: 'draft-b', name: 'Two', reason: '', tabIds: [3]},
    ]);
    assert.deepEqual(updated.unassignedTabIds, [1, 2]);
    assert.deepEqual(draft.groups.map(group => group.tabIds), [[1], [2, 3]]);
});

test('preflight details retain each drift category and its exact tab IDs', () => {
    assert.deepEqual(preflightChangeDetails({
        missingTabIds: [1],
        urlChangedTabIds: [2],
        windowChangedTabIds: [3],
        groupChangedTabIds: [4],
    }), [
        {label: 'Missing', tabIds: [1]},
        {label: 'URL changed', tabIds: [2]},
        {label: 'Window changed', tabIds: [3]},
        {label: 'Group changed', tabIds: [4]},
    ]);
});

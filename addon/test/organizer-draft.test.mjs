import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDraft,
    moveDraftTabToGroup,
    moveDraftTabToUnassigned,
    removeDraftGroup,
    renameDraftGroup,
    validateDraft,
} from '../src/js/organizer/draft.js';

const snapshot = {
    requestId: 'request-456',
    scope: 'selected',
    request: {minimumGroupSize: 2},
    tabs: [
        {tabId: 1, windowId: 1, title: 'Alpha one', url: 'https://example.test/a1'},
        {tabId: 2, windowId: 1, title: 'Alpha two', url: 'https://example.test/a2'},
        {tabId: 3, windowId: 1, title: 'Beta one', url: 'https://example.test/b1'},
        {tabId: 4, windowId: 1, title: 'Beta two', url: 'https://example.test/b2'},
        {tabId: 5, windowId: 1, title: 'Unassigned', url: 'https://example.test/u'},
    ],
};

const plan = {
    planId: 'plan-456',
    requestId: 'request-456',
    summary: 'Two related groups.',
    groups: [
        {groupId: 'alpha', name: 'Alpha', reason: 'Alpha tabs', tabIds: [1, 2]},
        {groupId: 'beta', name: 'Beta', reason: 'Beta tabs', tabIds: [3, 4]},
    ],
    ungroupedTabIds: [5],
    warnings: [],
};

const makeDraft = () => createDraft(snapshot, plan);

test('createDraft copies the validated plan into stable editable group IDs', () => {
    const draft = makeDraft();

    assert.deepEqual(draft.groups, [
        {id: 'alpha', name: 'Alpha', reason: 'Alpha tabs', tabIds: [1, 2]},
        {id: 'beta', name: 'Beta', reason: 'Beta tabs', tabIds: [3, 4]},
    ]);
    assert.deepEqual(draft.unassignedTabIds, [5]);
    assert.notStrictEqual(draft.snapshot, snapshot);
    assert.deepEqual(validateDraft(draft), draft);
});

test('renameDraftGroup returns a valid renamed copy without changing the source draft', () => {
    const draft = makeDraft();
    const renamed = renameDraftGroup(draft, 'alpha', 'Alpha research');

    assert.notStrictEqual(renamed, draft);
    assert.equal(renamed.groups[0].name, 'Alpha research');
    assert.equal(draft.groups[0].name, 'Alpha');
    assert.deepEqual(validateDraft(renamed), renamed);
});

test('moveDraftTabToGroup moves an unassigned tab into the requested group immutably', () => {
    const draft = makeDraft();
    const moved = moveDraftTabToGroup(draft, 5, 'beta');

    assert.deepEqual(moved.groups[1].tabIds, [3, 4, 5]);
    assert.deepEqual(moved.unassignedTabIds, []);
    assert.deepEqual(draft.groups[1].tabIds, [3, 4]);
    assert.deepEqual(draft.unassignedTabIds, [5]);
    assert.deepEqual(validateDraft(moved), moved);
});

test('moveDraftTabToUnassigned permits a draft group below the service minimum', () => {
    const draft = makeDraft();
    const moved = moveDraftTabToUnassigned(draft, 1);

    assert.deepEqual(moved.groups[0].tabIds, [2]);
    assert.deepEqual(moved.unassignedTabIds, [5, 1]);
    assert.deepEqual(validateDraft(moved), moved);
});

test('removeDraftGroup places its tabs in the unassigned tray without changing the source', () => {
    const draft = makeDraft();
    const removed = removeDraftGroup(draft, 'alpha');

    assert.deepEqual(removed.groups.map(group => group.id), ['beta']);
    assert.deepEqual(removed.unassignedTabIds, [5, 1, 2]);
    assert.deepEqual(draft.groups.map(group => group.id), ['alpha', 'beta']);
    assert.deepEqual(validateDraft(removed), removed);
});

test('validateDraft rejects empty groups, duplicate assignments, and blank edited names', () => {
    const empty = makeDraft();
    empty.groups[0].tabIds = [];
    assert.throws(() => validateDraft(empty), /empty/i);

    const duplicate = makeDraft();
    duplicate.unassignedTabIds = [5, 1];
    assert.throws(() => validateDraft(duplicate), /duplicate/i);

    const blankName = makeDraft();
    blankName.groups[0].name = ' ';
    assert.throws(() => validateDraft(blankName), /name/i);
});

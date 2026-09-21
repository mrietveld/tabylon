import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createGroupingRequest,
    validateGroupingPlan,
} from '../src/js/organizer/contracts.js';

const tabs = [
    {tabId: 101, windowId: 1, title: 'Project notes', url: 'https://example.test/notes'},
    {tabId: 102, windowId: 1, title: 'Project issue', url: 'https://example.test/issues'},
    {tabId: 103, windowId: 1, title: 'Inbox', url: 'https://example.test/inbox'},
];

const snapshot = {
    requestId: 'request-123',
    scope: 'ungrouped-current-window',
    request: {
        minimumGroupSize: 2,
    },
    tabs,
};

const validPlan = () => ({
    planId: 'plan-123',
    requestId: 'request-123',
    summary: 'One project group.',
    groups: [{
        groupId: 'project',
        name: 'Project',
        reason: 'Related project work',
        tabIds: [101, 102],
    }],
    ungroupedTabIds: [103],
    warnings: [],
});

test('createGroupingRequest sends only bounded service tab fields and options', () => {
    const request = createGroupingRequest(tabs, {
        minimumGroupSize: 2,
        scope: 'ungrouped-current-window',
    });

    assert.deepEqual(request, {
        tabs: [
            {tabId: 101, title: 'Project notes', url: 'https://example.test/notes'},
            {tabId: 102, title: 'Project issue', url: 'https://example.test/issues'},
            {tabId: 103, title: 'Inbox', url: 'https://example.test/inbox'},
        ],
        minimumGroupSize: 2,
        scope: 'ungrouped-current-window',
    });
});

test('createGroupingRequest rejects unsupported scopes, invalid minimums, and oversized tab input', () => {
    assert.throws(
        () => createGroupingRequest(tabs, {minimumGroupSize: 2, scope: 'other'}),
        /scope/i,
    );
    assert.throws(
        () => createGroupingRequest(tabs, {minimumGroupSize: 0, scope: 'selected'}),
        /minimum/i,
    );
    assert.throws(
        () => createGroupingRequest([{...tabs[0], title: 'x'.repeat(1025)}], {
            minimumGroupSize: 2,
            scope: 'selected',
        }),
        /title/i,
    );
});

test('createGroupingRequest accepts a 1024-character tab title', () => {
    const title = 'x'.repeat(1024);
    const request = createGroupingRequest([{...tabs[0], title}], {
        minimumGroupSize: 2,
        scope: 'selected',
    });

    assert.equal(request.tabs[0].title, title);
});

test('validateGroupingPlan accepts a complete plan tied to its snapshot', () => {
    assert.deepEqual(validateGroupingPlan(validPlan(), snapshot), validPlan());
});

test('validateGroupingPlan rejects a mismatched request ID', () => {
    const plan = validPlan();
    plan.requestId = 'different-request';

    assert.throws(() => validateGroupingPlan(plan, snapshot), /requestId/i);
});

test('validateGroupingPlan rejects tab IDs absent from the snapshot', () => {
    const plan = validPlan();
    plan.groups[0].tabIds = [101, 999];

    assert.throws(() => validateGroupingPlan(plan, snapshot), /unknown tab/i);
});

test('validateGroupingPlan rejects duplicate assignments across groups and ungrouped tabs', () => {
    const plan = validPlan();
    plan.ungroupedTabIds = [102, 103];

    assert.throws(() => validateGroupingPlan(plan, snapshot), /duplicate/i);
});

test('validateGroupingPlan rejects blank and oversized group names', () => {
    const blank = validPlan();
    blank.groups[0].name = '   ';
    assert.throws(() => validateGroupingPlan(blank, snapshot), /name/i);

    const oversized = validPlan();
    oversized.groups[0].name = 'x'.repeat(121);
    assert.throws(() => validateGroupingPlan(oversized, snapshot), /name/i);
});

test('validateGroupingPlan enforces the snapshot minimum group size', () => {
    const plan = validPlan();
    plan.groups[0].tabIds = [101];
    plan.ungroupedTabIds = [102, 103];

    assert.throws(() => validateGroupingPlan(plan, snapshot), /minimum/i);
});

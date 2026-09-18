import assert from 'node:assert/strict';
import test from 'node:test';

import {createOrganizerWorkflow} from '../src/js/organizer/index.js';

function createSessionStorage() {
    const data = new Map();
    return {
        async get(key) {
            return data.has(key) ? {[key]: structuredClone(data.get(key))} : {};
        },
        async set(values) {
            for (const [key, value] of Object.entries(values)) {
                data.set(key, structuredClone(value));
            }
        },
        async remove(key) {
            data.delete(key);
        },
    };
}

function jsonResponse(body, {ok = true, status = 200} = {}) {
    return {
        ok,
        status,
        async json() {
            return structuredClone(body);
        },
    };
}

const tabs = Array.from({length: 5}, (_, index) => ({
    id: index + 1,
    windowId: 7,
    title: `Tab ${index + 1}`,
    url: `https://example.test/${index + 1}`,
    active: index === 0,
    pinned: false,
    audible: index === 1,
    discarded: index === 4,
}));

function planFor(requestId, planId = 'plan-1') {
    return {
        planId,
        requestId,
        summary: 'One useful group',
        groups: [{
            groupId: 'suggested-1',
            name: 'Example',
            reason: 'Shared task',
            tabIds: [1, 2, 3, 4, 5],
        }],
        ungroupedTabIds: [],
        warnings: [],
    };
}

function workflowDependencies(overrides = {}) {
    return {
        getOptions: () => ({
            organizerServiceUrl: 'http://127.0.0.1:5050',
            organizerMinimumGroupSize: 5,
            organizerDefaultScope: 'ungrouped-current-window',
        }),
        getTabs: async () => tabs,
        getCurrentWindow: async () => ({id: 7, groupId: 'current-group'}),
        getGroupId: () => undefined,
        isCanNotBeHidden: () => false,
        createRequestId: () => 'request-1',
        now: () => '2026-09-18T15:00:00.000Z',
        storageArea: createSessionStorage(),
        fetchImpl: async (_url, init) => jsonResponse(planFor(JSON.parse(init.body).requestId)),
        ...overrides,
    };
}

test('start composes configured defaults into a persisted review draft', async () => {
    const workflow = createOrganizerWorkflow(workflowDependencies());

    const state = await workflow.start();

    assert.equal(state.phase, 'review');
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.params, {
        scope: 'ungrouped-current-window',
        minimumGroupSize: 5,
        selectedTabIds: [],
    });
    assert.equal(state.snapshot.requestId, 'request-1');
    assert.equal(state.snapshot.tabs.length, 5);
    assert.deepEqual(state.plan, planFor('request-1'));
    assert.equal(state.draft.planId, 'plan-1');
    assert.equal(state.error, null);
    assert.equal(state.applyResult, null);
    assert.deepEqual(await workflow.getState(), state);
});

test('start records only structured safe error details when generation fails', async () => {
    const workflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => {
            throw new Error('Tab 1 https://example.test/1 failed via private.internal');
        },
    }));

    const state = await workflow.start();

    assert.equal(state.phase, 'generate');
    assert.equal(state.status, 'error');
    assert.deepEqual(state.error, {
        code: 'network-error',
        message: 'The organizer service could not be reached.',
        status: null,
    });
    assert.doesNotMatch(JSON.stringify(state.error), /Tab 1|example\.test|private\.internal/);
    assert.equal(state.plan, null);
    assert.equal(state.draft, null);
    assert.equal(state.applyResult, null);
});

test('saveDraft persists editable names and assignments but restores service-owned fields', async () => {
    const workflow = createOrganizerWorkflow(workflowDependencies());
    const state = await workflow.start();
    const edited = {
        ...state.draft,
        scope: 'all',
        summary: 'Submitted replacement summary',
        warnings: ['Submitted replacement warning'],
        groups: state.draft.groups.map(group => ({
            ...group,
            name: 'Renamed',
            reason: 'Submitted replacement reason',
            tabIds: [1, 2, 3, 4],
        })),
        unassignedTabIds: [5],
    };

    const saved = await workflow.saveDraft(edited);

    assert.equal(saved.draft.groups[0].name, 'Renamed');
    assert.deepEqual(saved.draft.groups[0].tabIds, [1, 2, 3, 4]);
    assert.deepEqual(saved.draft.unassignedTabIds, [5]);
    assert.equal(saved.draft.scope, 'ungrouped-current-window');
    assert.equal(saved.draft.summary, 'One useful group');
    assert.deepEqual(saved.draft.warnings, []);
    assert.equal(saved.draft.groups[0].reason, 'Shared task');
    assert.equal((await workflow.getState()).draft.groups[0].name, 'Renamed');
});

test('saveDraft rejects replacement snapshots and inactive plan identities', async () => {
    const workflow = createOrganizerWorkflow(workflowDependencies());
    const state = await workflow.start();
    const changedSnapshot = structuredClone(state.draft);
    changedSnapshot.snapshot.tabs[0].url = 'https://attacker.example/replaced';

    await assert.rejects(
        workflow.saveDraft(changedSnapshot),
        /snapshot/i,
    );
    await assert.rejects(
        workflow.saveDraft({...state.draft, planId: 'another-plan'}),
        /planId/i,
    );
});

test('refresh reuses workflow params and clear returns to an empty choose state', async () => {
    let requestNumber = 0;
    const workflow = createOrganizerWorkflow(workflowDependencies({
        createRequestId: () => `request-${++requestNumber}`,
        fetchImpl: async (_url, init) => {
            const {requestId} = JSON.parse(init.body);
            return jsonResponse(planFor(requestId, `plan-${requestNumber}`));
        },
    }));
    await workflow.start({scope: 'all', minimumGroupSize: 5, selectedTabIds: [2]});

    const refreshed = await workflow.refresh();

    assert.equal(refreshed.snapshot.requestId, 'request-2');
    assert.equal(refreshed.draft.planId, 'plan-2');
    assert.deepEqual(refreshed.params, {
        scope: 'all',
        minimumGroupSize: 5,
        selectedTabIds: [2],
    });

    assert.deepEqual(await workflow.clear(), {
        phase: 'choose',
        status: 'idle',
        params: null,
        snapshot: null,
        plan: null,
        draft: null,
        error: null,
        applyResult: null,
    });
    assert.deepEqual(await workflow.getState(), {
        phase: 'choose',
        status: 'idle',
        params: null,
        snapshot: null,
        plan: null,
        draft: null,
        error: null,
        applyResult: null,
    });
});

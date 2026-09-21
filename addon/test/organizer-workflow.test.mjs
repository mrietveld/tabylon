import assert from 'node:assert/strict';
import test from 'node:test';

import {createTrackedAddGroupOperation} from '../src/js/organizer/apply-plan.js';
import {OrganizerClientError} from '../src/js/organizer/client.js';
import {createOrganizerWorkflow} from '../src/js/organizer/index.js';
import {DRAFT_STATE_STORAGE_KEY} from '../src/js/organizer/draft-store.js';
import {OrganizerSnapshotError} from '../src/js/organizer/snapshot.js';

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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
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

test('start records and reports a plan diagnostic with technical details when generation fails', async () => {
    const reported = [];
    const secret = 'private-secret https://private.example/hidden';
    const workflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => {
            throw new Error(`Tab 1 ${secret} failed`);
        },
        reportGenerationFailure: diagnostic => {
            reported.push(diagnostic);
            throw new Error(`reporting ${secret}`);
        },
    }));

    const state = await workflow.start();

    assert.equal(state.phase, 'generate');
    assert.equal(state.status, 'error');
    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'network-error',
        message: 'The organizer service could not be reached.',
        status: null,
        stage: 'plan',
    });
    assert.deepEqual(reported, [state.error]);
    assert.equal(state.snapshot, null);
    assert.deepEqual(state.params, {
        scope: 'ungrouped-current-window',
        minimumGroupSize: 5,
        selectedTabIds: [],
    });
    assert.match(JSON.stringify(technicalException), /private-secret|private\.example/);
    assert.deepEqual(await workflow.getState(), state);
    assert.equal(state.plan, null);
    assert.equal(state.draft, null);
    assert.equal(state.applyResult, null);
});

test('start persists exact technical details for a direct snapshot TypeError', async () => {
    const technicalError = new TypeError('Snapshot predicate failed for <private-tab>');
    technicalError.stack = 'TypeError: Snapshot predicate failed for <private-tab>\n    at snapshot-filter.js:12:34';
    const workflow = createOrganizerWorkflow(workflowDependencies({
        isCanNotBeHidden: () => {
            throw technicalError;
        },
    }));

    const state = await workflow.start();

    assert.deepEqual(state.error, {
        code: 'snapshot-preparation-failed',
        message: 'The organizer could not prepare the selected tabs.',
        status: null,
        stage: 'snapshot',
        technicalException: {
            name: 'TypeError',
            message: 'Snapshot predicate failed for <private-tab>',
            stack: 'TypeError: Snapshot predicate failed for <private-tab>\n    at snapshot-filter.js:12:34',
            cause: null,
        },
    });
    assert.deepEqual(await workflow.getState(), state);
});

test('start persists and reports an OrganizerClientError with its immediate cause', async () => {
    const reported = [];
    const networkCause = new TypeError('fetch failed for https://private.example');
    networkCause.stack = 'TypeError: fetch failed for https://private.example\n    at fetch-client.js:56:78';
    const workflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => {
            throw networkCause;
        },
        reportGenerationFailure: diagnostic => reported.push(diagnostic),
    }));

    const state = await workflow.start();

    assert.equal(state.error.technicalException.name, 'OrganizerClientError');
    assert.equal(state.error.technicalException.message, 'The organizer service could not be reached.');
    assert.match(state.error.technicalException.stack, /^OrganizerClientError: The organizer service could not be reached\./);
    assert.deepEqual(state.error.technicalException.cause, {
        name: 'TypeError',
        message: 'fetch failed for https://private.example',
        stack: 'TypeError: fetch failed for https://private.example\n    at fetch-client.js:56:78',
    });
    assert.deepEqual(reported, [state.error]);
    assert.deepEqual(await workflow.getState(), state);
});

test('start makes a non-Error throw persistable and reportable', async () => {
    const reported = [];
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getOptions: async () => {
            throw '<settings unavailable>';
        },
        reportGenerationFailure: diagnostic => reported.push(diagnostic),
    }));

    const state = await workflow.start();

    assert.deepEqual(state.error.technicalException, {
        name: 'NonError',
        message: '<settings unavailable>',
        stack: null,
        cause: null,
    });
    assert.deepEqual(reported, [state.error]);
    assert.deepEqual(await workflow.getState(), state);
});

test('start safely serializes Error properties whose getters throw', async t => {
    const stableStack = 'Error: technical failure\n    at generation.js:10:20';
    const cases = [
        ['name', {
            name: 'Error',
            message: 'technical failure',
            stack: stableStack,
            cause: null,
        }],
        ['message', {
            name: 'Error',
            message: '',
            stack: stableStack,
            cause: null,
        }],
        ['stack', {
            name: 'Error',
            message: 'technical failure',
            stack: null,
            cause: null,
        }],
        ['cause', {
            name: 'Error',
            message: 'technical failure',
            stack: stableStack,
            cause: null,
        }],
    ];

    for (const [property, expected] of cases) {
        await t.test(property, async () => {
            const technicalError = new Error('technical failure');
            technicalError.stack = stableStack;
            Object.defineProperty(technicalError, property, {
                configurable: true,
                get() {
                    throw new Error(`reading ${property} failed`);
                },
            });
            const workflow = createOrganizerWorkflow(workflowDependencies({
                isCanNotBeHidden: () => {
                    throw technicalError;
                },
            }));

            const state = await workflow.start();

            assert.deepEqual(state.error.technicalException, expected);
            assert.deepEqual(await workflow.getState(), state);
        });
    }
});

test('start reads technical stack metadata only once', async () => {
    const technicalError = new Error('technical failure');
    let stackReads = 0;
    Object.defineProperty(technicalError, 'stack', {
        get() {
            stackReads += 1;
            if (stackReads > 1) {
                throw new Error('stack was read twice');
            }
            return 'Error: technical failure\n    at generation.js:10:20';
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        isCanNotBeHidden: () => {
            throw technicalError;
        },
    }));

    const state = await workflow.start();

    assert.equal(stackReads, 1);
    assert.equal(state.error.technicalException.stack, 'Error: technical failure\n    at generation.js:10:20');
    assert.deepEqual(await workflow.getState(), state);
});

test('start converts non-cloneable Error and cause metadata to strings or null', async () => {
    const cause = new Error('cause');
    cause.name = {toString: () => 'ObjectCause'};
    cause.message = 42;
    cause.stack = () => 'not a stack string';
    const technicalError = new Error('outer');
    technicalError.name = Symbol('OuterProblem');
    technicalError.message = {toString: () => 'Object message'};
    technicalError.stack = {frames: ['not cloneable']};
    technicalError.cause = cause;
    const workflow = createOrganizerWorkflow(workflowDependencies({
        isCanNotBeHidden: () => {
            throw technicalError;
        },
    }));

    const state = await workflow.start();

    assert.deepEqual(state.error.technicalException, {
        name: 'Symbol(OuterProblem)',
        message: 'Object message',
        stack: null,
        cause: {
            name: 'ObjectCause',
            message: '42',
            stack: null,
        },
    });
    assert.deepEqual(await workflow.getState(), state);
});

test('start safely serializes a hostile Proxy thrown by fetch as an immediate cause', async () => {
    const hostileCause = new Proxy({
        toString: () => 'hostile transport failure',
    }, {
        getPrototypeOf() {
            throw new Error('prototype access denied');
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => {
            throw hostileCause;
        },
    }));

    const state = await workflow.start();

    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'network-error',
        message: 'The organizer service could not be reached.',
        status: null,
        stage: 'plan',
    });
    assert.equal(technicalException.name, 'OrganizerClientError');
    assert.equal(technicalException.message, 'The organizer service could not be reached.');
    assert.deepEqual(technicalException.cause, {
        name: 'NonError',
        message: 'hostile transport failure',
        stack: null,
    });
    assert.deepEqual(await workflow.getState(), state);
});

test('start safely classifies a directly thrown hostile Proxy', async () => {
    const hostileError = new Proxy({
        toString: () => 'hostile settings failure',
    }, {
        getPrototypeOf() {
            throw new Error('prototype access denied');
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getOptions: async () => {
            throw hostileError;
        },
    }));

    const state = await workflow.start();

    assert.deepEqual(state.error, {
        code: 'settings-load-failed',
        message: 'The organizer settings could not be loaded.',
        status: null,
        stage: 'settings',
        technicalException: {
            name: 'NonError',
            message: 'hostile settings failure',
            stack: null,
            cause: null,
        },
    });
    assert.deepEqual(await workflow.getState(), state);
});

test('start falls back to the stage diagnostic when proxied client serialization throws', async () => {
    const clientError = new OrganizerClientError('http-error', {status: 503});
    const hostileClientError = new Proxy(clientError, {
        get(target, property, receiver) {
            if (property === 'toJSON') {
                throw new Error('toJSON access denied');
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getOptions: async () => {
            throw hostileClientError;
        },
    }));

    const state = await workflow.start();

    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'settings-load-failed',
        message: 'The organizer settings could not be loaded.',
        status: null,
        stage: 'settings',
    });
    assert.equal(technicalException.name, 'OrganizerClientError');
    assert.equal(technicalException.message, 'The organizer service returned an HTTP error.');
    assert.deepEqual(await workflow.getState(), state);
});

test('start falls back to the stage diagnostic when a proxied snapshot code getter throws', async () => {
    const snapshotError = new OrganizerSnapshotError('too-many-eligible-tabs');
    const hostileSnapshotError = new Proxy(snapshotError, {
        get(target, property, receiver) {
            if (property === 'code') {
                throw new Error('code access denied');
            }
            return Reflect.get(target, property, receiver);
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        isCanNotBeHidden: () => {
            throw hostileSnapshotError;
        },
    }));

    const state = await workflow.start();

    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'snapshot-preparation-failed',
        message: 'The organizer could not prepare the selected tabs.',
        status: null,
        stage: 'snapshot',
    });
    assert.equal(technicalException.name, 'OrganizerSnapshotError');
    assert.equal(technicalException.message, 'too-many-eligible-tabs');
    assert.deepEqual(await workflow.getState(), state);
});

test('start reports a smaller-scope diagnostic for more than 2024 eligible tabs', async () => {
    const tooManyTabs = Array.from({length: 2025}, (_, index) => ({
        id: index + 1,
        windowId: 7,
        title: `Private tab ${index + 1}`,
        url: `https://private.example/${index + 1}`,
        active: index === 0,
        pinned: false,
        audible: false,
        discarded: false,
    }));
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getTabs: async () => tooManyTabs,
    }));

    const state = await workflow.start({scope: 'all'});

    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'too-many-eligible-tabs',
        message: 'The organizer can organize at most 500 eligible tabs at once. Choose a smaller scope and try again.',
        status: null,
        stage: 'snapshot',
    });
    assert.equal(technicalException.name, 'OrganizerSnapshotError');
});

test('start identifies settings and tab acquisition failures by stage', async () => {
    const settingsWorkflow = createOrganizerWorkflow(workflowDependencies({
        getOptions: async () => {
            throw new Error('private-secret settings failure');
        },
    }));
    const tabsWorkflow = createOrganizerWorkflow(workflowDependencies({
        getTabs: async () => {
            throw new Error('https://private.example/tab failure');
        },
    }));

    const {technicalException: settingsException, ...settingsDiagnostic} = (await settingsWorkflow.start()).error;
    const {technicalException: tabsException, ...tabsDiagnostic} = (await tabsWorkflow.start()).error;
    assert.deepEqual(settingsDiagnostic, {
        code: 'settings-load-failed',
        message: 'The organizer settings could not be loaded.',
        status: null,
        stage: 'settings',
    });
    assert.deepEqual(tabsDiagnostic, {
        code: 'tab-read-failed',
        message: 'The organizer could not read the tabs to organize.',
        status: null,
        stage: 'tabs',
    });
    assert.equal(settingsException.message, 'private-secret settings failure');
    assert.equal(tabsException.message, 'https://private.example/tab failure');
});

test('start gives generic snapshot and draft failures distinct safe diagnostics', async () => {
    const secret = 'private-secret https://private.example/hidden';
    const snapshotWorkflow = createOrganizerWorkflow(workflowDependencies({
        isCanNotBeHidden: () => {
            throw new Error(secret);
        },
    }));
    const draftWorkflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            async json() {
                const plan = planFor('request-1');
                let planIdReads = 0;
                Object.defineProperty(plan, 'planId', {
                    enumerable: true,
                    get() {
                        planIdReads += 1;
                        if (planIdReads > 1) {
                            throw new Error(secret);
                        }
                        return 'plan-1';
                    },
                });
                return plan;
            },
        }),
    }));

    const {technicalException: snapshotException, ...snapshotDiagnostic} = (await snapshotWorkflow.start()).error;
    const {technicalException: draftException, ...draftDiagnostic} = (await draftWorkflow.start()).error;
    assert.deepEqual(snapshotDiagnostic, {
        code: 'snapshot-preparation-failed',
        message: 'The organizer could not prepare the selected tabs.',
        status: null,
        stage: 'snapshot',
    });
    assert.deepEqual(draftDiagnostic, {
        code: 'draft-creation-failed',
        message: 'The organizer could not create an editable draft.',
        status: null,
        stage: 'draft',
    });
    assert.equal(snapshotException.message, secret);
    assert.equal(draftException.message, secret);
});

test('a rejected generation reporter cannot change the safe failure result', async () => {
    const reported = [];
    const workflow = createOrganizerWorkflow(workflowDependencies({
        fetchImpl: async () => {
            throw new Error('private-secret https://private.example/hidden');
        },
        reportGenerationFailure: async diagnostic => {
            reported.push(diagnostic);
            throw new Error('reporter failed');
        },
    }));

    const state = await workflow.start();

    assert.deepEqual(reported, [state.error]);
    const {technicalException, ...diagnostic} = state.error;
    assert.deepEqual(diagnostic, {
        code: 'network-error',
        message: 'The organizer service could not be reached.',
        status: null,
        stage: 'plan',
    });
    assert.equal(technicalException.cause.message, 'private-secret https://private.example/hidden');
    assert.equal(state.snapshot, null);
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

test('an older generation completion cannot overwrite a newer start', async () => {
    const requests = [];
    let requestNumber = 0;
    const workflow = createOrganizerWorkflow(workflowDependencies({
        createRequestId: () => `request-${++requestNumber}`,
        fetchImpl: async (_url, init) => {
            const pending = deferred();
            requests.push({requestId: JSON.parse(init.body).requestId, pending});
            return pending.promise;
        },
    }));

    const olderStart = workflow.start({scope: 'all'});
    while (requests.length < 1) await new Promise(resolve => setImmediate(resolve));
    const newerStart = workflow.start({scope: 'ungrouped-current-window'});
    while (requests.length < 2) await new Promise(resolve => setImmediate(resolve));

    requests[1].pending.resolve(jsonResponse(planFor('request-2', 'plan-2')));
    const newerState = await newerStart;
    requests[0].pending.resolve(jsonResponse(planFor('request-1', 'plan-1')));
    const olderResult = await olderStart;

    assert.equal(newerState.snapshot.requestId, 'request-2');
    assert.equal(olderResult.snapshot.requestId, 'request-2');
    assert.equal((await workflow.getState()).snapshot.requestId, 'request-2');
});

test('a newer start wins even when its options load finishes first', async () => {
    const optionRequests = [];
    let requestNumber = 0;
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getOptions: () => {
            const pending = deferred();
            optionRequests.push(pending);
            return pending.promise;
        },
        createRequestId: () => `request-${++requestNumber}`,
        fetchImpl: async (_url, init) => {
            const {requestId} = JSON.parse(init.body);
            return jsonResponse(planFor(requestId, `plan-${requestId}`));
        },
    }));

    const olderStart = workflow.start({scope: 'all'});
    while (optionRequests.length < 1) await new Promise(resolve => setImmediate(resolve));
    const newerStart = workflow.start({scope: 'ungrouped-current-window'});
    while (optionRequests.length < 2) await new Promise(resolve => setImmediate(resolve));

    optionRequests[1].resolve({
        organizerServiceUrl: 'http://127.0.0.1:5050',
        organizerMinimumGroupSize: 5,
        organizerDefaultScope: 'ungrouped-current-window',
    });
    const newerState = await newerStart;
    optionRequests[0].resolve({
        organizerServiceUrl: 'http://127.0.0.1:5050',
        organizerMinimumGroupSize: 5,
        organizerDefaultScope: 'ungrouped-current-window',
    });
    const olderResult = await olderStart;

    assert.equal(newerState.snapshot.requestId, 'request-1');
    assert.equal(olderResult.snapshot.requestId, 'request-1');
    assert.equal((await workflow.getState()).snapshot.requestId, 'request-1');
});

test('concurrent apply calls execute a persisted draft only once', async () => {
    const firstMoveStarted = deferred();
    const releaseFirstMove = deferred();
    let addCalls = 0;
    let moveCalls = 0;
    const membership = new Map(tabs.map(tab => [tab.id, null]));
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getGroupId: tabId => membership.get(tabId),
        addGroup: async () => ({id: `created-${++addCalls}`}),
        moveTabs: async ([tabId], groupId) => {
            moveCalls += 1;
            if (moveCalls > 1 && !membership.has(1)) {
                assert.fail('a duplicate apply reached tab mutation');
            }
            if (moveCalls === 1) {
                firstMoveStarted.resolve();
                await releaseFirstMove.promise;
            }
            membership.set(tabId, groupId);
            return [{id: tabId}];
        },
    }));
    await workflow.start();

    const firstApply = workflow.apply();
    await firstMoveStarted.promise;
    const duplicateResult = await workflow.apply();

    assert.deepEqual(duplicateResult, {
        success: false,
        preflight: null,
        createdGroups: [],
        failure: {
            stage: 'concurrency',
            code: 'apply-in-progress',
            message: 'This organizer draft is already being applied.',
        },
        rolledBack: false,
        rollbackFailures: [],
        retainedGroups: [],
    });
    assert.equal(addCalls, 1);

    releaseFirstMove.resolve();
    const firstResult = await firstApply;
    assert.equal(firstResult.success, true);
    assert.equal(addCalls, 1);
});

test('a failed apply completion write releases its persisted operation for safe recovery', async () => {
    const storage = createSessionStorage();
    let writes = 0;
    const storageArea = {
        get: key => storage.get(key),
        remove: key => storage.remove(key),
        async set(values) {
            writes += 1;
            if (writes === 5) {
                throw new Error('session write interrupted');
            }
            return storage.set(values);
        },
    };
    const membership = new Map(tabs.map(tab => [tab.id, null]));
    const workflow = createOrganizerWorkflow(workflowDependencies({
        storageArea,
        getGroupId: tabId => membership.get(tabId),
        addGroup: async () => ({id: 'created-1'}),
        moveTabs: async ([tabId], groupId) => {
            membership.set(tabId, groupId);
            return [{id: tabId}];
        },
    }));
    await workflow.start();

    await assert.rejects(workflow.apply(), /session write interrupted/);
    const recovered = await workflow.getState();

    assert.equal(recovered.phase, 'apply');
    assert.equal(recovered.status, 'error');
    assert.equal(recovered.error.code, 'apply-interrupted');
    assert.notEqual(recovered.draft, null);
});

test('an orphaned persisted apply requires recovery instead of applying the draft again', async () => {
    const storageArea = createSessionStorage();
    const firstWorkflow = createOrganizerWorkflow(workflowDependencies({storageArea}));
    const ready = await firstWorkflow.start();
    await storageArea.set({
        [DRAFT_STATE_STORAGE_KEY]: {
            ...ready,
            phase: 'apply',
            status: 'pending',
            operation: {kind: 'apply', token: 'orphaned-apply'},
        },
    });
    const restartedWorkflow = createOrganizerWorkflow(workflowDependencies({
        storageArea,
        addGroup: async () => assert.fail('an interrupted apply must not run again automatically'),
        moveTabs: async () => assert.fail('an interrupted apply must not run again automatically'),
    }));

    const result = await restartedWorkflow.apply();
    const recovered = await restartedWorkflow.getState();

    assert.equal(result.success, false);
    assert.deepEqual(result.failure, {
        stage: 'concurrency',
        code: 'apply-recovery-required',
        message: 'A previous organizer apply was interrupted. Review the current tab groups before retrying.',
    });
    assert.equal(recovered.status, 'error');
    assert.deepEqual(recovered.applyResult, result);
    assert.notEqual(recovered.draft, null);
});

test('interrupted generation recovery clears a legacy private snapshot', async () => {
    const storageArea = createSessionStorage();
    const secretTitle = 'Private recovery title';
    const secretUrl = 'https://private.example/recovery';
    await storageArea.set({
        [DRAFT_STATE_STORAGE_KEY]: {
            phase: 'generate',
            status: 'pending',
            params: {
                scope: 'all',
                minimumGroupSize: 5,
                selectedTabIds: [],
            },
            snapshot: {
                tabs: [{tabId: 1, title: secretTitle, url: secretUrl}],
                request: {tabs: [{tabId: 1, title: secretTitle, url: secretUrl}]},
            },
            plan: {planId: 'private-plan'},
            draft: {summary: secretTitle},
            operation: {kind: 'generate', token: 'orphaned-generation'},
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({storageArea}));

    const recovered = await workflow.getState();

    assert.equal(recovered.snapshot, null);
    assert.equal(recovered.plan, null);
    assert.equal(recovered.draft, null);
    assert.doesNotMatch(JSON.stringify(recovered), /Private recovery title|private\.example\/recovery|private-plan/);
});

test('successful apply returns exact details but persists only a redacted success summary', async () => {
    const events = [];
    const membership = new Map(tabs.map(tab => [tab.id, null]));
    const dependencies = workflowDependencies({
        getGroupId: tabId => membership.get(tabId),
        addGroup: async (_windowId, _tabIds, name) => {
            events.push(['add', name]);
            return {id: 'created-1'};
        },
        moveTabs: async (tabIds, groupId) => {
            events.push(['move', [...tabIds], groupId]);
            tabIds.forEach(tabId => membership.set(tabId, groupId));
            return tabIds.map(id => ({id}));
        },
        restoreTabs: async () => assert.fail('rollback should not run'),
        removeGroup: async () => assert.fail('rollback should not run'),
        runOperation: async (name, operation) => {
            events.push(['run', name]);
            return operation();
        },
    });
    const workflow = createOrganizerWorkflow(dependencies);
    const generated = await workflow.start();
    await workflow.saveDraft({
        ...generated.draft,
        groups: generated.draft.groups.map(group => ({...group, name: 'Persisted name'})),
    });

    const result = await workflow.apply({groups: [{name: 'Untrusted argument'}]});
    const stored = await workflow.getState();

    assert.equal(result.success, true);
    assert.deepEqual(events, [
        ['run', 'apply-grouping-plan'],
        ['add', 'Persisted name'],
        ['move', [1], 'created-1'],
        ['move', [2], 'created-1'],
        ['move', [3], 'created-1'],
        ['move', [4], 'created-1'],
        ['move', [5], 'created-1'],
    ]);
    assert.equal(stored.phase, 'apply');
    assert.equal(stored.status, 'complete');
    assert.equal(result.createdGroups[0].name, 'Persisted name');
    assert.deepEqual(stored, {
        phase: 'apply',
        status: 'complete',
        applyResult: {
            success: true,
            createdGroups: [{groupId: 'created-1', tabCount: 5}],
        },
    });
    assert.equal(Object.hasOwn(stored, 'snapshot'), false);
    assert.equal(Object.hasOwn(stored, 'plan'), false);
    assert.equal(Object.hasOwn(stored, 'draft'), false);
    assert.equal(Object.hasOwn(stored, 'params'), false);
    assert.doesNotMatch(JSON.stringify(stored), /Tab 1|example\.test|Persisted name|Shared task|One useful group/);
});

test('apply persists safe failure state when coordinator boundaries reject', async t => {
    const cases = [
        {
            name: 'live tab query',
            dependencies() {
                let rejectQuery = false;
                return {
                    overrides: {
                        getTabs: async () => {
                            if (rejectQuery) throw new Error('secret live query details');
                            return tabs;
                        },
                    },
                    afterStart() {
                        rejectQuery = true;
                    },
                };
            },
        },
        {
            name: 'preflight membership lookup',
            dependencies() {
                let rejectMembership = false;
                return {
                    overrides: {
                        getGroupId(tabId) {
                            if (rejectMembership) throw new Error(`secret membership for ${tabId}`);
                            return null;
                        },
                    },
                    afterStart() {
                        rejectMembership = true;
                    },
                };
            },
        },
        {
            name: 'persisted draft validation',
            dependencies(storageArea) {
                return {
                    overrides: {},
                    async afterStart() {
                        const {[DRAFT_STATE_STORAGE_KEY]: state} = await storageArea.get(DRAFT_STATE_STORAGE_KEY);
                        state.draft.groups[0].name = '';
                        await storageArea.set({[DRAFT_STATE_STORAGE_KEY]: state});
                    },
                };
            },
        },
        {
            name: 'operation wrapper',
            dependencies() {
                return {
                    overrides: {
                        runOperation: async () => {
                            throw new Error('secret operation wrapper details');
                        },
                    },
                    afterStart() {},
                };
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const storageArea = createSessionStorage();
            const setup = item.dependencies(storageArea);
            const workflow = createOrganizerWorkflow(workflowDependencies({
                storageArea,
                addGroup: async () => ({id: 'created-1'}),
                moveTabs: async ([id]) => [{id}],
                removeGroup: async () => assert.fail('rollback deletion is forbidden'),
                ...setup.overrides,
            }));
            await workflow.start();
            await setup.afterStart();

            const result = await workflow.apply();
            const stored = await workflow.getState();

            assert.deepEqual(result, {
                success: false,
                preflight: null,
                createdGroups: [],
                failure: {
                    stage: 'workflow',
                    message: 'The organizer plan could not be applied.',
                },
                rolledBack: false,
                rollbackFailures: [],
                retainedGroups: [],
            });
            assert.equal(stored.phase, 'apply');
            assert.equal(stored.status, 'error');
            assert.notEqual(stored.draft, null);
            assert.deepEqual(stored.error, {
                code: 'apply-error',
                message: 'The organizer plan could not be applied.',
                status: null,
            });
            assert.doesNotMatch(JSON.stringify({result, error: stored.error}), /secret/i);
        });
    }
});

test('apply persists uncertain group creation when add and its follow-up snapshot reject', async () => {
    let groupSnapshot = 0;
    const trackedAddGroup = createTrackedAddGroupOperation({
        getGroups: async () => {
            if (++groupSnapshot === 1) return [];
            throw new Error('secret group storage failure');
        },
        addGroup: async () => {
            throw new Error('secret post-persist menu failure');
        },
    });
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getGroupId: () => null,
        addGroup: trackedAddGroup,
        moveTabs: async () => assert.fail('move must not follow a rejected add'),
        removeGroup: async () => assert.fail('rollback deletion is forbidden'),
    }));
    await workflow.start();

    const result = await workflow.apply();
    const stored = await workflow.getState();

    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false);
    assert.equal(result.failure.stage, 'add-group');
    assert.equal(result.failure.groupCreationUncertain, true);
    assert.deepEqual(result.failure.retainedGroupIds, []);
    assert.deepEqual(result.retainedGroups, []);
    assert.equal(stored.phase, 'apply');
    assert.equal(stored.status, 'error');
    assert.notEqual(stored.draft, null);
    assert.deepEqual(stored.applyResult, result);
    assert.doesNotMatch(JSON.stringify(result), /secret/i);
});

test('preflight failure keeps the draft and saving stale-tab removals returns to review', async () => {
    let tabQuery = 0;
    const workflow = createOrganizerWorkflow(workflowDependencies({
        getTabs: async () => ++tabQuery === 1 ? tabs : tabs.slice(1),
        addGroup: async () => assert.fail('preflight must run before mutation'),
        moveTabs: async () => assert.fail('preflight must run before mutation'),
        removeGroup: async () => assert.fail('preflight must run before mutation'),
    }));
    const generated = await workflow.start();

    const result = await workflow.apply();
    const stored = await workflow.getState();

    assert.equal(result.success, false);
    assert.equal(result.failure.stage, 'preflight');
    assert.equal(stored.phase, 'apply');
    assert.equal(stored.status, 'error');
    assert.deepEqual(stored.draft, generated.draft);
    assert.deepEqual(stored.applyResult, result);

    const recoveredDraft = {
        ...stored.draft,
        groups: stored.draft.groups.map(group => ({
            ...group,
            tabIds: group.tabIds.filter(tabId => tabId !== 1),
        })),
        unassignedTabIds: [...stored.draft.unassignedTabIds, 1],
    };
    const recovered = await workflow.saveDraft(recoveredDraft);

    assert.equal(recovered.phase, 'review');
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.error, null);
    assert.equal(recovered.applyResult, null);
    assert.deepEqual(recovered.draft.groups[0].tabIds, [2, 3, 4, 5]);
});

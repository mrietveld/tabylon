import assert from 'node:assert/strict';
import test from 'node:test';

import {
    checkService,
    generateGroupingPlan,
} from '../src/js/organizer/client.js';

const snapshot = {
    requestId: 'request-42',
    capturedAt: '2026-09-18T12:00:00.000Z',
    scope: 'ungrouped-current-window',
    request: {
        minimumGroupSize: 2,
        scope: 'ungrouped-current-window',
        tabs: [
            {tabId: 10, title: 'Mail', url: 'https://mail.example.test/'},
            {tabId: 11, title: 'Calendar', url: 'https://calendar.example.test/'},
        ],
    },
    tabs: [
        {
            tabId: 10,
            windowId: 7,
            title: 'Mail',
            url: 'https://mail.example.test/',
            active: true,
            pinned: false,
            audible: false,
            discarded: false,
            groupId: null,
        },
        {
            tabId: 11,
            windowId: 7,
            title: 'Calendar',
            url: 'https://calendar.example.test/',
            active: false,
            pinned: false,
            audible: true,
            discarded: true,
            groupId: null,
        },
    ],
};

const validPlan = {
    planId: 'plan-42',
    requestId: 'request-42',
    summary: 'Communication',
    groups: [{
        groupId: 'group-1',
        name: 'Communication',
        reason: 'Mail and planning',
        tabIds: [10, 11],
    }],
    ungroupedTabIds: [],
    warnings: [],
};

function response(body, {ok = true, status = 200} = {}) {
    return {
        ok,
        status,
        async json() {
            return structuredClone(body);
        },
    };
}

test('checkService rejects non-HTTP service URLs before making a request', async () => {
    let calls = 0;

    await assert.rejects(
        checkService('file:///tmp/organizer', {
            fetchImpl: async () => {
                calls += 1;
                return response({status: 'ok', service: 'tab-organizer-backend'});
            },
        }),
        error => {
            assert.equal(error.code, 'invalid-service-url');
            assert.equal(error.status, null);
            assert.equal(error.message, 'The organizer service URL must use HTTP or HTTPS.');
            return true;
        },
    );
    assert.equal(calls, 0);
});

test('checkService accepts only the expected backend health identity', async () => {
    await assert.rejects(
        checkService('https://organizer.example.test/base/', {
            fetchImpl: async () => response({status: 'ok', service: 'another-service'}),
        }),
        error => {
            assert.equal(error.code, 'invalid-health-response');
            assert.equal(error.message, 'The organizer service returned an unexpected health response.');
            return true;
        },
    );
});

test('checkService requests the root health endpoint', async () => {
    let capturedUrl;
    let capturedInit;

    const health = await checkService('https://organizer.example.test/configured/path', {
        fetchImpl: async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return response({status: 'ok', service: 'tab-organizer-backend'});
        },
    });

    assert.deepEqual(health, {status: 'ok', service: 'tab-organizer-backend'});
    assert.equal(capturedUrl, 'https://organizer.example.test/health');
    assert.deepEqual(capturedInit, {method: 'GET'});
});

test('checkService returns a safe network failure without exposing transport details', async () => {
    await assert.rejects(
        checkService('http://127.0.0.1:5050', {
            fetchImpl: async () => {
                throw new Error('connect ECONNREFUSED http://secret.internal/health');
            },
        }),
        error => {
            assert.deepEqual(error.toJSON(), {
                code: 'network-error',
                message: 'The organizer service could not be reached.',
                status: null,
            });
            return true;
        },
    );
});

test('generateGroupingPlan reports HTTP failures without including the response body', async () => {
    await assert.rejects(
        generateGroupingPlan('http://127.0.0.1:5050', snapshot, {
            fetchImpl: async () => response({detail: 'private upstream trace'}, {ok: false, status: 503}),
        }),
        error => {
            assert.deepEqual(error.toJSON(), {
                code: 'http-error',
                message: 'The organizer service returned an HTTP error.',
                status: 503,
            });
            assert.doesNotMatch(error.message, /private upstream trace/);
            return true;
        },
    );
});

test('generateGroupingPlan reports malformed JSON with a safe error', async () => {
    await assert.rejects(
        generateGroupingPlan('http://127.0.0.1:5050', snapshot, {
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                async json() {
                    throw new SyntaxError('Unexpected token containing private response data');
                },
            }),
        }),
        error => {
            assert.equal(error.code, 'malformed-json');
            assert.equal(error.message, 'The organizer service returned malformed JSON.');
            return true;
        },
    );
});

test('generateGroupingPlan rejects a response that does not validate against the snapshot', async () => {
    await assert.rejects(
        generateGroupingPlan('http://127.0.0.1:5050', snapshot, {
            fetchImpl: async () => response({...validPlan, requestId: 'another-request'}),
        }),
        error => {
            assert.equal(error.code, 'invalid-plan-response');
            assert.equal(error.message, 'The organizer service returned an invalid grouping plan.');
            return true;
        },
    );
});

test('generateGroupingPlan sends the established wire payload and returns the validated plan', async () => {
    let capturedUrl;
    let capturedInit;
    const result = await generateGroupingPlan('https://organizer.example.test/root/', snapshot, {
        fetchImpl: async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return response(validPlan);
        },
    });

    assert.deepEqual(result, validPlan);
    assert.equal(capturedUrl, 'https://organizer.example.test/api/groupings/generate');
    assert.equal(capturedInit.method, 'POST');
    assert.deepEqual(capturedInit.headers, {'content-type': 'application/json'});
    assert.deepEqual(JSON.parse(capturedInit.body), {
        requestId: 'request-42',
        capturedAt: '2026-09-18T12:00:00.000Z',
        constraints: {
            minimumGroupSize: 2,
            groupingBasis: 'common theme or task',
        },
        tabs: [
            {
                tabId: 10,
                windowId: 7,
                title: 'Mail',
                url: 'https://mail.example.test/',
                active: true,
                pinned: false,
                audible: false,
                discarded: false,
            },
            {
                tabId: 11,
                windowId: 7,
                title: 'Calendar',
                url: 'https://calendar.example.test/',
                active: false,
                pinned: false,
                audible: true,
                discarded: true,
            },
        ],
    });
});

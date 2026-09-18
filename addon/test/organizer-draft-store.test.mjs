import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearDraftState,
    getDraftState,
    setDraftState,
} from '../src/js/organizer/draft-store.js';

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

test('getDraftState returns null before any organizer workflow state is saved', async () => {
    assert.equal(await getDraftState(createSessionStorage()), null);
});

test('setDraftState persists and returns an organizer workflow state through injected session storage', async () => {
    const storage = createSessionStorage();
    const state = {
        snapshot: {requestId: 'request-99', tabs: [{tabId: 99}]},
        draft: {planId: 'plan-99', groups: []},
    };

    assert.deepEqual(await setDraftState(state, storage), state);
    assert.deepEqual(await getDraftState(storage), state);
});

test('clearDraftState removes the active workflow state from session storage', async () => {
    const storage = createSessionStorage();
    await setDraftState({snapshot: {requestId: 'request-7'}}, storage);

    await clearDraftState(storage);

    assert.equal(await getDraftState(storage), null);
});

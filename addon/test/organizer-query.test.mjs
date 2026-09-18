import assert from 'node:assert/strict';
import test from 'node:test';

import {parseOrganizerQuery} from '../src/organize/query.js';

test('query accepts repeated and comma-separated tab IDs and selects that scope', () => {
    assert.deepEqual(parseOrganizerQuery('?scope=all&tabId=12,34&tabId=56&tabId=34'), {
        scope: 'selected',
        selectedTabIds: [12, 34, 56],
    });
});

test('query ignores malformed tab IDs while preserving valid IDs', () => {
    assert.deepEqual(parseOrganizerQuery('?tabId=-1,2.5,nope&tabId=0&tabId=9007199254740992&tabId=7'), {
        scope: 'selected',
        selectedTabIds: [0, 7],
    });
});

test('query accepts a valid non-selected scope when no selected tab IDs exist', () => {
    assert.deepEqual(parseOrganizerQuery('?scope=current-group&tabId=invalid'), {
        scope: 'current-group',
        selectedTabIds: [],
    });
});

test('query falls back to the workflow default scope for unsupported or unusable selected scopes', () => {
    assert.deepEqual(parseOrganizerQuery('?scope=selected'), {
        scope: 'ungrouped-current-window',
        selectedTabIds: [],
    });
    assert.deepEqual(parseOrganizerQuery('?scope=unknown'), {
        scope: 'ungrouped-current-window',
        selectedTabIds: [],
    });
});

test('query uses a configured fallback scope when no usable scope is supplied', () => {
    assert.deepEqual(parseOrganizerQuery('', 'all'), {
        scope: 'all',
        selectedTabIds: [],
    });
    assert.deepEqual(parseOrganizerQuery('?scope=selected', 'current-group'), {
        scope: 'current-group',
        selectedTabIds: [],
    });
});

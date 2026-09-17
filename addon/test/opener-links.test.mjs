import assert from 'node:assert/strict';
import test from 'node:test';

import {collectSavedOpenerLinks} from '../src/js/opener-links.js';

test('collects valid same-window saved opener links', () => {
    const saved = [{}, {openerOffset: -1}];
    const aligned = [{id: 1, windowId: 10}, {id: 2, windowId: 10}];

    assert.deepEqual(collectSavedOpenerLinks(saved, aligned), [[2, 1]]);
});

test('skips missing, self, and cross-window saved opener links', () => {
    assert.deepEqual(collectSavedOpenerLinks([{openerOffset: -1}], [{id: 1, windowId: 10}]), []);
    assert.deepEqual(collectSavedOpenerLinks([{openerOffset: -1}, {openerOffset: -1}], [{id: 1, windowId: 10}, {id: 1, windowId: 10}]), []);
    assert.deepEqual(collectSavedOpenerLinks([{openerOffset: -1}, {openerOffset: -1}], [{id: 1, windowId: 10}, {id: 2, windowId: 11}]), []);
});

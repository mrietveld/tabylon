import assert from 'node:assert/strict';
import test from 'node:test';

import {isTreeStyleTabEnabled} from '../src/js/tree-style-tab.js';

test('reports enabled when either fixed Tree Style Tab ID is enabled', async () => {
    const get = async id => ({enabled: id === 'treestyletab@piro.sakura.ne.jp'});

    assert.equal(await isTreeStyleTabEnabled({get}), true);
});

test('fails closed for disabled, missing, rejected, and malformed lookups', async () => {
    assert.equal(await isTreeStyleTabEnabled({get: async () => ({enabled: false})}), false);
    assert.equal(await isTreeStyleTabEnabled({get: async () => { throw new Error('missing'); }}), false);
    assert.equal(await isTreeStyleTabEnabled({get: async () => null}), false);
});

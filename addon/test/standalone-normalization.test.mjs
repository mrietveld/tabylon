import assert from 'node:assert/strict';
import test from 'node:test';

import {normalizeStandaloneOptions} from '../src/js/standalone-normalization.js';

test('normalizes legacy cloud and host backup data without changing local groups', () => {
    const data = {
        autoBackupLocation: 'host',
        autoBackupFilePath: 'STG-backups/{date}',
        syncEnable: true,
        githubGistToken: 'secret',
        defaultGroupProps: {uploadToCloud: true, title: 'New group'},
        groups: [
            {id: 'stub', uploadToCloud: false},
            {id: 'group', uploadToCloud: true, tabs: [{url: 'https://example.test'}]},
        ],
    };

    assert.equal(normalizeStandaloneOptions(data), true);
    assert.equal(data.autoBackupLocation, 'downloads');
    assert.equal(data.autoBackupFilePath, 'STG-backups/{date}');
    assert.equal('syncEnable' in data, false);
    assert.equal('githubGistToken' in data, false);
    assert.equal('uploadToCloud' in data.defaultGroupProps, false);
    assert.deepEqual(data.groups, [{id: 'group', tabs: [{url: 'https://example.test'}]}]);
});

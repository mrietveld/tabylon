import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createOrganizerPageUrl,
    normalizeOrganizerDefaultScope,
    normalizeOrganizerMinimumGroupSize,
    normalizeOrganizerServiceUrl,
} from '../src/js/organizer/settings.js';

test('createOrganizerPageUrl supplies selected scope only for safe tab IDs', () => {
    const pageUrl = 'moz-extension://stg/organize/organize.html';

    assert.equal(
        createOrganizerPageUrl(pageUrl, [12, 34]),
        'moz-extension://stg/organize/organize.html?scope=selected&tabId=12%2C34',
    );
    assert.equal(createOrganizerPageUrl(pageUrl, [-1, 2.5, '3']), pageUrl);
});

test('organizer option normalizers accept only usable values', () => {
    assert.equal(normalizeOrganizerMinimumGroupSize(2.5), 3);
    assert.equal(normalizeOrganizerMinimumGroupSize(1), 2);
    assert.equal(normalizeOrganizerMinimumGroupSize(501), 500);
    assert.equal(normalizeOrganizerMinimumGroupSize('invalid'), undefined);

    assert.equal(normalizeOrganizerServiceUrl(' https://organizer.example.test/api '), 'https://organizer.example.test/api');
    assert.equal(normalizeOrganizerServiceUrl('file:///tmp/organizer'), undefined);
    assert.equal(normalizeOrganizerServiceUrl('not a url'), undefined);

    assert.equal(normalizeOrganizerDefaultScope('all'), 'all');
    assert.equal(normalizeOrganizerDefaultScope('selected'), undefined);
});

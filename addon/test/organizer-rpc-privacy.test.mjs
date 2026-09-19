import assert from 'node:assert/strict';
import test from 'node:test';

import {redactRpcMessageForLogging} from '../src/js/rpc-privacy.js';

test('outer RPC logging redacts Organizer saveDraft payloads and breadcrumbs', () => {
    const message = {
        postId: 'post-1',
        data: {
            action: 'Organizer.saveDraft',
            args: [{
                snapshot: {
                    tabs: [{title: 'Secret project', url: 'https://private.example/secret'}],
                },
            }],
            breadcrumbs: {
                message: 'Secret project https://private.example/secret',
            },
        },
    };

    const logged = redactRpcMessageForLogging(message);

    assert.deepEqual(logged, {
        postId: 'post-1',
        data: {
            action: 'Organizer.saveDraft',
            args: '[redacted]',
            breadcrumbs: '[redacted]',
        },
    });
    assert.doesNotMatch(JSON.stringify(logged), /Secret project|private\.example|snapshot|title|url/);
});

test('outer RPC logging leaves non-Organizer messages available for diagnostics', () => {
    const message = {
        postId: 'post-2',
        data: {action: 'Groups.load', args: [7]},
    };

    assert.equal(redactRpcMessageForLogging(message), message);
});

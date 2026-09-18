import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const guardSource = resolve(testDirectory, '../scripts/check-standalone-core.mjs');

function createFixture(t, source) {
    const root = mkdtempSync(resolve(tmpdir(), 'stg-standalone-'));
    const script = resolve(root, 'addon/scripts/check-standalone-core.mjs');
    mkdirSync(dirname(script), {recursive: true});
    mkdirSync(resolve(root, 'addon/src'), {recursive: true});
    copyFileSync(guardSource, script);
    writeFileSync(resolve(root, 'addon/src/fixture.js'), source);
    t.after(() => rmSync(root, {recursive: true, force: true}));
    return {root, script};
}

function runGuard(script) {
    return spawnSync(process.execPath, [script], {encoding: 'utf8'});
}

test('rejects the retired organizer extension ID', t => {
    const {script} = createFixture(t, "const retiredId = 'tab-organizer@example.local';\n");
    const result = runGuard(script);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tab-organizer@example\.local/);
});

test('rejects cross-extension runtime sends and connections', t => {
    const {script} = createFixture(t, [
        "browser.runtime.sendMessage('other-extension@example.test', {action: 'organize'});",
        "browser.runtime.connect('other-extension@example.test', {name: 'organize'});",
    ].join('\n'));
    const result = runGuard(script);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cross-extension runtime sendMessage/);
    assert.match(result.stderr, /cross-extension runtime connect/);
});

test('allows internal Organizer messages and runtime sends', t => {
    const {script} = createFixture(t, [
        "const action = 'Organizer.start';",
        'browser.runtime.sendMessage({action});',
        "browser.runtime.connect({name: 'Organizer'});",
    ].join('\n'));
    const result = runGuard(script);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Standalone-core checks passed/);
});

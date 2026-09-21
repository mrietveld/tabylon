import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source = path => readFile(new URL(path, import.meta.url), 'utf8');

test('popup opens Smart Organizer with its selected tab IDs', async () => {
    const [globalMixin, popup] = await Promise.all([
        source('../src/js/mixins/global.mixin.js'),
        source('../src/popup/Popup.vue'),
    ]);

    assert.match(globalMixin, /openOrganizer\(tabIds = \[\]\)[\s\S]*createOrganizerPageUrl\(Constants\.PAGES\.ORGANIZE, tabIds\)/);
    assert.match(popup, /@click="openOrganizer\(multipleTabIds\)"/);
});

test('options exposes persistent organizer settings with privacy copy', async () => {
    const [options, messages] = await Promise.all([
        source('../src/options/Options.vue'),
        source('../src/_locales/en/messages.json'),
    ]);
    const locale = JSON.parse(messages);

    assert.match(options, /const SECTION_ORGANIZER = 'organizer';/);
    assert.match(options, /\[SECTION_GENERAL, SECTION_HOTKEYS, SECTION_ORGANIZER, SECTION_BACKUP, SECTION_ABOUT\]/);
    assert.match(options, /v-model\.lazy\.trim="options\.organizerServiceUrl"/);
    assert.match(options, /v-model\.lazy\.number="options\.organizerMinimumGroupSize"/);
    assert.match(options, /type="number" class="input" min="2" max="500"/);
    assert.match(options, /optionsWatch\('organizerServiceUrl', normalizeOrganizerServiceUrl\)/);
    assert.match(options, /optionsWatch\('organizerMinimumGroupSize', normalizeOrganizerMinimumGroupSize\)/);
    assert.match(options, /optionsWatch\('organizerDefaultScope', normalizeOrganizerDefaultScope\)/);
    assert.match(options, /v-model="options\.organizerDefaultScope"/);
    assert.doesNotMatch(options, /<option value="selected"/);

    for (const key of [
        'organizerTitle',
        'organizerServiceUrl',
        'organizerMinimumGroupSize',
        'organizerDefaultScope',
        'organizerPrivacy',
        'organizerScopeUngroupedCurrentWindow',
        'organizerScopeCurrentGroup',
        'organizerScopeSelected',
        'organizerScopeAll',
    ]) {
        assert.ok(locale[key]?.message, `missing English ${key} message`);
    }
    assert.match(locale.organizerPrivacy.message, /tab titles and URLs.*configured service/i);
});

test('organizer error UI renders only structured generation diagnostics', async () => {
    const organize = await source('../src/organize/Organize.vue');

    assert.match(organize, /generationDiagnostic\(\)\s*\{/);
    assert.match(organize, /code: error\.code,[\s\S]*status: error\.status,[\s\S]*stage: error\.stage,/);
    assert.match(organize, /v-if="generationDiagnostic"[\s\S]*generationDiagnostic\.code[\s\S]*generationDiagnostic\.status[\s\S]*generationDiagnostic\.stage/);
    assert.doesNotMatch(organize, /error\.(?:cause|stack)/);
});

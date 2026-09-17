# Standalone Core Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a self-contained Simple Tab Groups add-on that preserves tab-group management, local download backup/restore, and Tree Style Tab opener restoration while removing plugins, external integrations, cloud sync, and native-host backup.

**Architecture:** Keep `addon/src/background.js` as the actual packaged composition root; it retains internal listener wiring, startup, and internal message dispatch, but no external protocol or integration routing. Extract only two small, cohesive seams: a dependency-injectable Tree Style Tab capability and a pure saved-opener-link collector. Core group/tab/window workflows remain in their existing modules; all automatic backup writes go through `File.saveBackup()` and the Downloads API.

**Tech Stack:** Firefox MV2 WebExtensions, ES modules, Vue 2, webpack 5, Node built-in `node:test`, ESLint.

## Global Constraints

- Preserve group creation, switching, moving, hiding, archiving, restoring, deleting, containers, windows, menus, commands, hotkeys, internal extension-page/content-script messaging, local JSON export/import, and automatic Downloads backups.
- Keep `addon/src/background.js`: `addon/src/manifest.json` and `addon/webpack.config.js` both package that exact file.
- Retain `management` only for checking the two fixed Tree Style Tab IDs with `browser.management.get`; do not enumerate, observe, identify, fetch metadata for, or communicate with arbitrary add-ons.
- Remove `plugins/`, `host/`, all external runtime messaging, all cloud/Gist/native-host code, Group Notes migration, conflict/integration UI, third-party importers, and their docs/locales.
- Existing `moz-extension:` URLs are opaque data: preserve them unchanged. Do not use extension inventory to convert UUIDs to add-on IDs or vice versa.
- Normalize persisted/imported obsolete cloud and host values without touching Group Notes storage or remote Gists.
- Do not add the pre-existing untracked `.pi-subagents/` or unrelated `docs/superpowers/plans/` artifacts to commits.

---

## File structure

| Path | Responsibility after this work |
| --- | --- |
| `addon/src/background.js` | Internal listeners, core action dispatch, startup, restore, and local automatic backup orchestration. |
| `addon/src/js/tree-style-tab.js` | Failure-safe enabled-state check for the two supported Tree Style Tab IDs only. |
| `addon/src/js/opener-links.js` | Pure conversion of saved opener offsets plus aligned tabs into valid same-window links. |
| `addon/src/js/tabs.js` | Creates/restores tabs; applies saved opener links only when the Tree Style Tab capability is enabled. |
| `addon/src/js/migrations-main.js` | Core format migration plus idempotent removal/normalization of obsolete host/cloud values; no external messaging. |
| `addon/scripts/check-standalone-core.mjs` | Source/package regression guard against removed paths and protocols. |
| `addon/test/*.test.mjs` | Dependency-free Node tests for Tree Style Tab detection, opener-link gating, and normalization helpers. |

### Task 1: Make validation executable before destructive changes

**Files:**
- Create: `addon/scripts/check-standalone-core.mjs`
- Create: `addon/test/tree-style-tab.test.mjs`
- Create: `addon/test/opener-links.test.mjs`
- Modify: `addon/package.json:7-11`
- Modify: `addon/scripts/build-zip.js:7,65`
- Test: `addon/scripts/check-standalone-core.mjs`, `addon/test/*.test.mjs`

**Interfaces:**
- `npm run test` runs Node’s built-in test runner without Firefox.
- `npm run check:standalone` fails for a prohibited path or source token and prints every violation.
- `npm run build-zip` imports the real `addon/webpack.config.js` and copies that real config into the development archive.

- [ ] **Step 1: Write the initially failing repository guard**

Create `addon/scripts/check-standalone-core.mjs`:

```js
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const forbiddenPaths = ['plugins', 'host'];
const forbiddenTokens = [
    'onMessageExternal', 'sendExternalMessage', 'EXTENSIONS_WHITE_LIST',
    'groups-external', 'mapForExternalExtension', 'githubGist',
    'sync-cloud', 'sendNativeMessage', 'nativeMessaging',
];
const scanRoots = ['addon/src', 'addon/webpack.config.js', 'addon/scripts/build-zip.js', 'README.md', 'translate/index.js'];
const failures = [];

function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) return readdirSync(path).flatMap(name => visit(resolve(path, name)));
    return [path];
}

for (const path of forbiddenPaths) {
    if (existsSync(resolve(root, path))) failures.push(`forbidden path: ${path}`);
}
for (const scanRoot of scanRoots) {
    const fullPath = resolve(root, scanRoot);
    for (const file of visit(fullPath)) {
        const text = readFileSync(file, 'utf8');
        for (const token of forbiddenTokens) {
            if (text.includes(token)) failures.push(`${relative(root, file)}: ${token}`);
        }
    }
}
if (failures.length) throw new Error(failures.join('\n'));
console.log('Standalone-core checks passed.');
```

Add scripts to `addon/package.json`:

```json
"test": "node --test test/*.test.mjs",
"check:standalone": "node scripts/check-standalone-core.mjs"
```

- [ ] **Step 2: Verify the guard is red**

Run: `cd addon && npm run check:standalone`

Expected: failure naming both `plugins` and `host`, plus existing external/cloud/native tokens.

- [ ] **Step 3: Repair the broken archive configuration**

In `addon/scripts/build-zip.js`, change both references to the non-existent config filename:

```js
import config from '../webpack.config.js';
// ...
await fse.copy(setPath('webpack.config.js'), setDevPath('webpack.config.js'));
```

- [ ] **Step 4: Add Node tests before their implementations**

Create tests that import the future pure modules and establish these expected contracts:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
```

In `opener-links.test.mjs`, assert that a saved child `{openerOffset: -1}` aligned with same-window tabs produces `[[2, 1]]`, while missing, self, and cross-window links produce `[]`.

- [ ] **Step 5: Verify tests are red for missing modules**

Run: `cd addon && npm test`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tree-style-tab.js` and `opener-links.js`.

- [ ] **Step 6: Commit the validation harness**

```bash
git add addon/package.json addon/scripts/build-zip.js addon/scripts/check-standalone-core.mjs addon/test
git commit -m "test: add standalone core regression harness"
```

### Task 2: Retain only Tree Style Tab detection and gate saved opener restoration

**Files:**
- Create: `addon/src/js/tree-style-tab.js`
- Create: `addon/src/js/opener-links.js`
- Modify: `addon/src/js/constants.js:213-216`
- Modify: `addon/src/js/tabs.js:22,874-886`
- Modify: `addon/src/js/groups.js:918`
- Modify: `addon/src/js/windows.js:389`
- Modify: `addon/src/js/migrations-main.js:369`
- Test: `addon/test/tree-style-tab.test.mjs`, `addon/test/opener-links.test.mjs`

**Interfaces:**
- `isTreeStyleTabEnabled(management = browser.management): Promise<boolean>` queries only fixed Tree Style Tab IDs and never throws.
- `collectSavedOpenerLinks(savedTabs, aligned): Array<[number, number]>` is pure.
- `Tabs.applyOpeners(savedTabs, aligned)` always preserves tab creation/alignment but writes saved opener links only if Tree Style Tab is enabled.

- [ ] **Step 1: Implement the two pure/narrow modules**

Create `tree-style-tab.js`:

```js
export const TREE_STYLE_TAB_IDS = Object.freeze([
    'treestyletab@piro.sakura.ne.jp',
    '{8d808887-ed13-4931-9f5a-4c0bff979a5a}',
]);

export async function isTreeStyleTabEnabled(management = browser.management) {
    try {
        const extensions = await Promise.all(TREE_STYLE_TAB_IDS.map(id => management.get(id)));
        return extensions.some(extension => extension?.enabled === true);
    } catch {
        return false;
    }
}
```

Create `opener-links.js`:

```js
export function collectSavedOpenerLinks(savedTabs, aligned) {
    const links = [];
    for (const [index, saved] of savedTabs.entries()) {
        const tab = aligned[index];
        const opener = aligned[index + saved?.openerOffset];
        if (saved?.openerOffset && opener && opener.id !== tab?.id && opener.windowId === tab?.windowId) {
            links.push([tab.id, opener.id]);
        }
    }
    return links;
}
```

Export the same two IDs from `constants.js` by importing/re-exporting them, or move the immutable literal there and pass it into the helper; do not duplicate IDs.

- [ ] **Step 2: Make the existing opener writer capability-gated**

Replace the body of `Tabs.applyOpeners` with this behavior while leaving `setOpeners` private and unchanged:

```js
export async function applyOpeners(savedTabs, aligned) {
    if (!await isTreeStyleTabEnabled()) return;
    await setOpeners(collectSavedOpenerLinks(savedTabs, aligned));
}
```

Import both helpers at the top of `tabs.js`. Do not gate `setOpeners` calls in `recreate()` or `moveNative()`; those preserve live browser relationships and are not saved-tab restoration.

- [ ] **Step 3: Characterize all restoration callers without changing their creation flows**

Keep the existing calls in `Groups.settleTabs`, `Windows.runGrandRestoreNow`, migration v6’s legacy-newtab repair, and `Tabs.reconcile`. Add comments at each call only if needed to state it is intentionally routed through the gated shared function. Do not add a second capability lookup at callers; each restore transaction reaches the common gate after sorting/hiding/alignment is complete.

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
cd addon
npm test
npm run build
```

Expected: Node tests PASS; webpack builds `dist/background.js`; no use of `browser.management.getAll` is added.

- [ ] **Step 5: Commit Tree Style Tab support**

```bash
git add addon/src/js/tree-style-tab.js addon/src/js/opener-links.js addon/src/js/constants.js addon/src/js/tabs.js addon/src/js/groups.js addon/src/js/windows.js addon/src/js/migrations-main.js addon/test
git commit -m "refactor: isolate tree style tab opener restoration"
```

### Task 3: Remove plugins, external protocol, and broad extension inventory

**Files:**
- Delete: `plugins/`
- Delete: `addon/src/js/extensions.js`
- Delete: `addon/src/js/groups-external.js`
- Delete: `addon/src/help/extensions-that-conflict-with-stg.html`
- Delete: `addon/src/help/extensions-that-conflict-with-stg.js`
- Modify: `addon/src/background.js`
- Modify: `addon/src/js/messages.js`
- Modify: `addon/src/js/groups.js`
- Modify: `addon/src/js/tabs.js`
- Modify: `addon/src/js/migrations-main.js`
- Modify: `addon/src/js/constants.js`, `addon/src/js/utils.js`, `addon/src/js/logger-utils.js`, `addon/src/js/listeners.js`
- Modify: `addon/src/help/open-in-container.js`
- Test: `addon/scripts/check-standalone-core.mjs`

**Interfaces:**
- STG pages, content scripts, commands, and ports can still call `onBackgroundMessage`.
- A foreign extension cannot call a public background API because no external listener is registered.
- Backups retain opaque `moz-extension:` URLs unchanged.

- [ ] **Step 1: Remove transport and fanout as one unit**

Delete `Messages.sendExternalMessage`, `GroupsExternal` import/listener wiring, the `sendExternalMessage` function, `self.sendExternalMessage`, `runtime.onMessageExternal` registration, startup external `i-am-back`, all allow-list validation, and the `runtime.onMessageExternal` custom scheme.

Retain:

```js
Listeners.runtime.onConnect.add(Messages.createListenerOnConnectedBackground(onBackgroundMessage));
Listeners.runtime.onMessage.add(onBackgroundMessage);
Listeners.commands.onCommand.add(name => onBackgroundMessage(name, self));
```

Delete external-only dispatcher actions: `get-groups-list`, `get-current-group`, `tab-organizer-apply-grouping-plan`, and `ignore-ext-for-reopen-container`.

- [ ] **Step 2: Replace external group projection only at internal callers**

Delete `Groups.mapForExternalExtension`. For content-script `show-groups-popup` payloads, define an internal mapper in `background.js` that emits only fields used by the content script:

```js
function mapGroupsForPage(groups) {
    return groups.map(group => ({
        id: group.id,
        title: Groups.getTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: Groups.getIconUrl(group),
    }));
}
```

Use it for internal `Tabs.sendMessage` popup payloads; return the full STG group object for internal `add-new-group` results when callers require it.

- [ ] **Step 3: Remove arbitrary extension identity behavior**

Delete the extension registry, conflict lists/help route, AMO API constants, origin-extension lookup, conflict waits, ignore sets, extension icon metadata, and open-in-container parameters/UI based on `conflictedExtId`. Keep normal container reopen strictly based on STG’s tab, group, and container data. Simplify `open-in-container.js` to its STG-owned container/group choices, or delete it and the route if no non-integration caller remains.

Remove all `Extensions.tabsToId/tabsToUUID` calls. They must become no-ops by deletion: saved and restored URLs remain exact opaque strings. In `Tabs.create`, replace `Extensions.extractUUID(url)` with a local validity check that accepts any `moz-extension://` URL unchanged rather than resolving its owning add-on.

- [ ] **Step 4: Delete Group Notes migration silently**

Delete the entire `STG_GROUP_NOTES_ID` `get-backup`/`set-backup` block from `migrations-main.js`; remove its `Messages` import only if no internal use remains. Do not replace it with a notice, export, deletion, or compatibility path.

- [ ] **Step 5: Verify protocol removal**

Run:

```bash
cd addon
npm run check:standalone
rg -n 'runtime\.sendMessage\([^)]*,|management\.(getAll|onEnabled|onDisabled|onInstalled|onUninstalled)|onMessageExternal' src || true
npm run build
```

Expected: build passes; the guard may still report cloud/native-host tokens and paths scheduled for Task 4, but it must not report plugin, external-message, allow-list, fanout, conflict, or extension-inventory violations. The search returns no cross-extension send, inventory, listener, or external-message result.

- [ ] **Step 6: Commit external-boundary removal**

```bash
git add -A plugins addon/src
git commit -m "refactor: remove plugin and external extension APIs"
```

### Task 4: Remove cloud and native-host backup paths; normalize legacy data to Downloads

**Files:**
- Delete: `host/`, `addon/src/js/host.js`, `addon/src/options/backup-location-host.vue`
- Delete: `addon/src/js/sync/cloud/`, `addon/src/js/sync/new-cloud-groups.js`, `addon/src/js/sync/sync-storage.js`, `addon/src/js/migrations-sync.js`, `addon/src/js/mixins/sync-cloud.mixin.js`
- Delete: `addon/src/options/github-gist.vue`, `addon/src/options/github-gist-fields.vue`, `addon/src/help/how-to-github-gist.html` and referenced images
- Modify: `addon/src/background.js`, `addon/src/js/constants.js`, `addon/src/js/migration.js`, `addon/src/js/migrations-main.js`, `addon/src/js/groups.js`, `addon/src/components/edit-group.vue`, `addon/src/js/mixins/tab-groups.mixin.js`, `addon/src/options/Options.vue`, `addon/src/popup/Popup.vue`, `addon/src/help/stg-debug.js`, `addon/src/manifest.json`
- Test: new normalization tests in `addon/test/local-backup-normalization.test.mjs`

**Interfaces:**
- `normalizeStandaloneOptions(data): boolean` mutates only obsolete cloud/host state, returns whether it changed data, sets `autoBackupLocation` to `'downloads'`, removes `uploadToCloud` from groups/defaults, and leaves core groups/tabs/local backup path intact.
- `initLocalData()` applies and persists that normalizer even when the stored format version is current; `restoreBackup()` applies it before validation/use.
- Automatic backup always invokes `File.saveBackup(data, true)`.

- [ ] **Step 1: Add a pure normalizer and failing tests**

Create `addon/src/js/standalone-normalization.js` and test it with an old object containing `autoBackupLocation: 'host'`, Gist tokens, sync settings, a cloud stub `{id: 'stub', uploadToCloud: false}`, a normal group, and `defaultGroupProps.uploadToCloud`.

The test must assert Downloads is selected, core `autoBackupFilePath` remains unchanged, normal group tabs remain, the stub is removed, and no normal group/default props retains `uploadToCloud`.

- [ ] **Step 2: Implement the normalizer**

Implement the following explicit transformation (return `changed` after comparing the relevant fields or recording each mutation):

```js
const obsoleteOptionKeys = [
    'syncEnable', 'syncOptionsLocation', 'syncIntervalKey', 'syncIntervalValue',
    'syncTabFavIcons', 'githubGistToken', 'githubGistFileName',
];

export function normalizeStandaloneOptions(data) {
    data.autoBackupLocation = 'downloads';
    for (const key of obsoleteOptionKeys) delete data[key];
    data.defaultGroupProps ??= {};
    delete data.defaultGroupProps.uploadToCloud;
    data.groups = (data.groups ?? []).filter(group => !(group.uploadToCloud === false && !Object.hasOwn(group, 'tabs')));
    for (const group of data.groups) delete group.uploadToCloud;
    return data;
}
```

Call it inside `initLocalData()` after `migrate()` and persist with `Storage.set(data)` whenever it changes data, even if `result.migrated` is false. Call it from `restoreBackup` before group validation/use. Remove the sync-migration import and `migrateSyncData` API once no storage-sync caller remains.

- [ ] **Step 3: Make local Downloads the only backup route**

Delete cloud imports, commands, alarms, retries, RPC methods, restore stub special-case comments/logic, progress UI, group cloud mutation calls, and group editor fields. Delete host permissions/components/restore-last-host-backup behavior. Replace the automatic branch with:

```js
if (isAutoBackup) {
    await File.saveBackup(data, true);
    storage.autoBackupLastTimeStamp = Utils.unixNow();
} else {
    await File.saveBackup(data, false);
}
```

Keep the existing local `File.loadJson`, `File.saveBackup`, Downloads permission, export/import action, backup schedule, and Downloads location component.

- [ ] **Step 4: Simplify manifest, diagnostics, and UI consumers**

Remove `nativeMessaging` optional permission and `start-cloud-sync` command. Remove cloud/host imports, mixins, popup button/progress, options panels, host restore controls, debug permission/inventory report, and all now-unused constants including `HOST`, sync defaults, cloud hotkey/menu items, and `AUTO_BACKUP_LOCATIONS.HOST`.

- [ ] **Step 5: Run normalization and local-backup validation**

Run:

```bash
cd addon
npm test
node -e "const m=require('./src/manifest.json'); if (m.optional_permissions?.includes('nativeMessaging')) process.exit(1); if (m.commands['start-cloud-sync']) process.exit(1); console.log('Manifest is local-backup-only.')"
npm run build
```

Expected: all tests/build pass; manifest check prints `Manifest is local-backup-only.`

- [ ] **Step 6: Commit backup simplification**

```bash
git add -A host addon/src addon/test
git commit -m "refactor: keep download-only backup and restore"
```

### Task 5: Remove remaining integration UI/docs/locales and make packaging self-consistent

**Files:**
- Delete: `docs/UPLOAD-TO-CLOUD.md`
- Modify: `README.md`, `translate/index.js`, `addon/src/_locales/*/messages.json`, `addon/webpack.config.js`, `eslint.config.js`
- Modify: `docs/OPENER-BEHAVIOR.md` where it describes cloud-only behavior
- Test: locale JSON parsing and package-content guard

**Interfaces:**
- Documentation advertises only core groups, containers, local export/import, automatic Downloads backups, and Tree Style Tab opener behavior.
- Built and zipped artifacts include no plugin/host/cloud/external-protocol files.

- [ ] **Step 1: Remove stale user-facing integrations**

Delete README plugin, Gesturefy, conflict, third-party import, and native-host permission text. Replace the management permission description with: `management: checks whether Tree Style Tab is enabled before restoring saved opener relationships.` Remove translator plugin discovery: `translate/index.js` must load only the main add-on component data.

- [ ] **Step 2: Remove third-party import controls and locale keys safely**

Delete the Panorama View and Sync Tab Groups import methods/template buttons from `Options.vue`, while retaining Old Tab Groups import and STG JSON restore. Use a Node JSON transformation to remove only locale keys no longer referenced after source cleanup (plugin, conflict, Gist/sync, host/native messaging, and third-party importer keys). Parse every locale before writing; never use line deletion.

- [ ] **Step 3: Tighten final guard and lint configuration**

Extend the guard’s path assertions to include removed source modules/help/docs, and scan `addon/dist` after build. Exclude deleted `plugins/**/*.js` from `eslint.config.js` file globs. Ensure the guard does not scan approved design/plan documents, where removal names are intentionally historical text.

- [ ] **Step 4: Validate source, locale JSON, build, and archives**

Run:

```bash
node -e "for (const dir of require('fs').readdirSync('addon/src/_locales')) JSON.parse(require('fs').readFileSync(`addon/src/_locales/${dir}/messages.json`)); console.log('Locale JSON valid.')"
npx eslint addon translate
cd addon && npm run check:standalone && npm run build && npm run build-zip
unzip -l dist-zip/*.zip | rg 'plugins/|host/|sync/cloud|github-gist|backup-location-host|extensions-that-conflict' && exit 1 || true
```

Expected: locale parse/lint/guard/build/archive commands pass; the archive listing prints no prohibited path.

- [ ] **Step 5: Commit UI/documentation/package cleanup**

```bash
git add README.md translate/index.js docs addon/src/_locales addon/webpack.config.js eslint.config.js addon/scripts addon/package.json
git commit -m "docs: document standalone tab groups core"
```

### Task 6: Final verification and Firefox smoke coverage

**Files:**
- Modify only if required to correct an observed verification failure.
- Test: Node tests, static guard, lint, build, zip, Firefox/manual harness.

- [ ] **Step 1: Run the complete automated suite from a clean package output**

Run:

```bash
rm -rf addon/dist addon/dist-zip
cd addon && npm test && npm run check:standalone && npm run build && npm run build-zip
cd .. && npx eslint addon translate
git status --short
```

Expected: all commands succeed. Confirm only intended source/docs changes are tracked; do not stage `.pi-subagents/` or unrelated untracked planning artifacts.

- [ ] **Step 2: Inspect the packaged manifest and artifacts**

Run:

```bash
node -e "const m=require('./addon/dist/manifest.json'); console.log(m.background.scripts); console.log(m.permissions.includes('management')); console.log(m.optional_permissions ?? []);"
unzip -l addon/dist-zip/*-prod.zip | rg 'plugins/|host/|onMessageExternal|github-gist|sync/cloud|nativeMessaging' && exit 1 || true
```

Expected: background is `["background.js"]`; management is `true`; native messaging is absent; the zip search returns no matches.

- [ ] **Step 3: Perform browser smoke tests and record actual outcomes**

Temporarily load `addon/dist/manifest.json` in Firefox. Verify:

1. Create, rename, switch, move tabs between, unload/archive, restore, and delete groups across windows.
2. Use a popup action, Manage page, options page, context menu, and configured keyboard command; confirm internal messaging still works.
3. Export a local JSON backup, import it, and trigger an automatic backup; confirm it downloads through Firefox.
4. With Tree Style Tab enabled, restore an archived/saved group with opener relationships and confirm links are restored. Disable Tree Style Tab, repeat, and confirm tabs restore without opener writes.
5. Load a legacy backup containing `autoBackupLocation: "host"`, cloud settings, a cloud stub, and an opaque `moz-extension:` URL. Confirm restore finishes, becomes Downloads-only, removes the stub, retains the normal group/tab, and never contacts a host/cloud/add-on API.

Record pass/fail evidence in the final report. If browser smoke tests cannot run, explicitly report them as unperformed rather than claiming success.

- [ ] **Step 4: Commit verified final state**

```bash
git add -A
# Inspect the staged list; unstage .pi-subagents/ and unrelated docs/superpowers/plans artifacts if present.
git commit -m "refactor: simplify to standalone tab groups core"
```

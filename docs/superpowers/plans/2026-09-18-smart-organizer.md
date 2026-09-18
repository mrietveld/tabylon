# Smart Organizer Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Tab Organizer's generate/review/apply workflow into Simple Tab Groups as an internal, reusable draft-based feature.

**Architecture:** Pure organizer modules own contracts, draft transformations, and apply planning; a browser adapter captures live tabs and calls the configured service; the STG background composes those pieces and exposes them only through the existing internal RPC registry. A dedicated Vue page edits the draft and applies it through a compensating coordinator built on STG's existing group and tab operations.

**Tech Stack:** Firefox MV2 WebExtensions, ES modules, Vue 2.7, webpack 5, `browser.storage.session`, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-18-smart-organizer-design.md`

## Global Constraints

- Keep extension ID `simple-tab-groups@drive4ik` and the existing persisted group schema.
- Do not add `runtime.onMessageExternal`, an extension allowlist, or any cross-extension messages.
- Do not modify the Python backend.
- Default service URL is `http://127.0.0.1:5050` and only HTTP(S) URLs are accepted.
- Model/service data is untrusted and must never be rendered as HTML.
- A draft never changes tabs until the user explicitly applies it.
- Pinned and STG-unmovable tabs are excluded and reported.

---

### Task 1: Contracts and editable draft model

**Files:**
- Create: `addon/src/js/organizer/contracts.js`
- Create: `addon/src/js/organizer/draft.js`
- Create: `addon/test/organizer-contracts.test.mjs`
- Create: `addon/test/organizer-draft.test.mjs`

**Interfaces:**
- Produces: `createGroupingRequest(tabs, {minimumGroupSize, scope})`.
- Produces: `validateGroupingPlan(plan, snapshot)`.
- Produces: `createDraft(snapshot, plan)`, `validateDraft(draft)`, and immutable draft edit helpers.

- [ ] Write tests for valid plans, mismatched request IDs, unknown IDs, duplicate assignments, invalid names, and minimum sizes.
- [ ] Run `node --test test/organizer-contracts.test.mjs` and confirm missing-module failure.
- [ ] Implement request/plan validation with bounded strings and arrays.
- [ ] Run the contract tests and confirm they pass.
- [ ] Write draft tests for rename, move-to-group, move-to-unassigned, and group removal.
- [ ] Implement immutable draft helpers and validate every resulting draft.
- [ ] Run both focused tests and commit the slice.

### Task 2: Snapshot selection and session draft storage

**Files:**
- Create: `addon/src/js/organizer/snapshot.js`
- Create: `addon/src/js/organizer/draft-store.js`
- Create: `addon/test/organizer-snapshot.test.mjs`
- Create: `addon/test/organizer-draft-store.test.mjs`

**Interfaces:**
- Consumes: `createGroupingRequest` from Task 1.
- Produces: `selectTabsForScope(tabs, context)`, `normalizeOrganizerTab(tab, groupId)`, and `collectSnapshot(params, dependencies)`.
- Produces: async `getDraftState`, `setDraftState`, and `clearDraftState` using one session-storage key.

- [ ] Write selection tests for ungrouped-current-window, current-group, selected, and all scopes, including pinned and unsupported exclusions.
- [ ] Implement pure selection/normalization and the browser adapter.
- [ ] Write storage adapter tests using an injected in-memory storage area.
- [ ] Implement session draft persistence without touching durable group storage.
- [ ] Run focused tests and commit the slice.

### Task 3: Service client and workflow composition

**Files:**
- Create: `addon/src/js/organizer/client.js`
- Create: `addon/src/js/organizer/index.js`
- Create: `addon/test/organizer-client.test.mjs`
- Modify: `addon/src/background.js`
- Modify: `addon/src/js/constants.js`

**Interfaces:**
- Consumes: snapshot/contracts/draft/store APIs from Tasks 1–2.
- Produces: `checkService`, `generateGroupingPlan`, and internal module methods `getState`, `start`, `saveDraft`, `refresh`, `clear`.

- [ ] Write fetch-client tests for URL validation, health failures, HTTP failures, malformed JSON, and response validation.
- [ ] Implement the client with structured safe errors.
- [ ] Add organizer defaults to `DEFAULT_OPTIONS`: service URL, minimum size, and default scope.
- [ ] Compose the workflow and register `Organizer` in `INTERNAL_MODULES` only.
- [ ] Run focused and existing tests and commit the slice.

### Task 4: Preflight and compensating apply coordinator

**Files:**
- Create: `addon/src/js/organizer/apply-plan.js`
- Create: `addon/test/organizer-apply-plan.test.mjs`
- Modify: `addon/src/js/organizer/index.js`

**Interfaces:**
- Consumes: validated drafts and injected `getTabs`, `getTabGroup`, `addGroup`, `moveTabs`, and `removeGroup` operations.
- Produces: `preflightDraft(draft, liveTabs, getTabGroup)` and `applyDraft(draft, operations)`.
- Adds internal `Organizer.apply(draft)`.

- [ ] Write tests proving preflight reports all missing/changed tabs before mutation.
- [ ] Write success tests proving groups are created and moved in draft order.
- [ ] Write failure tests proving compensation is attempted in reverse order and rollback failures are reported.
- [ ] Implement preflight and coordinator without claiming atomicity.
- [ ] Connect the coordinator to internal STG `Groups`/`Tabs` operations.
- [ ] Run focused and existing tests and commit the slice.

### Task 5: Organizer review page

**Files:**
- Create: `addon/src/organize/organize.html`
- Create: `addon/src/organize/organize.js`
- Create: `addon/src/organize/Organize.vue`
- Create: `addon/src/icons/sparkles.svg`
- Modify: `addon/webpack.config.js`
- Modify: `addon/src/js/constants.js`

**Interfaces:**
- Consumes: internal RPC methods `Organizer.getState/start/saveDraft/refresh/apply/clear`.
- Produces: `Constants.PAGES.ORGANIZE` and the bundled organizer page.

- [ ] Add the webpack entry, copied HTML, page constant, and safe SVG asset.
- [ ] Implement choose, loading, error, review, applying, and result states using STG styles.
- [ ] Implement editable names, HTML5 drag/drop, unassigned tray, group removal, regenerate, cancel, and apply.
- [ ] Ensure all service-originated content uses text bindings.
- [ ] Build the extension and commit the slice.

### Task 6: Popup and settings integration

**Files:**
- Modify: `addon/src/popup/Popup.vue`
- Modify: `addon/src/js/mixins/global.mixin.js`
- Modify: `addon/src/options/Options.vue`
- Modify: `addon/src/_locales/en/messages.json`

**Interfaces:**
- Consumes: `Constants.PAGES.ORGANIZE`, organizer default options, and `Organizer.start`.
- Produces: popup Smart organize shortcut and Organizer options section.

- [ ] Add `openOrganizer` to the global mixin and a footer button to the popup.
- [ ] Pass selected popup tab IDs as the initial selected scope when available.
- [ ] Add an Organizer settings tab with service URL, minimum size, default scope, and privacy copy.
- [ ] Add English localization messages; other locales fall back to the default locale.
- [ ] Build and commit the slice.

### Task 7: Regression coverage and documentation

**Files:**
- Modify: `addon/scripts/check-standalone-core.mjs`
- Modify: `README.md`
- Modify: `docs/extension-functionality-summary.md` if present

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a guard that permits the internal organizer while still rejecting external messaging.

- [ ] Extend the standalone guard to reject the retired extension ID and cross-extension send patterns while allowing internal organizer names.
- [ ] Document Smart organize setup, privacy, scopes, and review/apply flow.
- [ ] Run `npm test`, `npm run check:standalone`, and `npm run build` from `addon/`.
- [ ] Inspect the built manifest to confirm the STG ID is unchanged and no external listener exists.
- [ ] Review the final diff for accidental backend or sibling-repository changes and commit the slice.

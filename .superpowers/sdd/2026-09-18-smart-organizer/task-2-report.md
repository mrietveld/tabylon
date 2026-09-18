# Task 2 — Snapshot selection and session draft storage

## Implementation

- Added `addon/src/js/organizer/snapshot.js` with browser-independent,
  dependency-injected snapshot collection:
  - `selectTabsForScope(tabs, context)` supports
    `ungrouped-current-window`, `current-group`, `selected`, and `all`.
    It only reports exclusions for tabs that are inside the requested scope,
    preserving the order returned by the browser.
  - Pinned tabs are skipped with `{reason: 'pinned'}` and tabs rejected by the
    injected STG safety predicate are skipped with `{reason: 'unsupported'}`.
  - `normalizeOrganizerTab(tab, groupId)` keeps the display hints and STG
    membership needed by review/apply, and captures the immutable
    `{tabId, windowId, url, groupId}` fingerprint.
  - `collectSnapshot(params, dependencies)` queries tabs through injected
    functions, normalizes eligible tabs, retains the full grouping request
    produced by `createGroupingRequest`, and records injected request ID and
    capture time. Retaining `snapshot.request.minimumGroupSize` keeps the
    snapshot valid for Task 1's `validateGroupingPlan`.
- Added `addon/src/js/organizer/draft-store.js`:
  - all three operations share the sole session key
    `smart-organizer-draft`;
  - the default area is `browser.storage.session`; and
  - every operation accepts an injected storage area for Node tests and
    workflow composition. No durable STG storage module is imported or used.
- Added focused Node test suites for all selection scopes, exclusion reasons,
  normalization/fingerprints, request retention, empty/persisted/cleared
  session state.

## TDD evidence

### RED

Command, from `addon/`:

```sh
node --test test/organizer-snapshot.test.mjs test/organizer-draft-store.test.mjs
```

Before implementation the test runner failed for the expected missing modules:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../addon/src/js/organizer/draft-store.js'
...
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../addon/src/js/organizer/snapshot.js'
...
ℹ pass 0
ℹ fail 2
```

### Focused GREEN

After the minimal implementation, the same command reported:

```text
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

### Full addon suite

Command, from `addon/`:

```sh
npm test
```

Result:

```text
ℹ tests 28
ℹ pass 28
ℹ fail 0
```

## Files changed

- `addon/src/js/organizer/snapshot.js`
- `addon/src/js/organizer/draft-store.js`
- `addon/test/organizer-snapshot.test.mjs`
- `addon/test/organizer-draft-store.test.mjs`
- `.superpowers/sdd/2026-09-18-smart-organizer/task-2-report.md`

## Self-review

- Scope selection is pure: the STG membership lookup and movability predicate
  are injected; neither selection nor normalization accesses `browser`.
- The storage adapter has one exported constant shared by get, set, and clear;
  its default evaluates to `browser.storage.session`, never
  `browser.storage.local` or the durable groups store.
- The service request contains only the fields defined by Task 1, while the
  snapshot deliberately retains the additional fields necessary for later
  review and preflight.
- Pinned detection takes precedence over the generic safety predicate, so the
  user gets the more useful skipped reason.

## Concerns

- `collectSnapshot` intentionally requires Task 3 to provide `getTabs` and a
  STG membership `getGroupId` function. This keeps the module Node-testable and
  avoids coupling this slice to an unreviewed `Groups` loading strategy.
- The workflow composer should pass STG's `Tabs.isCanNotBeHidden` as
  `isCanNotBeHidden`, and choose how it obtains current group membership before
  exposing the UI action.

## Review fixes

### Root cause and changes

The initial collector supplied a fallback movability predicate that only
recognized pinned tabs. That meant a caller that omitted STG's
`Tabs.isCanNotBeHidden` could incorrectly include sharing-protected tabs. The
fallback is removed: both `collectSnapshot` and public scope selection now
require an `isCanNotBeHidden` function and fail closed when it is absent.

The initial membership lookup passed each full tab object to `getGroupId` and
used strict equality with `null`. STG Cache lookups use a tab ID and commonly
return `undefined` for ungrouped tabs. Selection and snapshot fingerprinting
now call `getGroupId(tab.id)` and normalize its result with `?? null`.

### Review-fix RED

Command, from `addon/`:

```sh
node --test test/organizer-snapshot.test.mjs
```

Before the production change, the new regressions failed as expected:

```text
✖ selectTabsForScope treats undefined STG membership as ungrouped and resolves membership by tab ID
  actual: []
  expected: [1]
...
✖ collectSnapshot rejects collection without the STG movability predicate
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
...
ℹ tests 8
ℹ pass 3
ℹ fail 5
```

The existing scope tests also failed in that RED run after their fixtures were
updated to the correct ID-based callback contract, confirming the original
implementation was passing a tab object rather than its ID.

### Review-fix focused GREEN

After requiring the safety predicate and normalizing ID-based membership, the
same focused command reported:

```text
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

### Review-fix full addon suite

Command, from `addon/`:

```sh
npm test
```

Result:

```text
ℹ tests 30
ℹ pass 30
ℹ fail 0
```

# Task 1 — Contracts and editable draft model

## Implementation

- Added `addon/src/js/organizer/contracts.js`, a browser-independent contract
  boundary that:
  - creates a minimized service request containing only `tabId`, `title`, and
    `url`, plus `minimumGroupSize` and `scope`;
  - bounds untrusted arrays and strings;
  - validates request/snapshot identity, known tab IDs, unique assignments,
    group names, and service-plan minimum group sizes; and
  - requires every captured tab to be assigned exactly once, either to a plan
    group or to `ungroupedTabIds`.
- Added `addon/src/js/organizer/draft.js`, which:
  - creates an independent editable draft from a validated plan and cloned
    snapshot;
  - validates all draft assignments, names, IDs, and non-empty groups;
  - provides immutable `renameDraftGroup`, `moveDraftTabToGroup`,
    `moveDraftTabToUnassigned`, and `removeDraftGroup` helpers; and
  - deliberately does **not** enforce `minimumGroupSize` for drafts. A user
    can therefore leave a non-empty one-tab group after review edits.
- Added focused Node test suites for the required valid/invalid plan and draft
  editing scenarios.

## TDD evidence

### Contracts RED

Command, from `addon/`:

```sh
node --test test/organizer-contracts.test.mjs
```

Relevant output before the module existed:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../addon/src/js/organizer/contracts.js'
...
ℹ pass 0
ℹ fail 1
```

### Contracts GREEN

Command, from `addon/`:

```sh
node --test test/organizer-contracts.test.mjs
```

Relevant output:

```text
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

### Draft RED

Command, from `addon/`:

```sh
node --test test/organizer-draft.test.mjs
```

Relevant output before the module existed:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../addon/src/js/organizer/draft.js'
...
ℹ pass 0
ℹ fail 1
```

### Focused GREEN

Command, from `addon/`:

```sh
node --test test/organizer-contracts.test.mjs test/organizer-draft.test.mjs
```

Relevant output:

```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

### Full addon suite

Command, from `addon/`:

```sh
npm test
```

Relevant output:

```text
> node --test test/*.test.mjs
...
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

## Files changed

- `addon/src/js/organizer/contracts.js`
- `addon/src/js/organizer/draft.js`
- `addon/test/organizer-contracts.test.mjs`
- `addon/test/organizer-draft.test.mjs`
- `.superpowers/sdd/2026-09-18-smart-organizer/task-1-report.md`

## Self-review

- The modules do not access `browser`, storage, DOM APIs, or network APIs.
- Request construction intentionally excludes browser-only and apply-only tab
  fields, limiting the service payload.
- Validation rejects request mismatch, unknown IDs, duplicates, blank or
  oversized names, empty draft groups, and missing assignments.
- Edit helpers never mutate the supplied draft and validate each returned
  draft.
- The test suite includes the product ruling that draft groups below the
  configured service minimum remain valid after user edits.

## Concerns

- Task 2 must preserve `snapshot.request.minimumGroupSize` (or set the
  equivalent top-level `snapshot.minimumGroupSize`) so service-plan validation
  can enforce the generation minimum.
- Draft group IDs reuse the service plan's validated `groupId`; later UI work
  should continue using `draft.groups[].id` as the stable edit key.

# Task 5 — Organizer review page

## Status

Complete.

## Delivered

- Added the `organize/organize.html` Vue entry page and wired webpack to emit
  `organize/organize.html`, `organize/organize.js`, and
  `organize/organize.css`.
- Added `Constants.PAGES.ORGANIZE` without changing the extension manifest or
  exposing any organizer RPC method externally.
- Added a local, script-free `sparkles.svg` page asset.
- Implemented the complete organizer UI flow:
  - choose between ungrouped-current-window, current-group, selected, and all;
  - generate/loading and apply/loading screens;
  - review editable group names, reasons, warnings, skipped tabs, and
    unassigned tabs;
  - move tabs between groups and the unassigned tray with HTML5 drag/drop;
  - remove a proposed group by moving its tabs to unassigned;
  - regenerate, cancel/clear, and apply actions;
  - success and safe error/recovery screens.
- The selected scope is enabled only when valid `tabId` values arrive through
  the URL. Query parsing accepts repeated and comma-separated values, ignores
  malformed/unsafe integers, removes duplicates, and gives valid selected IDs
  precedence over an explicit scope.
- The page honors STG's configured color scheme and default scope. It does not
  send a UI-owned `minimumGroupSize`; generation continues to use the workflow
  and options default.
- Service/model strings are rendered only with Vue text bindings. Apply error
  UI uses stage-based safe copy and shows retained group IDs and rollback
  uncertainty without rendering coordinator exception messages.

## TDD evidence

### RED

Command, from `addon/`:

```sh
node --test test/organizer-query.test.mjs
```

The first run failed with `ERR_MODULE_NOT_FOUND` for
`src/organize/query.js`. A later configured-default test failed with the
expected mismatch (`ungrouped-current-window` instead of `all`) before the
fallback parameter was implemented.

### Focused GREEN

The same focused command passed all 5 query tests after implementation.

## Verification

- `npm test`: 70 passed, 0 failed.
- `npm run check:standalone`: `Standalone-core checks passed.`
- `npm run build`: webpack compiled successfully; the organizer HTML, JS, and
  CSS files are present in `addon/dist/organize/`.
- `git diff --check`: passed before staging; the staged diff is checked again
  immediately before commit.
- `addon/src/manifest.json` is unchanged.

## Files changed

- `addon/src/organize/organize.html`
- `addon/src/organize/organize.js`
- `addon/src/organize/Organize.vue`
- `addon/src/organize/query.js`
- `addon/src/icons/sparkles.svg`
- `addon/src/js/constants.js`
- `addon/webpack.config.js`
- `addon/test/organizer-query.test.mjs`
- `.superpowers/sdd/2026-09-18-smart-organizer/task-5-report.md`

## Self-review

- Every internal call uses the existing `Organizer.*` RPC surface through the
  global mixin; no runtime message handler or externally callable method was
  added.
- Draft changes are made against a local clone and persisted through
  `Organizer.saveDraft`; apply uses the persisted draft boundary.
- No `innerHTML` or `v-html` is used. Service summary, group names/reasons, and
  warnings are all text-bound.
- The page validates workflow/apply responses before treating them as state,
  and catches RPC failures without displaying raw error text.
- Responsive layouts collapse to one column, and colors use the existing
  Bulma/STG variables under the options mixin's light/dark theme.

## Concerns

- The repository has no Vue component test harness, so interactive rendering
  and drag/drop are covered by webpack compilation and source review rather
  than DOM-level automation. The pure URL-query contract is covered by Node
  tests.

# Task 1 report: bound smart-organizer tab titles

## Implementation summary

- Raised the shared `MAX_TAB_TITLE_LENGTH` contract limit from 512 to 1024.
- Updated organizer-tab normalization to truncate string Firefox titles to the shared contract limit.
- Preserved non-string title values unchanged so request validation continues to reject invalid types.
- Added focused contract and snapshot coverage, including preservation of tab ID and URL.

## Files changed

- `addon/src/js/organizer/contracts.js`
- `addon/src/js/organizer/snapshot.js`
- `addon/test/organizer-contracts.test.mjs`
- `addon/test/organizer-snapshot.test.mjs`

## TDD evidence

RED:

`node --test addon/test/organizer-contracts.test.mjs addon/test/organizer-snapshot.test.mjs`

Result: 16 passed, 2 failed. The new 1024-character request test failed because the old 512 limit rejected it; the new snapshot test failed because the over-limit title reached request validation unchanged.

GREEN:

After the minimal implementation, the same command passed: 18 passed, 0 failed.

## Full add-on test

`npm test` from `addon/`

Result: 116 passed, 2 failed. The two failures are unrelated/shared-branch failures in `organizer-settings.test.mjs` (expected 500, actual 501) and `organizer-workflow.test.mjs` (expected `too-many-eligible-tabs`, actual `invalid-plan-response`). No unrelated files were modified.

## Self-review

- The normalizer uses `MAX_TAB_TITLE_LENGTH` directly from the shared contract; no duplicate limit literal was added.
- Only strings are sliced; invalid non-string titles retain their original value for existing validation behavior.
- The request contract accepts exactly 1024 characters and rejects 1025.
- `git diff --check` passed.

## Commit

`97bb1e06 fix: bound organizer tab titles`

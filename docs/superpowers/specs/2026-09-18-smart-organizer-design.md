# Smart Organizer Integration Design

## Goal

Merge the Tab Organizer WebExtension into Simple Tab Groups (STG) as an opt-in
"Smart organize" workflow. STG remains the sole installed extension, retains the
`simple-tab-groups@drive4ik` extension ID and existing storage schema, and does
not restore any external-extension messaging API.

The Python service is outside this design. The extension talks to a configurable
HTTP endpoint through a narrow client interface compatible with the existing
Tab Organizer request and response contract.

## Product flow

The STG popup gains a Smart organize footer action. It opens a full-page Vue
workflow with four states:

1. **Choose** — select ungrouped tabs in the current window (the default), the
   current STG group, selected popup tabs, or every eligible open tab.
2. **Generate** — show progress while the extension captures a snapshot and
   requests a plan.
3. **Review** — edit group names, drag tabs between proposed groups and an
   unassigned tray, remove proposed groups, regenerate, or cancel.
4. **Apply** — preflight the draft against live browser state, apply it through
   STG's internal group/tab modules, and show an exact result summary.

Pinned tabs and tabs that STG cannot safely move are excluded and shown as
skipped. All-windows scope is explicit because applying a plan may move tabs
between windows. Nothing runs automatically: the user initiates generation and
separately approves application.

The options page gains an Organizer section with the service URL, minimum group
size, default scope, and a privacy explanation that tab titles and URLs are sent
to the configured service.

## Architecture

The organizer is an internal STG module with no dependency on another extension:

- `organizer/contracts.js` defines the snapshot, validated service plan, and
  editable draft shapes.
- `organizer/snapshot.js` selects and normalizes eligible tabs and records their
  STG membership plus an `id`, `url`, and `windowId` fingerprint.
- `organizer/client.js` is the only HTTP boundary.
- `organizer/draft-store.js` persists the active workflow in
  `browser.storage.session`, allowing the background page and review page to
  share state without adding keys to STG's durable settings schema.
- `organizer/apply-plan.js` preflights and applies an approved draft using
  injected operations.
- `organizer/index.js` composes the workflow for STG's background RPC registry.

The review page communicates through STG's existing internal RPC channel. The
background exposes an `Organizer` entry in `INTERNAL_MODULES`; it does not add
`runtime.onMessageExternal`, extension allowlists, or a Tab Organizer extension
ID.

## Data model

A snapshot contains a request ID, capture time, scope, eligible tabs, and
skipped entries. Each eligible tab records:

- `tabId`, `windowId`, `url`, and `title`;
- `active`, `audible`, and `discarded` display hints;
- its current STG `groupId`, if any;
- its immutable apply fingerprint `{tabId, windowId, url, groupId}`.

The service response remains compatible with the MVP shape: `planId`,
`requestId`, `summary`, `groups[{groupId,name,reason,tabIds}]`,
`ungroupedTabIds`, and `warnings`. Validation additionally requires the response
request ID to match, every referenced tab ID to exist in the snapshot, and each
tab to appear at most once across grouped and ungrouped lists.

The editable draft copies plan groups into stable draft IDs. UI edits only the
draft; the captured snapshot remains unchanged. Unassigned tabs are represented
explicitly and are never moved on apply.

## Apply semantics

Apply has a strict preflight before the first mutation:

- re-query every assigned tab;
- reject a tab that closed or whose URL, window, or STG membership differs from
  its captured fingerprint;
- reject empty groups, duplicate assignments, or invalid names;
- report all stale tabs together so the user can remove them or regenerate.

After preflight, the coordinator creates one unloaded STG group per non-empty
draft group and moves its tabs via the existing `Groups.add`/`Tabs.move`
services. It records original group membership and newly created group IDs.
If a later command fails, it attempts compensating rollback by moving changed
tabs back to their original groups and removing newly created empty groups. The
result distinguishes success, apply failure, and rollback failure; it never
claims atomicity because Firefox tab operations are not transactional.

## Security and privacy

- Render model text with Vue text interpolation/property binding, never
  `innerHTML` or `v-html`.
- Validate the service URL as HTTP(S); localhost remains the default.
- Treat all service output as untrusted and enforce length/type/ID constraints.
- Send only fields required by the grouping contract.
- Never log complete URLs, tab titles, or the full plan in routine logs.
- Require explicit Generate and Apply actions.

## Compatibility and migration

- Keep the existing STG manifest ID, version floor, and durable `groups` format.
- Add organizer preferences as normal optional defaults; do not modify existing
  group records.
- Store drafts only in session storage and clear them after a successful apply.
- Do not import or depend on Tab Organizer's extension ID or external STG client.
- The separate Tab Organizer repository can be retired once the merged build is
  released; this repository does not delete a sibling checkout.

## Testing

Pure Node tests cover scope selection, response validation, draft edits,
preflight drift, apply sequencing, and compensation behavior. Existing STG tests,
the standalone-core guard, and the webpack build must remain green. Manual
Firefox verification covers popup navigation, each scope, review editing,
regeneration, stale tabs, service failures, successful application, dark theme,
and multiple windows.

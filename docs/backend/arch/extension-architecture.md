# Tab Organizer Extension Architecture

This document summarizes the Firefox WebExtension architecture for Tab Organizer and the key design decisions made.

## Overview

The extension coordinates three main concerns:

1. **Tab collection** – capturing a normalized snapshot of the users tabs.
2. **Backend communication** – sending the snapshot to a local backend and retrieving a validated grouping plan.
3. **Application of the plan via Simple Tab Groups (STG)** – delegating actual group creation and tab movement to the STG extension.

No grouping logic or LLM calls live in the extension. It treats the backend as an untrusted boundary, validates responses defensively, and only forwards safe plans to STG.

## Main Components

- **Background script** (`extension/src/background/main.js`)
- **Tab collector** (`extension/src/browser/collectTabs.js`)
- **Backend HTTP client** (`extension/src/backend/client.js`)
- **Shared contracts and state** (`extension/src/shared/contracts.js`, `extension/src/shared/state.js`)
- **Popup UI** (`extension/src/popup/popup.html`, `extension/src/popup/popup.js`)
- **Review page UI** (`extension/src/review/review.html`, `extension/src/review/review.js`, `extension/src/review/review.css`)
- **STG client** (`extension/src/stg/client.js`)

These modules communicate via `browser.runtime` messaging and a shared in-memory state object managed by the background script.

## Shared Contracts and Validation

`extension/src/shared/contracts.js` centralizes:

- `BACKEND_ORIGIN` – currently `http://127.0.0.1:5050`, used by the backend client.
- `STG_EXTENSION_ID` – STGs Firefox extension id (`simple-tab-groups@drive4ik`).
- `STG_APPLY_ACTION` – the STG external action string (`tab-organizer-apply-grouping-plan`).

It also exposes helper functions:

- `createGroupingRequest(tabs)` – wraps a normalized tab array into the backends `GroupingRequest` schema (requestId, capturedAt, constraints, tabs).
- `validateGroupingPlan(plan)` – mirrors backend validation to ensure incoming plans are structurally sound before the UI or STG see them. It enforces:
  - Non-empty `planId`, `requestId`, `summary`.
  - `groups` is an array.
  - Each group has non-empty `groupId`, `name`, `reason`.
  - `tabIds` is an array of integers; each group holds at least 5 tabs.
  - No tab id appears in more than one group.
  - `ungroupedTabIds` is an array of integers.
  - `warnings` is an array.

- `validateHealthResponse(payload)` – ensures the health payload equals `{ status: 'ok', service: 'tab-organizer-backend' }`.

These checks treat the backend as an untrusted LLM boundary and prevent malformed responses from affecting the UX or STG.

## Shared State

`extension/src/shared/state.js` maintains the backgrounds in-memory state:

```js
const defaultState = {
  snapshot: null,
  plan: null,
  error: null,
  errorDetails: null,
  applyResult: null,
};
```

It provides:

- `setState(partial)` – merges partial updates.
- `getState()` – returns the current state.
- `resetState()` – returns to `defaultState`.

This state is shared between the popup and review page for:

- current tab snapshot,
- current grouping plan,
- last error (if any),
- result of applying a plan via STG.

## Tab Collection Flow

`extension/src/browser/collectTabs.js`:

- Calls `browser.tabs.query({ currentWindow: false })` to get tabs across all windows.
- Normalizes each tab into the backends `BrowserTab` shape:
  - `tabId`, `windowId`, `title`, `url`.
  - `active`, `pinned`, `audible`, `discarded` as booleans.
- Wraps the list in a `GroupingRequest` via `createGroupingRequest`.

This snapshot is exactly what the backend expects at `POST /api/groupings/generate`.

## Backend HTTP Client

`extension/src/backend/client.js` encapsulates all HTTP calls:

- `checkBackendHealth()` – GET `/health`, validates the response via `validateHealthResponse`, and surfaces structured error details on failure.
- `generateGroupingPlan(payload)` – POST `/api/groupings/generate` with JSON body, handles:
  - network errors via structured `details` (step, URL),
  - non-2xx responses by including backend `detail` where available,
  - JSON parsing via `readJsonResponse`,
  - response validation via `validateGroupingPlan`.

Errors from this client are propagated with rich context so the popup and review page can display helpful debug information.

## Background Script and Workflow

`extension/src/background/main.js` manages the high-level workflow:

- `loadModule(modulePath)` – dynamically imports other modules using `browser.runtime.getURL`, allowing lazy loading of backend, tab collector, and state code.
- `openReviewPage()`:
  - Locates an existing tab for `src/review/review.html` and focuses it, or
  - opens a new tab if none exist.

### `runWorkflow()`

The core workflow:

1. Lazy-loads:
   - backend client (`checkBackendHealth`, `generateGroupingPlan`),
   - tab collector (`collectTabsSnapshot`),
   - state helpers (`resetState`, `setState`).
2. Resets state.
3. In a `try` block:
   - Checks backend health.
   - Collects a tab snapshot.
   - Requests a validated grouping plan from the backend.
   - Stores `{ snapshot, plan, error: null, errorDetails: null, applyResult: null }` via `setState`.
   - Opens/focuses the review page.
   - Returns `{ ok: true, plan }`.
4. On error:
   - Builds `errorDetails` from `error.details` or error name/message.
   - Stores `{ error: error.message, errorDetails, applyResult: null }` in state.
   - Returns `{ ok: false, error: error.message, details: errorDetails }`.

### Background message handling

The background script listens for extension-level messages:

- `tab-organizer/start` – invokes `runWorkflow()` and returns its result to the popup.
- `tab-organizer/get-state` – lazy-loads `state.js` and returns `getState()` for the review page.
- `tab-organizer/apply-plan` – lazy-loads state and the STG client, then:
  - Logs the plan being applied (planId, requestId, groupCount).
  - Calls `applyGroupingPlanInStg(state.plan)` and stores `applyResult` on success.
  - On failure, stores a detailed `errorDetails` with `step: 'stg-apply'` and logs the failure.
- `tab-organizer/refresh` – simply re-runs `runWorkflow()`.

All other message types are ignored.

## Popup and Review UIs

### Popup (`extension/src/popup/popup.js`)

- Wires the "Organize" button to send `{ type: 'tab-organizer/start' }`.
- Shows progress messages and, on success, informs the user that the review page has been opened.
- On failure, displays the error and JSON-serialized `details` for debugging.

### Review page (`extension/src/review/review.js`)

- Initial load calls `loadState()` via `{ type: 'tab-organizer/get-state' }`.
- Renders:
  - summary (`state.plan.summary`),
  - per-group cards showing `name`, `reason`, and the list of tabs,
  - ungrouped tab list.
- "Approve and Apply" button sends `{ type: 'tab-organizer/apply-plan' }`:
  - After STG apply completes or fails, reloads state to show `applyResult` or error.
- "Refresh" button sends `{ type: 'tab-organizer/refresh' }` and reloads state.

Titles are derived via `findTabTitle(snapshot, tabId)`, which shows `title  url` or a fallback.

## STG Integration and Error Handling

### Message contract

`extension/src/stg/client.js` encapsulates STG messaging:

- Before sending:
  - Validates that `plan.groups` is non-empty.
  - Ensures each group has a non-empty `name` and an integer-only `tabIds` array.
- Sends:

```js
await browser.runtime.sendMessage(STG_EXTENSION_ID, {
  action: STG_APPLY_ACTION,
  groups: plan.groups.map(group => ({
    name: group.name,
    tabIds: group.tabIds,
  })),
});
```

- Wraps the call in a `try`/`catch`:
  - Logs failures with `stgExtensionId`, `stgAction`, and error text.
  - When the error message contains "Could not establish connection", raises a clearer error instructing the user to verify STGs installation, enablement, and extension id.

### STG-side support

On the STG side (in its own repo), the Tab Organizer integration is whitelisted:

- `EXTENSIONS_WHITE_LIST['tab-organizer@example.local']` includes `getActions: ['tab-organizer-apply-grouping-plan']`.
- STGs external background handler forwards `action: 'tab-organizer-apply-grouping-plan'` to its internal switch.
- A dedicated `case 'tab-organizer-apply-grouping-plan'` handler:
  - Validates `data.groups` as a non-empty array.
  - For each group: ensures a non-empty `name` and integer `tabIds`.
  - Creates a new group via `Groups.add` and moves tabs with `Tabs.move`.
  - Returns `{ ok: true, createdGroups, movedTabs }`.

This handler lives in STGs main background script (`stg-background.js`) and is available after running STGs webpack build and loading the resulting dist manifest.

### Design decisions

- **Narrow trusted API into STG** – only `name` and tab ids are passed; reasons are a backend concern.
- **Separation of responsibilities**:
  - Extension is responsible for validating backend plans and initiating STG applies.
  - STG is responsible for group creation and tab movement.
- **Clear error messaging** – both Tab Organizer and STG log structured messages and surface clear errors when integration fails.

## Summary of Key Extension Decisions

- All grouping logic and LLM calls live exclusively in the backend.
- The extension validates backend responses before showing or applying plans.
- Shared state is used to coordinate between popup and review UI.
- STG integration uses a whitelisted external messaging API with a dedicated action.
- Robust error handling and logging make failures (backend or STG) observable and diagnosable.

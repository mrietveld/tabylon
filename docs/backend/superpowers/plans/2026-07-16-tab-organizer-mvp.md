# Tab Organizer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Firefox extension plus a local Python backend that generates tab grouping plans and applies approved plans through a modified Simple Tab Groups extension.

**Architecture:** The Firefox extension collects tabs, calls a Python FastAPI backend on localhost, renders a review UI, and applies approved grouping plans through STG external messaging. The backend owns prompt construction, LLM calls, validation, and file logging. STG exposes a narrow trusted API for exact group creation and tab assignment.

**Tech Stack:** Firefox WebExtension, plain JavaScript/HTML/CSS, Python 3.11+, FastAPI, Pydantic, pytest, Simple Tab Groups source tree

## Global Constraints

- Backend is a separate Python process started manually by the user.
- Backend binds only to `127.0.0.1`.
- Backend logs to a local `backend/logs/` directory.
- The extension contains no grouping logic.
- The backend must validate all model output before returning it.
- Groups must contain at least 5 tabs.
- No tabs are modified until a validated plan is explicitly approved by the user.
- STG must trust only the tab-organizer extension ID for the new external API.

---

### Task 1: Scaffold backend with logging and health endpoint

**Files:**
- Create: `backend/app/main.py`
- Create: `backend/app/core/config.py`
- Create: `backend/app/core/logging_setup.py`
- Create: `backend/app/api/routes.py`
- Create: `backend/app/api/schemas.py`
- Create: `backend/tests/test_health.py`
- Create: `backend/requirements.txt`

**Interfaces:**
- Produces: FastAPI app factory `create_app() -> FastAPI`
- Produces: endpoint `GET /health`
- Produces: logger setup `configure_logging(log_dir: Path) -> Path`

- [ ] Write failing backend health and log-dir tests
- [ ] Run pytest to verify tests fail
- [ ] Implement minimal FastAPI app, config, and logging setup
- [ ] Run pytest to verify tests pass

### Task 2: Define grouping request/response schemas and validator tests

**Files:**
- Modify: `backend/app/api/schemas.py`
- Create: `backend/app/services/validator.py`
- Create: `backend/tests/test_validator.py`

**Interfaces:**
- Produces: `GroupingRequest`, `GroupingPlan`, `GroupingPlanGroup`
- Produces: `validate_grouping_plan(plan: GroupingPlan, request: GroupingRequest) -> GroupingPlan`

- [ ] Write failing validator tests for unknown tabs, duplicates, and groups under size 5
- [ ] Run pytest to verify tests fail
- [ ] Implement schemas and validator
- [ ] Run pytest to verify tests pass

### Task 3: Add backend grouping route with mockable LLM client

**Files:**
- Modify: `backend/app/api/routes.py`
- Create: `backend/app/services/prompt_builder.py`
- Create: `backend/app/services/llm_client.py`
- Create: `backend/app/services/grouping_service.py`
- Create: `backend/tests/test_generate_grouping.py`

**Interfaces:**
- Produces: `generate_grouping_plan(request: GroupingRequest) -> GroupingPlan`
- Produces: endpoint `POST /api/groupings/generate`

- [ ] Write failing API tests for valid generation and validation failure
- [ ] Run pytest to verify tests fail
- [ ] Implement grouping service with injectable/mockable LLM client
- [ ] Run pytest to verify tests pass

### Task 4: Scaffold Firefox extension and backend health check flow

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/src/background/main.js`
- Create: `extension/src/backend/client.js`
- Create: `extension/src/popup/popup.html`
- Create: `extension/src/popup/popup.js`
- Create: `extension/src/shared/contracts.js`

**Interfaces:**
- Produces: `checkBackendHealth() -> Promise<{status:string,service:string}>`
- Produces: popup-triggered message `tab-organizer/start`

- [ ] Write a small contract/validation test or harness for backend health parsing
- [ ] Verify the test/harness fails or the extension cannot yet call the backend
- [ ] Implement manifest, popup, background, and backend client
- [ ] Manually verify popup health check works against the backend

### Task 5: Implement tab collection and plan request flow

**Files:**
- Create: `extension/src/browser/collectTabs.js`
- Modify: `extension/src/background/main.js`
- Modify: `extension/src/backend/client.js`
- Modify: `extension/src/shared/contracts.js`

**Interfaces:**
- Produces: `collectTabsSnapshot() -> Promise<GroupingRequest>`
- Produces: `generateGroupingPlan(payload) -> Promise<GroupingPlan>`

- [ ] Write a failing test or executable fixture for request normalization
- [ ] Verify it fails
- [ ] Implement tab collection and generation request flow
- [ ] Verify normalized payload generation and backend request succeed

### Task 6: Build review page and approval flow

**Files:**
- Create: `extension/src/review/review.html`
- Create: `extension/src/review/review.js`
- Create: `extension/src/review/review.css`
- Modify: `extension/src/background/main.js`
- Create: `extension/src/shared/state.js`

**Interfaces:**
- Produces: runtime state storage for latest snapshot/plan
- Produces: review actions `approve`, `cancel`, `refresh`

- [ ] Write a failing rendering/state test or manual review-page checklist
- [ ] Verify the current UI does not satisfy it
- [ ] Implement review page and background messaging
- [ ] Verify the review page displays plans and actions correctly

### Task 7: Add STG external API for tab-organizer

**Files:**
- Modify: `/Users/mrietveld/Workspaces/coding-models/simple-tab-groups/addon/src/js/constants.js`
- Modify: `/Users/mrietveld/Workspaces/coding-models/simple-tab-groups/addon/src/background.js`
- Possibly create: `/Users/mrietveld/Workspaces/coding-models/simple-tab-groups/addon/src/js/tab-organizer-external.js`

**Interfaces:**
- Produces: external STG action `tab-organizer-apply-grouping-plan`
- Consumes: payload `{ groups: [{ name, tabIds[] }] }`
- Produces: result `{ ok, createdGroups, movedTabs, errors }`

- [ ] Write a failing STG-level manual or automated check for unknown sender and valid plan application
- [ ] Verify it fails before the change
- [ ] Implement whitelist entry and narrow external handler
- [ ] Verify STG can create groups and move exact tab IDs for trusted sender only

### Task 8: Connect extension approval flow to STG and verify end-to-end

**Files:**
- Create: `extension/src/stg/client.js`
- Modify: `extension/src/background/main.js`
- Modify: `extension/src/review/review.js`
- Modify: `extension/src/shared/contracts.js`
- Optionally create: `README.md`

**Interfaces:**
- Produces: `applyGroupingPlanInStg(plan) -> Promise<ApplyResult>`

- [ ] Write a failing manual end-to-end checklist for approve/apply flow
- [ ] Verify it fails before wiring STG
- [ ] Implement STG client and approval integration
- [ ] Run backend tests, rebuild STG if needed, and perform manual end-to-end verification

# Backend Functionality Summary

This document summarizes the current behavior and responsibilities of the Tab Organizer backend service.

## Overview

The backend is a FastAPI-based HTTP service that runs locally on `127.0.0.1` (default port `5050`). Its primary role is to accept normalized browser tab snapshots from the Firefox extension, call an LLM to propose tab groupings, enforce strict validation rules, and return a safe, executable grouping plan. It also centralizes configuration and logging for observability.

## Application Setup

- Entry point: `backend/app/main.py`
- Framework: FastAPI
- CORS: Allows requests from Firefox `moz-extension://*` origins only.
- Logging: Configured via `app.core.logging_setup.configure_logging`, writing to `backend/logs/tab_organizer_backend.log`.
- Configuration: Loaded via `app.core.config.get_settings`, reading environment variables and an optional `.env.local` file.

On startup, `create_app`:
- Loads settings (host, port, log directory, LLM API details).
- Configures a namespaced logger (`tab_organizer`).
- Sets up CORS for the extension.
- Creates an `LlmClient` instance using configured model, API key, base URL, and timeout.
- Creates a `GroupingService` instance bound to the LLM client.
- Registers API routes via `create_router`.
- Registers global exception handlers for LLM-specific failures and unexpected errors.

## API Surface

### `GET /health`

Implemented in `app.api.routes.create_router`.

- Logs a "Health check OK" message.
- Returns a static payload:
  ```json
  { "status": "ok", "service": "tab-organizer-backend" }
  ```
- Used by the extension to verify backend availability and identity.

### `POST /api/groupings/generate`

- Accepts a `GroupingRequest` body (Pydantic model) containing:
  - `requestId`: client-generated identifier
  - `capturedAt`: ISO timestamp
  - `constraints`: `GroupingConstraints` (min group size, grouping basis)
  - `tabs`: list of `BrowserTab` records (tab id, window id, title, URL, and state flags)
- Logs the request id and tab count.
- Delegates to `GroupingService.generate_grouping_plan`.
- On successful validation, returns a `GroupingPlan` model:
  - `planId`, `requestId`, `summary`
  - `groups`: array of `GroupingPlanGroup` (group id, name, reason, tab ids)
  - `ungroupedTabIds`: tabs left unassigned
  - `warnings`: human-readable notes
- On validation errors (`ValueError`), responds with HTTP 422 and a structured `ErrorDetail` payload.

## Core Models

Defined in `app.api.schemas` using Pydantic:

- `GroupingConstraints`: minimum group size (default 5), grouping basis description.
- `BrowserTab`: normalized tab information from the extension.
- `GroupingRequest`: top-level request schema.
- `GroupingPlanGroup`: group id, name, reason, and tab id list.
- `GroupingPlan`: complete grouping plan returned to the extension.
- `ErrorDetail`: standard error code + message payload used for 4xx responses.

## Grouping Service and Chunked Algorithm

Implemented in `app.services.grouping_service.GroupingService`.

### High-level behavior

`generate_grouping_plan` is responsible for orchestrating chunked LLM calls, merging results, enforcing constraints, and producing the final plan:

1. Logs receipt of the request and total tab count.
2. Builds a lookup of all tabs by id.
3. Initializes:
   - `existing_groups`: groups accumulated across chunks/passes.
   - `pending_tabs`: tabs still needing grouping.
   - `warnings`, `summary_parts`, and `plan_id` accumulator.
4. Repeatedly processes `pending_tabs` in passes until the remaining ungrouped set is small.

### Chunked processing

- Tabs are split into chunks of up to `MAX_CHUNK_SIZE` (32 tabs).
- For each pass:
  - Logs pass number, pending tab count, and number of chunks.
  - For each chunk:
    - Creates a `chunk_request` with only the chunk’s tabs.
    - Logs chunk size and existing group count.
    - Calls `_call_llm_client(chunk_request, existing_groups)` to obtain a raw plan dict.
    - Ensures a stable `planId` across chunks and sets `requestId`.
    - Validates the raw dict into a `GroupingPlan` model.
    - Calls `_validate_chunk_plan` to enforce constraints relative to the subset of tabs and previously known groups.
    - Merges new groups into `existing_groups`, keyed by `groupId`, letting later chunks overwrite groups with the same id.
    - Figures out which tabs from the current chunk were left ungrouped and carries them forward into `next_pending_tabs`.
    - Collects per-chunk summaries and warnings.
- After all chunks in a pass:
  - If `next_pending_tabs` is larger than `MAX_UNGROUPED_RETRY_SIZE` (10), logs a retry message and starts another pass using only those tabs.
  - If 10 or fewer tabs remain, the loop exits and they are treated as final ungrouped tabs.

### Final plan construction

After chunked processing completes:

- Computes `final_ungrouped_ids` from remaining `pending_tabs`.
- Appends a warning if any tabs remain ungrouped.
- Builds a `GroupingPlan` with:
  - `planId` (stable across chunks or a new UUID),
  - the original `requestId`,
  - a merged `summary` built from unique `summary_parts`,
  - the accumulated `existing_groups`,
  - `ungroupedTabIds`,
  - aggregated `warnings`.
- Calls `validate_grouping_plan` one last time against the original request to enforce global invariants.
- Logs success and returns the validated plan.

### LLM integration

`_call_llm_client` adapts to different `LlmClient.generate_grouping` signatures by introspecting parameters. If the client supports an `existing_groups` argument, it is passed; otherwise only the `request` is provided.

The LLM client (`app.services.llm_client.LlmClient`):

- Requires a configured API key; otherwise raises `LlmClientError`.
- Uses `build_grouping_prompt` to construct a natural language description of the task and tabs, optionally including existing groups.
- Issues a POST request to `<base_url>/chat/completions` with an OpenAI-style JSON body, requesting `json_object` output.
- On network/HTTP errors, raises `LlmClientError` with context.
- Parses the chat completion JSON payload and attempts to decode the `content` field as JSON.
- Raises `LlmClientError` if the content is missing, empty, or not valid JSON.

Global FastAPI exception handlers translate `LlmClientError` exceptions into HTTP 502 responses with a structured detail object.

### Prompt construction

`app.services.prompt_builder.build_grouping_prompt`:

- Describes the grouping task and minimum group size.
- Instructs the model to return strict JSON containing `planId`, `requestId`, `summary`, `groups`, `ungroupedTabIds`, and `warnings`.
- Optionally lists existing groups (with id, name, reason, and tab ids) to preserve or extend.
- Enumerates all tabs in the current request chunk with id, title, and URL.

## Validation Rules

Implemented in `app.services.validator.validate_grouping_plan`:

- Every group must contain at least `constraints.minimumGroupSize` tabs.
- Each group must have a non-empty `name` and `reason` (whitespace-only values are rejected).
- All tab ids referenced in group assignments must exist in the request’s tab list.
- No tab id may appear in more than one group (duplicates cause a validation error).
- `plan.ungroupedTabIds` must refer only to known tab ids.

Validation is used both on per-chunk plans (with an adjusted request that reflects allowed tab ids) and on the final merged plan.

## Configuration and Logging

- `app.core.config.Settings` defines runtime configuration: host, port, log directory, service name, LLM API key, model name, base URL, and timeout.
- `get_settings` reads from environment variables or an optional `.env.local` file (path configurable via `TAB_ORGANIZER_ENV_FILE`).
- `configure_logging` ensures the log directory exists, sets up a file handler, and writes INFO-level logs for the `tab_organizer` logger only.

## Error Handling Behavior

- LLM client failures (network issues, missing API key, malformed responses) produce HTTP 502 errors with `LLM_REQUEST_FAILED` codes.
- Validation failures in grouping plans produce HTTP 422 errors with `PLAN_VALIDATION_FAILED` codes.
- Any other uncaught exceptions are logged and surfaced as HTTP 500 responses with a generic `INTERNAL_ERROR` message.

This backend provides a strict, logged, and validated boundary between the browser extension and the LLM, ensuring that only safe, well-formed grouping plans are returned to the extension for user review and application.
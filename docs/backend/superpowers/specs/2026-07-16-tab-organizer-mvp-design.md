# Tab Organizer MVP Design

## Summary
Build a Firefox WebExtension that collects tab data, sends it to a local Python backend running on `localhost`, shows a proposed grouping plan to the user, and applies the approved plan through a modified Simple Tab Groups (STG) extension.

## Goals
- Collect current Firefox tabs from the browser session.
- Send a normalized tab snapshot to a locally running Python backend.
- Have the backend call an LLM to propose groups of at least 5 tabs based on a common theme or task.
- Show the proposal in an extension review page.
- Apply the approved grouping through STG.
- Log backend activity to local files in a `logs/` directory.

## Non-Goals
- No AI, clustering, or grouping logic in the Firefox extension.
- No direct browser automation from the Python backend.
- No auto-apply without explicit user approval.
- No persistent database for MVP state.

## Architecture
The MVP contains three parts:

1. **Tab Organizer Firefox extension**
   - Collects tabs from Firefox.
   - Calls the local backend over HTTP.
   - Displays current tabs and proposed groups.
   - Applies approved plans by sending a narrow external message to STG.

2. **Local Python backend**
   - Long-running process started manually by the user.
   - Exposes `GET /health` and `POST /api/groupings/generate` on `127.0.0.1`.
   - Builds prompts, calls the LLM, validates model output, and returns a strict grouping plan.
   - Logs startup, request handling, validation, and errors to `backend/logs/tab_organizer_backend.log`.

3. **Modified Simple Tab Groups extension**
   - Adds a narrow external API for the trusted `tab-organizer` extension.
   - Supports exact creation of new STG groups and exact tab-to-group assignment from an approved plan.
   - Rejects unknown senders and malformed requests.

## Data Flow
1. User clicks the extension action.
2. Extension checks backend health.
3. Extension collects tabs and normalizes a snapshot.
4. Extension sends the snapshot to `POST /api/groupings/generate`.
5. Backend logs the request, builds a prompt, calls the LLM, validates the result, and returns a grouping plan.
6. Extension displays the plan in a review page.
7. User approves the plan.
8. Extension sends the approved plan to STG through external messaging.
9. STG creates groups and moves tabs.
10. Extension shows the final result.

## API Contract
### `GET /health`
Returns:
```json
{
  "status": "ok",
  "service": "tab-organizer-backend"
}
```

### `POST /api/groupings/generate`
Request:
```json
{
  "requestId": "req-123",
  "capturedAt": "2026-07-16T10:00:00Z",
  "constraints": {
    "minimumGroupSize": 5,
    "groupingBasis": "common theme or task"
  },
  "tabs": [
    {
      "tabId": 101,
      "windowId": 1,
      "title": "FastAPI Tutorial",
      "url": "https://example.com/fastapi",
      "active": false,
      "pinned": false,
      "audible": false,
      "discarded": false
    }
  ]
}
```

Response:
```json
{
  "planId": "plan-456",
  "requestId": "req-123",
  "summary": "Grouped tabs into work-related clusters.",
  "groups": [
    {
      "groupId": "group-1",
      "name": "Python Backend Work",
      "reason": "These tabs relate to backend development tasks.",
      "tabIds": [101, 102, 103, 104, 105]
    }
  ],
  "ungroupedTabIds": [120],
  "warnings": [
    "1 tab was left ungrouped because it did not fit a 5-tab minimum group."
  ]
}
```

## Validation Rules
The backend must reject invalid plans. A valid plan guarantees:
- every referenced `tabId` exists in the request
- no `tabId` appears in more than one group
- every group has at least 5 tabs
- every group has a non-empty name
- every group has a non-empty reason

The extension must also validate the response defensively before showing or applying it.

## Security Constraints
- Backend binds to `127.0.0.1` only.
- Extension host permissions are restricted to the chosen localhost origin.
- STG only trusts the configured tab-organizer extension ID.
- Model output is never applied directly; only validated, user-approved plans are executable.
- Backend logs summary metadata, not full tab content by default.

## MVP Components
### Tab Organizer extension
- `manifest.json`
- background workflow script
- tab collector
- backend HTTP client
- popup
- review page
- shared contract validation
- STG client

### Python backend
- FastAPI app entrypoint
- API routes and Pydantic schemas
- prompt builder
- LLM client
- grouping validator
- logging setup
- config module

### STG changes
- whitelist entry for `tab-organizer`
- external action handler for applying a grouping plan
- structured response describing created groups and moved tabs

## Error Handling
The system must fail safely:
- backend unavailable => show message, do not continue
- invalid backend response => reject and show error
- STG unavailable or apply failure => show exact error/result, do not claim success
- no tabs are modified unless a validated plan is explicitly approved

## Testing Strategy
- Backend unit tests for validation, prompt building, and logging setup
- Backend API tests using FastAPI test client with mocked LLM responses
- Pure extension module tests for response validation and plan normalization
- Manual Firefox integration tests for full extension and STG flow

## Implementation Order
1. Backend tests and skeleton
2. Extension skeleton and backend health check
3. Tab collection and request contract
4. Backend grouping service and LLM integration
5. Review page
6. STG external API and apply flow
7. End-to-end manual verification

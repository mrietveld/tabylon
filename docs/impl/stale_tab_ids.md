# Design: remove stale tab IDs from backend caches

**Status: proposal; not implemented.**

## Recommendation

Use **the tab IDs in `request.tabs` as the authoritative cache set** for the requesting browser session. Assume every cached tab ID not included in the grouping request is stale, and remove it before generating the plan. Do not collect or transmit a separate live-tab inventory.

Namespace both caches by an opaque browser-session ID and store embedding tab IDs explicitly. Delete embeddings for omitted IDs and delete whole cached labels containing any omitted ID. Expire inactive sessions after **seven days**, with cleanup at backend startup and on subsequent requests.

This intentionally treats “stale” as **absent from the grouping request**, not necessarily closed in Firefox. Selected-tab and current-window requests evict cached entries for omitted tabs, including tabs still open in other windows. Those entries can be regenerated if a later request includes them. Cleanup affects caches only; it never closes or moves browser tabs.

## Current behavior and constraints

- [Grouping requests](../../backend/app/api/schemas.py) contain scoped `tabs`, `requestId`, `capturedAt`, and grouping constraints. There is no browser/session namespace.
- The [add-on background](../../addon/src/background.js#L80-L98) queries `browser.tabs.query({})`. The [workflow](../../addon/src/js/organizer/index.js#L390-L406) passes that result through [scope/eligibility filtering](../../addon/src/js/organizer/snapshot.js#L28-L85). The HTTP client sends only the filtered tabs. **Keep that selection behavior:** the filtered request is the cleanup authority.
- [Embeddings](../../backend/app/services/embedding_store.py) have an opaque SHA-256 `tab_key`, content hash, timestamp, and vector. The [key](../../backend/app/services/grouping_service.py#L525-L527) hashes the tab ID together with normalized title/URL text. A stored key cannot be decoded to discover its tab ID; changed text also creates another row rather than replacing the old version.
- [Cached labels](../../backend/app/services/cluster_label_store.py) retain tab IDs in JSON and reuse names/reasons based on ID-set similarity. Neither cache deletes records or isolates browser sessions.
- Both stores use shared SQLite connections with `check_same_thread=False`. The grouping route is synchronous, and the add-on can start overlapping generations. Cleanup must not race with an older request writing its results afterward.
- [Session storage](../../addon/src/js/organizer/draft-store.js) is already used by the add-on. Cache identity must be kept separately from draft state, so clearing a draft does not rotate the cache namespace.

See [the multiple-window evaluation](../eval/multiple_windows.md) for the existing request/window boundary. The current source, not the older architecture descriptions, is the implementation baseline.

### What counts as stale?

1. **Omitted tab ID:** an ID previously cached for this session is absent from the latest accepted grouping request's `tabs`.
2. **Retired session:** no grouping request has been accepted for seven days. Eviction is allowed even if its browser still has open tabs; caches are disposable, and later grouping regenerates them.
3. **Old embedding content version:** a submitted tab's normalized text has a different hash. Keep only its latest cached vector.

An omitted ID is stale regardless of why it was omitted: tab closure, another window, selection scope, existing group membership, pinning, or temporary ineligibility. Conversely, a tab that changes window but remains in the request retains its cache identity. No window-specific cache partitions are needed.

## Request contract

Keep the existing `tabs` payload and extend `POST /api/groupings/generate` with two required fields for cache isolation and ordering:

```json
{
  "requestId": "req-uuid",
  "capturedAt": "2026-10-27T12:00:00Z",
  "cacheSessionId": "ed03edcc-b848-4b1d-932a-14208c9b0219",
  "requestSeq": 12,
  "constraints": {
    "minimumGroupSize": 5,
    "groupingBasis": "common theme or task"
  },
  "tabs": [
    {
      "tabId": 101,
      "windowId": 10,
      "title": "Selected tab",
      "url": "https://example.test/",
      "active": false,
      "pinned": false,
      "audible": false,
      "discarded": false
    }
  ]
}
```

Derive the retained ID set in the backend:

```python
req_ids = {tab.tabId for tab in request.tabs}
```

- `tabs` is both the cleanup authority and the input to embedding/clustering/model calls. Do not add `liveTabIds`, infer additional IDs from windows, or use the unfiltered browser query to preserve omitted cache entries.
- `cacheSessionId` is a random UUID shared by all windows in one extension session. Persist it in a dedicated `browser.storage.session` key alongside the next request sequence. Reuse it across background reloads when that storage survives; generate a new ID whenever the key is absent. Rotation after extension reload/update is safe, even if more frequent than browser restart.
- `requestSeq` is a strictly increasing positive integer within that session. Allocate the sequence and capture the grouping snapshot in one short serialized background operation. Release that operation before HTTP/model work, allowing a later generation to capture a newer request. Persist sequence allocation before sending; gaps from failed requests are harmless.
- An explicit `tabs: []` is authoritative and clears all tab-dependent cache rows for this session, even if Firefox has open tabs outside the chosen scope. A missing `tabs` field or a local collection error must not be converted into an empty request.

Do not use `capturedAt` to order requests: timestamps are caller-controlled and clocks can jump. Do not derive identity from `windowId` or the `moz-extension://` origin: moving a tab must preserve its cache identity, and the origin is not a reliable browser-run namespace.

### Boundary validation

Validate before any deletion or session timestamp update:

- Valid UUID session ID; positive, JavaScript-safe integer sequence.
- Unique, nonnegative, JavaScript-safe integer tab IDs in `tabs`.
- Required tab fields and grouping constraints, using the existing request schema.
- Enforce the existing add-on's 2,024 grouping-tab limit at the backend boundary too. Reject over-limit requests rather than truncating them.

Malformed input returns HTTP 422 without cache mutations. A sequence not newer than the session's last accepted sequence returns HTTP 409 with `STALE_GROUPING_REQUEST`; it must not delete, refresh, or write cache records. Generating again allocates a new sequence. An accepted request whose provider call fails has still consumed its sequence; an automatic retry of the whole request needs a new snapshot/sequence.

The response plan schema does not change. No inventory endpoint, full-browser completeness check, or extra tab-ID list is needed. Scoped requests are valid and deliberately evict omitted IDs. Collection failures and local snapshot-limit failures that prevent transmission simply postpone reconciliation.

## Cache schema

Keep the existing two database files. Do not add a third database, ORM, normalized cluster-member tables, or a new cache manager hierarchy.

### Embedding database

Replace `tab_embeddings` with:

```sql
CREATE TABLE tab_embeddings (
  session_id TEXT NOT NULL,
  tab_id INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  PRIMARY KEY (session_id, tab_id)
);

CREATE TABLE cache_sessions (
  session_id TEXT PRIMARY KEY,
  request_seq INTEGER NOT NULL,
  last_seen TEXT NOT NULL
);
```

One embedding row per submitted tab per session is enough. Look up by session and tab ID, require the current text hash to match, and upsert the row after a successful embedding call. A failed call must not make an old vector valid for new text.

Use tab IDs directly in the service's embedding maps instead of opaque tab keys. Preserve title/URL normalization, Unicode sanitization, batch size, per-batch persistence, retry behavior, and vector-to-tab alignment. Remove `_build_tab_key` once its callers are replaced. The primary key provides the index needed for session-specific lookup/deletion; no window column is needed.

`cache_sessions` is the single source for accepted sequence and activity. Its timestamp is backend SQLite UTC time, refreshed on an accepted grouping request even if it uses only cached entries or groups no tabs. Embedding `updated_at` is not a reliable session-activity timestamp.

### Label database

Keep the current `cluster_labels` columns, add a required `session_id`, and index that column. Limit all label lookup, save, and cleanup operations to a session.

Parse membership using the existing Python `json` library. If **any** member ID is absent from `req_ids`, delete that label row entirely. Do not subtract omitted IDs and retain the old description: that silently turns a label for one cluster into a label for another. Corrupt or empty membership rows should also be removed rather than reused.

Preserve the existing 90% similarity rule for surviving labels. This proposal removes stale IDs; it does **not** make labels content-aware. A submitted tab navigating with the same ID can still contribute to reuse of an outdated label. That separate invalidation problem is explicitly deferred, not solved by ID cleanup.

## Reconciliation and request ordering

Use one `threading.Lock` at the service boundary around **the full cache-backed generation**, including cleanup, reads, provider work, and writes. Use the same lock for startup expiry if startup and requests can overlap. Stores remain small synchronous helpers; do not hold a SQLite transaction during network calls.

The initial deployment contract is **one backend process/Uvicorn worker** for a pair of database paths. A process-local lock does not protect several workers or backend processes sharing those files. Do not claim multi-worker support; upgrading to conditional writes/transactions across processes is outside this first change.

For each valid request, under the lock:

1. Read its session checkpoint. Reject a stale/equal sequence before all mutation.
2. Identify inactive sessions using `cache_sessions.last_seen` and backend time. Delete their label rows, then embedding rows, then session metadata. Never prune another recently active session against this request's tab IDs. An expired session that reconnects starts with empty caches.
3. Derive `req_ids` directly from `request.tabs`. For the current session, delete embedding rows whose IDs are absent from that set. Query session rows and compute the difference in Python; delete stale IDs with parameterized `executemany`, avoiding a large dynamic `NOT IN` clause and SQLite placeholder limits. An empty set deletes every embedding row for that session.
4. Delete current-session label rows with invalid membership or any member outside `req_ids`. Never relabel or shrink them during cleanup.
5. After both stores' cleanup commits succeed, upsert the session's accepted sequence and `last_seen` checkpoint.
6. Generate the plan from `request.tabs`, using only this session's surviving caches. Cache writes retain the session namespace and contain only IDs from this request. For `tabs=[]`, return the existing empty plan **after**, not before, reconciliation.

Run expiry at backend startup as well, without treating every surviving session as stale. There is no periodic sweeper in the first version: omitted IDs disappear on the next accepted grouping request; abandoned sessions disappear on the first startup/request after their inactivity deadline, not exactly seven days after shutdown.

### Why the ordering matters

A generation with sequence 12 can still be running when the add-on captures sequence 13 with fewer selected tabs. Holding the lock for all of sequence 12 lets it finish writing before sequence 13 prunes omitted IDs. If 13 arrives first, 12 is rejected afterward. Locking only cleanup would let a slow old model call reinsert a deleted ID.

The add-on's existing draft-state serialization is not sufficient: it guards state updates, not the entire HTTP generation. The backend must enforce this rule independently.

If a tab closes after capture but during model generation, its ID may remain cached because it was included in the request. Cleanup waits until a later accepted request omits it or the session expires. This design does not independently discover tab closure. Existing add-on preflight continues to protect plan application.

### Failure behavior

Each database cleanup uses its own transaction. These are caches, so cross-database atomicity is unnecessary: partial eviction only causes misses, not loss of user tab/group data.

- If cleanup fails in either database, abort before grouping/cache writes and do not advance the session checkpoint. Log the failure and return a backend error. A retry or new request repeats the idempotent deletions.
- If the process crashes between store cleanup and checkpoint persistence, reconciliation repeats safely on restart. If it crashes after the checkpoint, retry with a newer sequence.
- If model generation fails after cleanup, retain successful per-batch writes and the accepted checkpoint, matching the existing embedding retry/persistence behavior. **Omitted cache entries remain evicted even though no plan was produced.**
- Never swallow a cleanup error and then use cache entries that should have been removed.

Expiry removes the session checkpoint last so partial failures leave the identity available for another expiry attempt. There is no browser-tab close/move/delete action anywhere in this procedure.

## Migration and compatibility

Old embedding keys cannot be mapped reliably back to tab IDs, and old labels have no session ownership. Do not guess a session, brute-force old hashes, or assign legacy rows to whichever browser connects first.

At startup, migrate each cache database transactionally using SQLite schema versioning (`PRAGMA user_version`): drop/recreate **only the affected cache tables**, create the new schema/index, then commit the version. Unrelated tables and files must remain untouched. Abort startup on migration failure; never partially reinterpret old rows as the new schema.

This deliberately discards legacy embeddings and cached label suggestions. Firefox tabs, STG groups, approved group names, and drafts are unaffected. The cost is a cold cache and new embedding/labeling provider calls. If those calls fail, surface the normal provider error; there is no fallback to unsafe legacy identity.

Deploy the add-on session/sequence wire change and backend change together. Old clients missing the required fields receive 422; missing `tabs` must never mean “delete everything,” whereas an explicit empty list does. Avoid a permanent legacy mode or optional destructive defaults. If an old backend ignores the new extra fields, it also will not perform this cleanup; do not describe that combination as providing the new guarantee. Stop old backend processes before opening the migrated database files.

## Implementation reach

| File/component | Required change |
| --- | --- |
| `addon/src/js/organizer/index.js` | Persist session/sequence independently of drafts; serialize grouping snapshot capture/allocation, not provider calls. |
| `addon/src/js/organizer/snapshot.js` | No separate inventory change; retain existing scope/eligibility filtering. |
| `addon/src/js/organizer/client.js` | Send session/sequence alongside the existing scoped `tabs` payload. |
| `backend/app/api/schemas.py` | Require session/sequence and validate tab IDs and the destructive boundary invariants. |
| `backend/app/api/routes.py` | Map stale requests to 409 rather than the existing plan-validation 422. |
| `backend/app/main.py` | Run cache migration/expiry at startup; wire the one-process generation lock. |
| `backend/app/services/grouping_service.py` | Derive retained IDs from `request.tabs`; reconcile before the empty-tab return; use session/tab-ID caches; serialize all reads and writes. |
| `backend/app/services/embedding_store.py` | Migrate schema; session-scoped lookup/upsert/pruning; maintain session checkpoints and expiry candidates. |
| `backend/app/services/cluster_label_store.py` | Migrate schema; filter by session; delete stale-membership labels and expired-session rows. |
| Backend/add-on tests and fixtures | Extend session/sequence wire fixtures and fake store signatures; add cleanup, scope, migration, and ordering checks. |

No clustering thresholds, window placement, labeling prompt, or grouping-plan exports need to change. No new dependency is needed: use `sqlite3`, `json`, `threading`, and the project's existing Pydantic and WebExtension storage patterns.

## Acceptance tests

Use temporary SQLite databases, existing test patterns, mocked providers, and controlled thread events for concurrency; do not require real Firefox/provider data for backend tests.

1. **Omitted ID:** cache IDs 1, 2, 3; submit tabs with IDs `[1, 3]`. Remove embedding 2 and labels containing 2; preserve rows whose IDs remain included. Repeat with a newer sequence without further deletions.
2. **Scopes/windows:** cache tabs from two windows, then submit only selected tab 1. Evict every omitted ID in this session, even if still open in another window or excluded by eligibility rules. A window-only change preserves a cache hit when the tab remains included.
3. **Empty request:** `tabs=[]` clears this session's embeddings and labels and returns the normal empty plan. Missing/malformed `tabs` and local collection failures cause no request-driven cleanup.
4. **Session isolation:** two sessions contain numeric ID 1 with different vectors/labels. Lookup and request-driven pruning in A never read or delete B. A new browser session misses old labels even when all numeric IDs overlap.
5. **Embedding replacement:** unchanged text hits; changed text misses and replaces the same session/tab row only after successful embedding. No historical-content rows accumulate.
6. **Label cleanup:** remove whole rows containing omitted IDs, malformed JSON, or empty membership. Keep valid rows whose members are all in `req_ids`; do not rewrite names/reasons.
7. **Expiry:** use explicit backend-time test values; an inactive session is removed from both stores and metadata, a refreshed session survives, and a dormant browser regenerates on reconnect. Startup expiry does not clear fresh sessions.
8. **Out-of-order/in-flight:** use a blocked fake provider. Verify newer cleanup cannot run before the old writer finishes, a late older request receives 409, and no deleted ID is reinserted. Duplicate sequences perform no writes or timestamp refresh.
9. **Failure recovery:** force the second database cleanup to fail. No model call/checkpoint advancement occurs; the next reconciliation safely completes. A provider failure preserves completed cleanup and successful embedding batches, without restoring omitted rows.
10. **Migration:** open legacy fixtures and verify only cache tables are reset, new keys/namespaces work, migration is repeatable, and old clients fail without request-driven deletion.
11. **Wire/validation:** no separate tab inventory is sent; invalid/duplicate/over-limit tab IDs are rejected; providers see only request titles/URLs; returned assignments remain restricted to request tabs.
12. **Scope switching:** send request IDs `[1, 2]`, then `[3]`, then `[1, 2]`. The last request must regenerate the evicted entries rather than reuse the first request's cache rows.

## Trade-offs and deferred work

- **Scoped requests intentionally evict still-open tabs.** Alternating selections, groups, or windows can cause repeated embedding/labeling calls and less stable suggested labels. This follows the requested assumption; preserving omitted tabs would require a different cleanup authority.
- Closing a tab while the organizer is unused is not reported immediately. Cleanup waits for a request omitting its ID or session expiry triggered by startup/traffic. No tab-event streaming is proposed.
- The full-request lock serializes model latency across clients. That is acceptable for the existing small local service; use generation-aware conditional writes before supporting parallel workers.
- Keeping only one embedding version per tab sacrifices reuse when navigating back. Deleting whole labels after a member is omitted sacrifices some label-cache hits. Both are deliberate correctness/simplicity choices.
- This removes stale logical rows, not necessarily SQLite file space. Ordinary deletion allows page reuse but is not secure erasure or an automatic `VACUUM` policy.
- A random session ID is a namespace, **not authentication**. The current CORS rule is not access control. This design assumes the existing local-service trust boundary; remote/untrusted deployments need authentication and rate limits before exposing destructive cache operations.
- Sequence replay protection lasts while the session checkpoint exists. Expiry removes it, so a very late request arriving after that session has been fully evicted can establish the namespace again. Permanent replay protection would require retained tombstones; do not add them for the existing short-lived local HTTP workflow.
- Content-aware label invalidation, provider/model versioning, duplicate-label compaction, configurable retention, and immediate removal of every old browser session are separate changes.

**Expected outcome:** after each accepted grouping request is reconciled, this session's persisted embeddings and label memberships contain only IDs included in `request.tabs`. Other sessions are isolated from that request's retained-ID set and expire independently. Tabs omitted by scope are treated as stale even if still open; included tabs can still have stale label text until content-aware invalidation is implemented.

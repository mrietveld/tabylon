# Multiple-window evaluation: simple-tab-grouper backend

## Summary

**The backend accepts tabs from multiple Firefox windows, but treats every request as one window-independent clustering pool.** `windowId` is required input metadata, not a grouping constraint. A proposed group can contain tabs from several windows, and neither backend validation nor the response identifies a destination window or warns about cross-window membership.

This supports finding related tabs across windows. It does **not** implement “organize each window independently” or preserve the user's window layout. The add-on decides which tabs to submit, checks whether assigned tabs have changed since capture, and performs the actual moves. Its current move path can consolidate tabs into another window, even for a request originally restricted to one window.

The most consequential findings are:

1. Window boundaries do not constrain clustering or minimum group size.
2. Applying a plan delegates window placement to STG, rather than preserving source windows.
3. Clustering runs only while **more than 32 unique tab IDs with embeddings** remain in the request. A successfully processed request of 32 or fewer tabs produces no groups, regardless of how many windows it covers.
4. Persistent label caching uses tab IDs alone; window changes, navigation, and separate browser sessions/profiles are not part of its identity.
5. There is real multi-window fixture data, but no backend assertions establishing a window policy, and four existing clustering tests fail before exercising the service.

## Scope and evidence

Reviewed the application modules and Python tests under `backend/`, with a focused check of the add-on's snapshot, HTTP client, apply logic, and STG move path to establish the backend boundary. Findings describe source revision `9f8a2fec`; no runtime code was changed.

Evidence below distinguishes source-confirmed behavior, offline checks, and risks inferred from the implementation. No live Firefox or model-provider run was performed. Existing credentials, runtime databases, and logs were not inspected or used.

The older [backend functionality summary](../backend/backend-functionality-summary.md) describes chunked direct-LLM grouping. That is **not the current production path**: [application setup](../../backend/app/main.py#L34-L56) wires embedding generation, SQLite caches, HDBSCAN/KMeans clustering, and a separate labeling client. `LlmClient` and `prompt_builder.py` remain in the tree, but are not called by the current route/service wiring. Their prompt also omits window identity, so they do not supply a missing window policy.

## Data flow and responsibility

| Stage | Current handling of windows | Source |
| --- | --- | --- |
| Tab collection | The add-on queries tabs without a window filter, then filters the chosen scope locally. | [background.js:80–98](../../addon/src/background.js#L80-L98), [snapshot.js:28–85](../../addon/src/js/organizer/snapshot.js#L28-L85) |
| Snapshot | Retains each tab's `windowId` and a fingerprint containing tab ID, window ID, URL, and STG group ID. | [snapshot.js:88–107](../../addon/src/js/organizer/snapshot.js#L88-L107) |
| HTTP request | Sends one flat tab list, including `windowId`. Does not send scope, current window, original STG membership, or the fingerprint. | [client.js:77–100](../../addon/src/js/organizer/client.js#L77-L100) |
| Backend parsing | Requires an integer `windowId` on every `BrowserTab`; has no per-window constraints or request namespace for a browser/profile. | [schemas.py:6–26](../../backend/app/api/schemas.py#L6-L26) |
| Embeddings and clustering | Embeds title/URL text, associates vectors with tab IDs, and clusters the request-wide set. Window IDs are not read. | [grouping_service.py:51–187](../../backend/app/services/grouping_service.py#L51-L187) |
| Labeling | Supplies representative and other member titles, with no window information, to the labeling model. | [grouping_service.py:190–246](../../backend/app/services/grouping_service.py#L190-L246), [labeling_client.py:104–122](../../backend/app/services/labeling_client.py#L104-L122) |
| Backend response | Returns groups of tab IDs and a flat ungrouped list; no source-window mapping or target window. | [schemas.py:29–43](../../backend/app/api/schemas.py#L29-L43) |
| Validation and apply | Backend checks IDs and group validity. Add-on checks live window/URL/membership drift and creates/moves STG groups. | [validator.py](../../backend/app/services/validator.py), [apply-plan.js:53–99](../../addon/src/js/organizer/apply-plan.js#L53-L99), [apply-plan.js:337–404](../../addon/src/js/organizer/apply-plan.js#L337-L404) |

## Findings

### 1. `windowId` is accepted but not used to form groups

**Source-confirmed; cross-window membership also checked offline.**

In the backend application, `windowId` appears only in the `BrowserTab` schema. `generate_grouping_plan` builds normalized embedding text from the title and URL, indexes tabs by `tabId`, and feeds a single vector set to clustering. HDBSCAN receives only embedding vectors; the KMeans fallback likewise receives vectors from the same request-wide pool.

There is no partition by window, no window feature in the vector, no preference for keeping a group inside one window, and no post-clustering split by source window. `minimumGroupSize` applies to the entire cluster, not its membership within each window.

**Consequences:**

- A theme represented by three tabs in window A and two in window B can satisfy a minimum size of five as one cross-window group, provided clustering actually runs and accepts that cluster.
- Unrelated windows are not automatically merged: semantic clustering still decides membership. However, separating two tasks into different windows contributes no signal to that decision.
- Adding tabs from another window changes the clustering population and can change the grouping of tabs already present. Separate per-window requests are not equivalent to one combined request.
- Changing only `windowId` supplies no new input to the grouping algorithm. The backend does not intentionally change memberships because a tab moved windows.

Relevant code: [embedding construction](../../backend/app/services/grouping_service.py#L51-L71), [global clustering loop](../../backend/app/services/grouping_service.py#L145-L187), [HDBSCAN](../../backend/app/services/clusterer.py#L26-L41), [KMeans fallback](../../backend/app/services/grouping_service.py#L386-L463).

### 2. Scope isolation belongs to the add-on, not the backend

**Source-confirmed.**

The add-on's scopes have different selection behavior:

- `ungrouped-current-window`: restricts by `currentWindowId` and absence of STG membership.
- `current-group`: restricts by STG group ID, not by window ID.
- `selected`: accepts explicitly selected tab IDs across windows.
- `all`: accepts every tab passing the add-on's eligibility checks, across windows.

Pinned and unsupported tabs are excluded before transmission. The backend receives only the resulting flat snapshot. It cannot distinguish an `all` request from selected tabs or a single-window request; `GroupingRequest` has no scope or current-window field. State flags such as `active` and `pinned` are parsed but are not used by the grouping service to recover a window policy or enforce eligibility.

**Important boundary:** the backend clusters **only tabs in the current request**. Cached embeddings and labels do not cause it to pull additional tabs from other windows or previous requests into the plan. Sending two separate requests does not merge their memberships into one plan.

This also means choosing a narrow scope is currently the way to limit which windows' tab content is submitted to the configured service/model provider. Embedding requests contain normalized titles and URLs from all submitted windows; labeling requests contain member titles. The backend does not forward window IDs to those providers.

Relevant code: [scope filtering](../../addon/src/js/organizer/snapshot.js#L28-L85), [wire request](../../addon/src/js/organizer/client.js#L77-L100), [request schema](../../backend/app/api/schemas.py#L22-L26), [embedding client payload](../../backend/app/services/embedding_client.py#L37-L45).

### 3. The response permits cross-window groups but does not specify placement

**Source-confirmed; actual Firefox placement not exercised.**

`GroupingPlanGroup` contains `groupId`, `name`, `reason`, and `tabIds`. It does not say where the group should live. `ungroupedTabIds` is also global. Backend warnings cover ungrouped counts or unavailable embeddings, not mixed-window membership or expected moves.

The backend validator accepts a group spanning windows because it checks only minimum size, nonblank name/reason, known tab IDs, duplicate grouped assignments, and known ungrouped IDs. There is no window-consistency check.

On apply, the add-on:

1. Creates each STG group with `addGroup(null, [], name)`, i.e. without attaching it to a window.
2. Moves assigned tabs individually using `Tabs.move([tabId], groupId)`.
3. Lets STG select the destination: loaded group window, otherwise the first existing member's window, otherwise the last-focused normal window.

For a newly created empty group, the first move therefore falls back to the last-focused normal window. Later moves can use the group's existing tab as an anchor. The source snapshot's window ID is not passed as a placement instruction. STG physically calls `moveNative` with the resolved destination window and hides moved tabs when the group is unloaded.

**Consequences:** applying a mixed-window group can gather its members into one window. Even a plan generated from `ungrouped-current-window` is not a promise to keep tabs in that window: focus may have changed between capture and apply. This is an integration behavior, not a backend-issued relocation command. Final behavior can also depend on live STG state; it was not verified in Firefox.

Relevant code: [plan construction](../../backend/app/services/grouping_service.py#L257-L299), [validator](../../backend/app/services/validator.py), [group creation and moves](../../addon/src/js/organizer/apply-plan.js#L365-L404), [unattached group creation](../../addon/src/js/groups.js#L503-L551), [destination resolution and move](../../addon/src/js/tabs.js#L1244-L1343).

### 4. The 32-tab cutoff is global and can make window scopes behave very differently

**Source-confirmed; 32-tab case checked offline.**

Embedding generation batches missing texts in groups of 32. Those batches are a provider/transport detail, **not** separate clustering scopes. Afterward, vectors are assembled into one request-wide set.

The only clustering loop is:

```python
while len(ungrouped_ids) > 32:
```

There is no subsequent clustering pass for the small remainder. As a result:

- A successfully processed request of 32 or fewer unique tab IDs with embeddings returns no groups, even if the minimum group size is five and the themes are obvious. Embedding failures can still abort such a request before a plan is returned.
- A larger request stops attempting new clusters when the remaining set reaches 32 or fewer. That remainder is returned ungrouped.
- Two windows with 20 eligible tabs each cannot produce groups when submitted separately, but their combined 40-tab request enters the clustering loop and may produce groups.
- More than 32 tabs does not guarantee groups: cluster size, noise, and peeling rules still determine success.

The cutoff is independent of window count and `minimumGroupSize`. Splitting requests by window without addressing this existing cutoff would make small-window grouping ineffective. It can also incur embedding work for a request that will never attempt clustering.

Relevant code: [embedding batches](../../backend/app/services/grouping_service.py#L84-L108), [unique-ID set and loop](../../backend/app/services/grouping_service.py#L145-L187), [ungrouped result](../../backend/app/services/grouping_service.py#L277-L291).

### 5. Caches are shared across windows and requests, with different identity risks

**Source-confirmed; cache behavior checked offline.**

The application creates one embedding store and one cluster-label store for its configured database paths. Neither table has a window, browser, profile, or session column.

#### Embedding cache

The key is SHA-256 of `tabId:normalized_title_and_url`; a separate text hash is also stored and checked.

- Moving the same tab to another window does not invalidate its embedding. This is consistent with content-based clustering.
- Two tabs with identical normalized content but different tab IDs have different cache keys. Identical pages in two windows can therefore be embedded and stored separately; there is no content-only deduplication across tab IDs.
- Navigation/title changes alter the key, so unchanged IDs alone do not cause reuse of an old embedding for new content. This protects against the label-cache issue below at the embedding level.

#### Cluster-label cache

Labels are persisted with only a sorted JSON list of tab IDs, name, reason, and creation time. Lookup compares the current ID set with every saved set using Jaccard similarity; the service accepts a match at 90% or greater.

- Labels can be reused across requests and window moves. There is no per-window label namespace.
- Even if titles/URLs change, sufficiently similar ID membership can return an old label/reason without consulting the labeling model. The embedding and label caches have inconsistent content invalidation.
- If separate Firefox sessions/profiles using the same backend reuse sufficiently overlapping numeric IDs, labels can be incorrectly reused for unrelated tabs. This is a conditional identity risk, not evidence that ordinary windows in one Firefox session collide.
- Timestamps are stored but not used to expire labels; lookup does not verify content or client ownership.

These caches reuse vectors or descriptions, **not actual tab memberships**. A stale label cannot introduce a tab absent from the request, but it can misdescribe a newly computed cluster.

Relevant code: [shared setup](../../backend/app/main.py#L40-L56), [key builder](../../backend/app/services/grouping_service.py#L525-L527), [embedding schema/lookup](../../backend/app/services/embedding_store.py#L29-L58), [label schema and matching](../../backend/app/services/cluster_label_store.py#L22-L95), [service label reuse](../../backend/app/services/grouping_service.py#L195-L213).

### 6. Tab identity assumes request-wide uniqueness; duplicate input IDs are not rejected

**Source-confirmed; duplicate-input validator case checked offline.**

Backend dictionaries and sets use `tabId`, not `(windowId, tabId)`: `tab_keys`, `tab_by_id`, embedding index maps, `ungrouped_ids`, and final known-ID sets all rely on it. The request schema does not reject duplicate tab IDs. The validator's duplicate check concerns output assignments in groups, not duplicated input records.

Normal tabs from different windows in one Firefox session have distinct tab IDs, and the add-on's request/snapshot validation explicitly rejects duplicates. Thus the ordinary multi-window path does not need a composite key just because it covers several windows.

However, a malformed caller or a future caller combining separate browser/profile snapshots with overlapping IDs can overwrite lookup entries and collapse distinct input tabs into one ID. A backend plan containing a single ungrouped ID can pass validation against two input records bearing that ID. A window ID cannot resolve the ambiguity because it is absent from output identity as well.

This is an input-contract gap, not proof of a collision in the current add-on.

Relevant code: [tab key lookup](../../backend/app/services/grouping_service.py#L52-L71), [tab lookup](../../backend/app/services/grouping_service.py#L190), [final ID sets](../../backend/app/services/grouping_service.py#L277-L281), [backend validator](../../backend/app/services/validator.py), [add-on duplicate rejection](../../addon/src/js/organizer/contracts.js#L92-L128).

### 7. Window lifecycle safety and recovery are outside the backend

**Source-confirmed; add-on drift tests pass offline.**

The backend has no browser connection or window-event handlers. `capturedAt` is required as a string but is not used to expire a request; `requestId` is echoed rather than used to maintain a live window/session registry. A window closing or a tab moving while grouping runs does not update or cancel the backend's snapshot.

The add-on compensates for this separation: before applying assigned tabs, it compares their live presence, URL, window ID, and original STG membership with the captured fingerprint. Window changes or missing tabs cause preflight failure without mutations. Unassigned tabs are not part of this apply check.

This protects against snapshot drift at preflight, but is **not** a same-window grouping constraint: an unchanged tab can still be moved to another window by the accepted plan. Nor is preflight an atomic browser transaction; later failures use reconciliation and best-effort compensation.

Recovery records original group IDs and actual/recreated tab IDs. The production `restoreTabs` operation takes only tab IDs and an original group ID, not an original window. It refuses to restore originally ungrouped tabs. Consequently, a failed cross-window apply does not guarantee restoration of the original window layout; the code intentionally reports recovery details and retained groups instead of claiming full rollback.

Relevant code: [preflight](../../addon/src/js/organizer/apply-plan.js#L53-L99), [compensation](../../addon/src/js/organizer/apply-plan.js#L228-L294), [production restore operation](../../addon/src/background.js#L90-L97).

### 8. There is no per-window observability or backend test contract

**Source-confirmed; baseline tests run offline.**

Backend logs identify requests, tab counts, batches, and clusters, but do not record window counts, per-window inputs/results, or groups spanning windows. The response likewise has no such diagnostics. That makes cross-window behavior hard to inspect without mapping returned IDs back to the add-on snapshot.

Most synthetic backend fixtures use only `windowId=1`. The real-data fixture is an exception: `backend/tests/test_data/real_tabs.csv` contains **889 tabs across five windows**:

| Window ID | Tab count |
| --- | ---: |
| 3 | 333 |
| 15 | 349 |
| 17 | 54 |
| 19 | 13 |
| 21 | 140 |

Its test reads those IDs but asserts only total group count and an empty ungrouped list. It does not assert cross-window membership, window preservation, destination choice, duplicate-ID handling, or label-cache isolation. It uses the configured embedding client/database rather than a fully isolated offline setup, so it was not executed for this review.

At the time of the initial review, all four tests in `test_chunked_grouping.py` constructed `GroupingService` with four arguments, although the current constructor requires five, including a cluster-label store. They failed with `TypeError` before testing grouping. Its 15-tab test also expected a group, contradicting the current 32-tab cutoff. These tests have since been updated: they pass separate embedding/label store arguments (using the same fake store) and the grouping test now uses 40 tabs so it exercises the current clustering loop.

The API success test does not stub the embedding provider and accepts HTTP 200, 422, or 502. Passing it is not evidence of successful multi-window grouping. Add-on snapshot/apply tests do cover cross-window selection and stale-window checks, but use fake operations rather than verifying physical Firefox window placement.

Relevant code: [clustering tests](../../backend/tests/test_chunked_grouping.py), [real-data test](../../backend/tests/test_chunked_grouping_real_data.py), [API test](../../backend/tests/test_generate_grouping.py#L16-L51), [add-on snapshot tests](../../addon/test/organizer-snapshot.test.mjs), [add-on apply tests](../../addon/test/organizer-apply-plan.test.mjs).

## Verification performed

### Existing backend tests, isolated from credentials and runtime data

From the repository root, ran:

```bash
tmp=$(mktemp -d)
cd backend
TAB_ORGANIZER_ENV_FILE=/dev/null \
TAB_ORGANIZER_LLM_API_KEY='' \
TAB_ORGANIZER_LOG_DIR="$tmp/logs" \
TAB_ORGANIZER_EMBEDDING_DB_PATH="$tmp/embed.sqlite3" \
TAB_ORGANIZER_CLUSTER_LABEL_DB_PATH="$tmp/labels.sqlite3" \
PYTHONDONTWRITEBYTECODE=1 \
.venv/bin/python -m pytest -q -p no:cacheprovider \
  --ignore=tests/test_chunked_grouping_real_data.py
```

**Initial review result: 20 passed, 4 failed.** All four failures were the constructor mismatch described above. After updating those tests, the same isolated backend suite was rerun and **24 passed, 0 failed**. No real provider calls were made; no existing runtime database was used.

### Focused offline service checks

Used the actual request/plan models, grouping service, validator, and SQLite stores in a temporary directory, with controlled embedding, clustering, and labeling callables. Assertions established:

| Check | Result |
| --- | --- |
| 40 tabs, alternating between windows 10 and 20, controlled four 10-tab clusters | All four returned groups span both windows; backend validation accepts them. |
| Same tabs/content/IDs, change every window ID to 99, repeat with the same temporary caches | Group memberships unchanged; no additional embedding or labeling calls. |
| 32 tabs from two windows | No clustering call; no groups; all 32 IDs returned ungrouped. |
| Identical embedding text, different tab IDs | Different embedding keys. |
| Saved label queried with the same tab-ID set | Cached label reused without content/window input. |
| Two input records with one tab ID and different window IDs; plan lists that ID once as ungrouped | Backend validator accepts the collapsed identity. |

The controlled-cluster check establishes orchestration and validation behavior, not how real semantic embeddings would cluster particular user tabs.

### Add-on boundary tests

From the repository root, ran:

```bash
node --test addon/test/organizer-snapshot.test.mjs \
  addon/test/organizer-client.test.mjs \
  addon/test/organizer-apply-plan.test.mjs
```

**Result: 38 passed, 0 failed**, including nested cases. These checks cover selection, the wire contract, drift detection, and mocked apply/recovery operations; they do not verify STG's real browser moves.

## Smallest next steps

These are recommendations, not changes implemented by this evaluation.

1. **Make the intended window policy explicit.** If cross-window thematic grouping is intended, document that applying can relocate tabs, and expose the expected placement in the review flow. If preserving each window is intended, partition grouping by `windowId` and ensure the apply path preserves/uses that window too. A backend-only partition is insufficient because STG chooses the destination independently.
2. **Address the small-request cutoff before relying on per-window requests.** Separate the 32-item embedding batch size from the decision to attempt clustering. Add an offline regression for a small, clearly clusterable request and its remainder.
3. **Repair and extend the existing offline tests.** Fix the current service construction, then assert the chosen policy on a two-window request, window-only changes, and small per-window versus combined requests. Add a real Firefox check for destination choice and failed cross-window recovery.
4. **Fix label identity/content invalidation.** Labels should not be reused for unrelated content just because numeric IDs overlap. A content-based membership fingerprint, or an explicit client/session namespace plus content invalidation, should match the supported deployment model. Add a regression for unchanged IDs with changed content.
5. **Enforce unique input tab IDs at the backend boundary.** Keep the current simple ID-based API for one browser snapshot, but reject ambiguous duplicate records. Only add a wider browser/profile identity if combining independent snapshots is actually required.

## Overall assessment

The backend is a **request-scoped, content-based clusterer that is agnostic to windows**, not a window-aware tab organizer. It can suggest groups spanning multiple windows and safely restrict returned IDs to the submitted snapshot, but it provides no guarantee about preserving window separation, physical placement, or restoration of the original layout. Those guarantees would require an explicit policy shared with the add-on.

Review limits: no live Firefox, model-provider, concurrent-request, or real-data integration run; existing baseline test failures were documented, not fixed. The main user-visible risk is cross-window relocation during apply, with no guarantee of full layout restoration after a failure.

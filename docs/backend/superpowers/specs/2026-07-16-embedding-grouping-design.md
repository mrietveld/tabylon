# Embedding-Based Tab Grouping Design

## Summary

Replace the current LLM-only grouping flow in the backend with an
embedding + clustering + labeling pipeline. The external API contract
(`POST /api/groupings/generate` → `GroupingPlan`) remains unchanged, but
the internal implementation of `GroupingService.generate_grouping_plan`
will:

1. Build normalized text for each tab (title + URL/domain).
2. Obtain embeddings for each tab from a configurable embedding model.
3. Cluster the embeddings with HDBSCAN using cosine-style similarity.
4. For each cluster, choose a representative tab and sample titles.
5. Use a separate LLM to generate a short human label and reason per
   cluster.
6. Construct a `GroupingPlan` where cluster members become group tab IDs.
7. Enforce existing validation rules (min group size, no duplicate tab
   IDs, only known tab IDs, valid ungrouped list).

The backend will talk to two different models:

- An **embedding model** for vectorizing tab text.
- A **labeling LLM** for naming clusters and explaining the grouping.

Both model clients are configured in a provider-agnostic way (base URL,
model name, API key, timeout) without assuming a specific vendor.

## Goals

- Scale grouping to ~1500 tabs per request.
- Make grouping primarily embedding/cluster-driven rather than
  free-form LLM output.
- Preserve the existing HTTP API contract and extension behavior.
- Detect and leave "noise" tabs ungrouped when they do not clearly
  belong to any cluster.
- Persist embeddings to avoid re-embedding unchanged tabs across
  requests.
- Keep validation strict and central in the backend.

## Non-Goals

- No clustering or embedding logic in the extension.
- No change to the browser extension API contract or UI flow.
- No external vector database; all persistence is local to the backend.
- No automatic merging/splitting of clusters by the LLM beyond
  generating labels (the LLM does not decide which tab goes in which
  cluster in the MVP).

## Architecture Changes

### Current

Today, `GroupingService.generate_grouping_plan` sends tab chunks through
an LLM using `LlmClient.generate_grouping`, validates the result, and
merges groups across chunks and passes. The LLM returns a complete
`GroupingPlan` structure per call.

### New

`GroupingService.generate_grouping_plan` will be rewritten to:

1. Use an **EmbeddingClient** to embed normalized tab text.
2. Use an **EmbeddingStore** to persist and cache embeddings across
   requests.
3. Use a **Clusterer** (HDBSCAN backed by NumPy / scikit-learn) to
   assign cluster labels.
4. Use a **LabelingClient** (LLM chat client) to generate `name` and
   `reason` for each cluster.
5. Assemble and validate the final `GroupingPlan`.

The previous chunked LLM grouping logic, including
`_call_llm_client` and chunked passes, will be removed from
`GroupingService.generate_grouping_plan`.

## Components

### 1. EmbeddingClient

**Responsibility:** talk to a remote embedding model in a
provider-agnostic way.

**Location:** `app/services/embedding_client.py`

**Interface (conceptual):**

```python
class EmbeddingClientError(Exception):
    ...

class EmbeddingClient:
    def __init__(self, api_key: str, model: str, base_url: str, timeout_seconds: float):
        ...

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one embedding vector per input text.

        Raises EmbeddingClientError on network or response issues.
        """
```

**Behavior:**

- Uses `httpx` under the hood with configurable `base_url`, `model`,
  and `api_key`.
- Expects a JSON response that contains a list of embedding vectors.
  The exact envelope will follow an OpenAI-style pattern but is not
  hard-coded to any vendor name (only generic field names are used).
- Raises `EmbeddingClientError` for:
  - HTTP/network errors.
  - Missing or malformed embedding data in the response.

### 2. EmbeddingStore

**Responsibility:** persist and retrieve embeddings for tab texts so we
only re-embed when the text changes.

**Location:** `app/services/embedding_store.py`

**Storage:** SQLite database on local disk, for example at
`backend/data/embeddings.sqlite3`.

**Schema (conceptual):**

```sql
CREATE TABLE IF NOT EXISTS tab_embeddings (
    tab_key TEXT PRIMARY KEY,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    embedding_json TEXT NOT NULL
);
```

Where:

- `tab_key`: a stable key derived from tab content, e.g.
  `hash("<normalized-title>|<normalized-url-domain>")`.
- `text_hash`: a hash of the embedding text used for this tab; if the
  text changes, the hash changes, forcing re-embedding.
- `updated_at`: ISO timestamp of last embedding update.
- `embedding_json`: JSON-encoded list of floats.

**Interface (conceptual):**

```python
class EmbeddingStore:
    def __init__(self, db_path: Path):
        ...

    def get_cached_embeddings(self, keys_and_hashes: dict[str, str]) -> dict[str, list[float]]:
        """Return embeddings for keys where the stored text_hash matches.

        Keys whose text_hash does not match or are missing are omitted.
        """

    def save_embeddings(self, entries: dict[str, tuple[str, list[float]]]) -> None:
        """Persist (tab_key, text_hash, embedding) entries."""
```

This API allows `GroupingService` to:

1. Compute `(tab_key, text_hash)` for each tab.
2. Ask `EmbeddingStore` for cached embeddings.
3. Embed any remaining tabs via `EmbeddingClient`.
4. Save new embeddings back to the store.

### 3. Clusterer (HDBSCAN)

**Responsibility:** cluster tab embeddings using a metric equivalent to
cosine similarity and detect noise.

**Location:** `app/services/clusterer.py`

**Dependencies:**

- `numpy`
- `scikit-learn` (for optional preprocessing utilities)
- `hdbscan`

**Metric:** cosine similarity, implemented as Euclidean distance on
row-normalized vectors.

**Interface (conceptual):**

```python
from dataclasses import dataclass
from typing import Sequence

@dataclass
class ClusterResult:
    labels: list[int]  # -1 for noise

class Clusterer:
    def __init__(self, min_cluster_size: int = 5, min_samples: int | None = None):
        ...

    def cluster(self, embeddings: Sequence[Sequence[float]]) -> ClusterResult:
        ...
```

**Behavior:**

- Converts embeddings to a NumPy array.
- Normalizes each vector to unit length (avoids magnitude effects).
- Runs HDBSCAN with:
  - `metric="euclidean"` on normalized vectors (equivalent to cosine).
  - `min_cluster_size` based on the `GroupingConstraints.minimumGroupSize`.
  - Optional `min_samples` with a sensible default.
- Returns one label per embedding; `-1` means noise (treated as
  ungrouped).

### 4. LabelingClient (LLM)

**Responsibility:** generate human-readable `name` and `reason` for each
cluster using a separate LLM model.

**Location:** either:

- Extend `app/services/llm_client.py` with a `generate_cluster_labels`
  method, or
- Introduce `app/services/labeling_client.py` that internally uses the
  same HTTP pattern as `LlmClient` but is semantically focused on
  labeling.

For clarity, we will create a `LabelingClient` class that:

```python
class LabelingClientError(Exception):
    ...

class LabelingClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        timeout_seconds: float = 30.0,
    ) -> None:
        ...

    def label_clusters(
        self,
        cluster_samples: list[dict[str, object]],
    ) -> list[dict[str, str]]:
        """Given sample titles per cluster, return labels and reasons.

        cluster_samples[i] will contain information like:
        {
            "cluster_id": 0,
            "representative_title": "...",
            "titles": ["...", "...", ...],
        }

        The return list has the same length, each element containing:
        {
            "cluster_id": 0,
            "name": "Short label",
            "reason": "One-sentence explanation.",
        }
        """
```

**Prompting:**

- The client builds a prompt instructing the model to:
  - Read the example titles for each cluster.
  - Produce a short, human-readable label that reflects the common
    theme or task.
  - Provide a brief reason sentence.
- The model returns JSON; the client parses and validates it.

### 5. GroupingService (new behavior)

**Location:** `app/services/grouping_service.py` (same file, new
implementation of `generate_grouping_plan`).

**Construction:**

```python
class GroupingService:
    def __init__(
        self,
        embedding_client: EmbeddingClient,
        labeling_client: LabelingClient,
        embedding_store: EmbeddingStore,
        clusterer: Clusterer,
    ):
        ...
```

**New algorithm:**

Given a `GroupingRequest`:

1. **Prepare embedding texts**

   - For each `BrowserTab` in `request.tabs`:
     - Build a normalized text input:
       - Lowercase the title.
       - Optionally include the domain extracted from `url`.
       - Optionally trim/normalize whitespace and punctuation.
     - Compute a `tab_key` from `title` + domain (e.g. a stable hash
       of the normalized string).
     - Compute a `text_hash` from the embedding text (e.g. SHA-256
       hex digest).

2. **Load cached embeddings**

   - Ask `EmbeddingStore` for cached embeddings for all
     `(tab_key, text_hash)` pairs.
   - For any tab without a valid cached embedding (missing or hash
     mismatch), add its embedding text to a `to_embed` list.

3. **Call embedding model for missing entries**

   - If `to_embed` is non-empty, call `EmbeddingClient.embed` with the
     list of texts.
   - Map returned embeddings back to their tab keys and update
     `EmbeddingStore` with `(tab_key, text_hash, embedding)`.

4. **Build embedding matrix and tab ordering**

   - For each `BrowserTab` in the original order, look up its
     embedding and add it to a list `embeddings`.
   - Track a parallel list `tab_ids` to map cluster labels back to
     tab IDs.

5. **Cluster embeddings**

   - Configure `Clusterer` with
     `min_cluster_size=request.constraints.minimumGroupSize`.
   - Call `clusterer.cluster(embeddings)` to obtain labels.
   - Group tab IDs by cluster label (label `-1` is noise).

6. **Prepare cluster samples for labeling**

   - For each cluster label `>= 0`:
     - Collect member tab IDs and their titles.
     - Compute the cluster centroid as the mean of member embeddings.
     - Choose the representative tab as the member whose embedding is
       closest (cosine similarity) to the centroid.
     - Select up to N sample titles (e.g., first 10 or the most
       similar to the centroid) for the labeling prompt.
   - Assemble `cluster_samples` describing each cluster.

7. **Label clusters via LLM**

   - Call `LabelingClient.label_clusters(cluster_samples)`.
   - Map returned `name` and `reason` to the corresponding cluster
     labels.

8. **Build groups and ungrouped IDs**

   - For each non-noise cluster:
     - If its size is less than
       `request.constraints.minimumGroupSize`, treat its members as
       ungrouped (do not create a group).
     - Otherwise, create a `GroupingPlanGroup`:
       - `groupId`: derived from the cluster label
         (e.g. `f"cluster-{label}"`).
       - `name`: from labeling LLM.
       - `reason`: from labeling LLM.
       - `tabIds`: tab IDs in the cluster.
   - Collect all tab IDs not assigned to any valid group into
     `ungroupedTabIds`.

9. **Construct final plan & validate**

   - Build a `GroupingPlan` with:
     - `planId`: a new UUID.
     - `requestId`: copied from the request.
     - `summary`: a brief description, such as
       "Grouped tabs into embedding-based clusters.".
     - `groups`: list of `GroupingPlanGroup` objects.
     - `ungroupedTabIds`: as computed above.
     - `warnings`: include a warning when any tabs remain ungrouped,
       e.g. "N tabs remain ungrouped after clustering.".
   - Run `validate_grouping_plan(plan, request)` to enforce existing
     invariants.
   - Return the validated plan.

### 6. Error Handling

- **Embedding errors** (network issues, bad responses):
  - `EmbeddingClient` raises `EmbeddingClientError`.
  - `GroupingService.generate_grouping_plan` lets this propagate and
    the FastAPI app maps it to an HTTP 502 with an appropriate error
    code (similar to the current `LlmClientError` handler).

- **Labeling errors**:
  - `LabelingClient` raises `LabelingClientError` on network or
    parsing issues.
  - Mapped to HTTP 502 with a distinct error code, e.g.
    `CLUSTER_LABELING_FAILED`.

- **Validation errors**:
  - `validate_grouping_plan` still raises `ValueError` on bad plans.
  - The route converts these into HTTP 422 with
    `PLAN_VALIDATION_FAILED`, as today.

- **Unexpected errors**:
  - Still handled by the existing global `Exception` handler,
    returning HTTP 500 with `INTERNAL_ERROR`.

## Configuration

Extend `Settings` in `app/core/config.py` with embedding and labeling
model configuration:

- Embedding model:
  - `embedding_api_key`
  - `embedding_model`
  - `embedding_base_url`
  - `embedding_timeout_seconds`

- Labeling model:
  - `labeling_api_key`
  - `labeling_model`
  - `labeling_base_url`
  - `labeling_timeout_seconds`

Additionally, optionally add:

- `embedding_db_path` (default `backend/data/embeddings.sqlite3`).
- `similarity_threshold` (float, default `0.8`) for potential future
  tuning; HDBSCAN may not require it directly, but it can be used for
  heuristics or future refinements.

These values are read from environment variables with sensible
defaults, similar to the existing `llm_*` settings.

## Dependencies

Add the following to `backend/requirements.txt`:

- `numpy`
- `scikit-learn`
- `hdbscan`

`sqlite3` remains from the Python standard library and does not need to
be added as a dependency.

## Testing Strategy

Update and extend backend tests to cover the new pipeline:

1. **Service-level grouping tests**
   - Replace or adapt existing `test_chunked_grouping.py` tests with
     new tests for `GroupingService` that use fake `EmbeddingClient`,
     fake `LabelingClient`, and an in-memory `EmbeddingStore`.
   - Verify:
     - Tabs in dense regions are grouped into clusters of at least
       `minimumGroupSize`.
     - Noise points (HDBSCAN label `-1`) and tabs in undersized
       clusters become `ungroupedTabIds`.
     - No tab appears in more than one group.
     - Warnings are added when ungrouped tabs remain.

2. **Route tests**
   - Update `test_generate_grouping.py` to construct `GroupingService`
     with fake clients and store, and verify:
     - Successful responses for a valid embedding/labeling pipeline.
     - 422 responses for invalid plans (can be simulated by injecting a
       misbehaving `LabelingClient` or `Clusterer`).

3. **Embedding client tests**
   - Add unit tests for `EmbeddingClient` similar to existing LLM
     client tests:
     - Network failure → raises `EmbeddingClientError`.
     - Malformed JSON payloads → raise `EmbeddingClientError`.
     - Valid payload → correct embedding vectors.

4. **Labeling client tests**
   - Add tests for `LabelingClient` to ensure it can:
     - Build requests correctly.
     - Parse and validate JSON label outputs.
     - Surface errors as `LabelingClientError`.

5. **Embedding store tests**
   - Tests for `EmbeddingStore` to confirm:
     - Existing embeddings are returned when `text_hash` matches.
     - Outdated entries (hash mismatch) are treated as cache misses.
     - Embeddings are persisted and re-loaded correctly.

The extension’s unit tests can remain unchanged because the HTTP
contract and `GroupingPlan` shape are preserved.

## Migration / Compatibility

- `GroupingService.generate_grouping_plan` will be fully replaced.
- The HTTP API contract stays the same, so the extension requires no
  changes.
- Old tests that assume chunked LLM behavior will be updated to
  reflect the new embedding-based pipeline rather than preserved as-is.

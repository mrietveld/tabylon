# Tab Organizer Backend Architecture

This document summarizes the backend architecture and the major design decisions, including chunked grouping, iterative clustering, label caching, and storage layout.

## Overview

The backend is a FastAPI service running locally (default `127.0.0.1:5050`). Its responsibilities:

1. Accept normalized tab snapshots from the Firefox extension.
2. Compute tab embeddings and cluster them.
3. Use an LLM to label clusters.
4. Validate and return a safe, structured grouping plan.
5. Persist embeddings and cluster labels for reuse.

## Application Setup

Entry point: `backend/app/main.py`.

Key roles:

- **Configuration** via `app.core.config.get_settings` (host, port, log directory, LLM API key/base URL/model, timeouts, DB paths).
- **Logging** via `app.core.logging_setup.configure_logging` on the `tab_organizer` logger.
- **CORS** to allow `moz-extension://*` origins.
- **Service wiring**:
  - `EmbeddingClient` for calling the embedding model.
  - `LabelingClient` for calling the labeling model.
  - `EmbeddingStore` for embedding persistence.
  - `ClusterLabelStore` for cluster label caching.
  - `Clusterer` (HDBSCAN-based clustering) for embedding-based grouping.
  - `GroupingService` for orchestration.

Exception handlers translate `EmbeddingClientError`, `LabelingClientError`, and generic `Exception` into structured HTTP responses.

## Configuration and Storage Layout

`app.core.config.Settings` includes:

- `embedding_db_path` (default `backend/db/embed.sql3`) – used by `EmbeddingStore`.
- `cluster_label_db_path` (default `backend/db/cluster_labels.sql3`) – used by `ClusterLabelStore`.

Environment overrides:

- `TAB_ORGANIZER_EMBEDDING_DB_PATH` – embedding DB path.
- `TAB_ORGANIZER_CLUSTER_LABEL_DB_PATH` – cluster label DB path.

### EmbeddingStore

`app.services.embedding_store.EmbeddingStore`:

- Single SQLite connection to the embedding DB.
- Creates `tab_embeddings`:

```sql
CREATE TABLE IF NOT EXISTS tab_embeddings (
  tab_key TEXT PRIMARY KEY,
  text_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  embedding_json TEXT NOT NULL
);
```

- `get_cached_embeddings(keys_and_hashes)`:
  - Given `{ tab_key: text_hash }`, returns a map of `tab_key -> embedding` only when the stored `text_hash` matches.
  - Used to avoid regenerating embeddings for unchanged tab text.

- `save_embeddings(entries)`:
  - Accepts `{ tab_key: (text_hash, embedding) }`.
  - Writes/updates rows with `REPLACE INTO tab_embeddings` and a `datetime('now')` timestamp.

### ClusterLabelStore

`app.services.cluster_label_store.ClusterLabelStore`:

- Separate SQLite connection to the cluster-label DB.
- Creates `cluster_labels`:

```sql
CREATE TABLE IF NOT EXISTS cluster_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_ids_json TEXT NOT NULL,
  label_name TEXT NOT NULL,
  label_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- `save_cluster_labels(entries)`:
  - Accepts a list of `(tab_ids, label_name, label_reason)`.
  - Stores `sorted(tab_ids)` as JSON to normalize cluster membership.

- `get_similar_cluster_label(tab_ids, similarity_threshold=0.9)`:
  - Computes Jaccard similarity over tab id sets between the given cluster and all stored clusters.
  - Returns the `(name, reason)` pair of the most similar stored label above the threshold, or `None`.

This separation ensures embeddings and labels live in distinct DB files and concerns.

## API Surface

Routes defined in `app.api.routes.create_router`:

- `GET /health` – returns `{ status: "ok", service: "tab-organizer-backend" }`.
- `POST /api/groupings/generate` – accepts a `GroupingRequest` with:
  - `constraints.minimumGroupSize` (default 5).
  - `tabs` normalized from the extension.
  - Delegates to `GroupingService.generate_grouping_plan`.

On validation errors, returns 422 with `ErrorDetail { code: "PLAN_VALIDATION_FAILED", message }`.

## Core Schemas

`app.api.schemas` defines:

- `GroupingConstraints` – min group size and description.
- `BrowserTab` – tab metadata.
- `GroupingRequest` – request wrapper.
- `GroupingPlanGroup` – one group of tabs.
- `GroupingPlan` – full grouping plan.
- `ErrorDetail` – error payload.

## GroupingService and Embedding/Clustering Pipeline

`app.services.grouping_service.GroupingService` orchestrates the end-to-end grouping from embeddings through clustering, labeling, and validation.

### 1. Embedding Preparation and Caching

For each tab in `request.tabs`:

- Normalizes title and URL to lowercase, trimmed strings.
- Constructs `embedding_text = "<normalized_title> <normalized_url>"`.
- Sanitizes `embedding_text` to be UTF-8-safe (replacing invalid surrogate sequences).
- Builds a stable `tab_key` as `sha256(f"{tab_id}:{embedding_text}")`.
- Computes `text_hash = sha256(embedding_text_bytes)`.

It then:

- Calls `EmbeddingStore.get_cached_embeddings(text_hashes)` to get up-to-date embeddings.
- Identifies `missing_keys` where no valid cached embedding exists.
- Logs the cache hit/miss counts.
- Batches missing keys into chunks of at most 32 texts:
  - Calls `EmbeddingClient.embed(batch_texts)` for each batch.
  - Retries once per batch on HTTP errors; on second failure, aborts the request.
  - Persists new embeddings and updates an in-memory cache.

### 2. Embedding Alignment

Builds:

- `embeddings` – list of embedding vectors aligned with `tab_id_order`.
- `tab_id_order` – the ordered list of tab ids that successfully received embeddings.

If no embeddings are available, returns a plan that leaves all tabs ungrouped with a warning.

### 3. Iterative Clustering and Peeling

The core clustering logic:

- Uses the configured `Clusterer` (HDBSCAN-like) for density-based clustering.
- Maintains:
  - `base_tab_ids` and `base_embeddings` (aligned arrays).
  - `ungrouped_ids` – the set of tab ids not yet assigned to a peeled cluster.
  - `final_clusters` – list of tab id lists for clusters that are peeled.
  - `noise_ids` – tab ids labeled as noise by clustering.

Steps:

1. Set `min_group_size` from `request.constraints.minimumGroupSize`.
2. Set `peel_min_size_large = max(min_group_size, 6)` for large ungrouped sets.
3. Define `run_default_clustering` (HDBSCAN-based):
   - Clusters only `selected_ids` (current ungrouped set).
   - Logs cluster counts and noise.
   - Builds `subset_clusters` by label; noise labels `-1` go to `subset_noise`.
   - Filters to `peelable` clusters with size >= `peel_min_size`.
   - If fewer than 2 peelable clusters, returns False.
   - Computes a density score per cluster (mean distance to centroid).
   - Peels the N1 most dense clusters (and sometimes a final "sparse" cluster based on density and size heuristics), appending their tab ids to `final_clusters` and removing them from `ungrouped_ids`.
4. Define `run_kmeans_clustering` (fallback):
   - Uses KMeans with `n_clusters = min(6, max(3, len(selected_ids) / peel_min_size))`.
   - Filters clusters to those with size >= `peel_min_size`.
   - Peels clusters based on density and size heuristics.

5. **Phase 1**: While `len(ungrouped_ids) > 32`:
   - Attempts HDBSCAN peeling; if that cannot peel, attempts KMeans.
   - Stops if neither algorithm can peel more clusters.

6. **Phase 2**: If `0 < len(ungrouped_ids) <= 32`:
   - Runs a final clustering attempt using smaller thresholds (down to `min_group_size`).

The result is a set of peeled clusters (`final_clusters`) and a residual set of ungrouped tab ids.

### 4. Label Resolution and Caching

Once `final_clusters` are known, `GroupingService` resolves labels as follows:

- Builds a mapping `tab_by_id` from tab id to tab object.
- Initializes `resolved_labels` and `cluster_samples_for_model`.

For each cluster index and `tab_ids`:

1. **Cache-first**:
   - Calls `ClusterLabelStore.get_similar_cluster_label(tab_ids, similarity_threshold=0.9)`.
   - If a cached label is found, records it in `resolved_labels` and logs the reuse.

2. **Model-only for unlabeled clusters**:
   - If no cache match is found, prepares a cluster sample:
     - Computes centroid and selects the nearest embedding as representative.
     - Picks a representative title and collects titles for all cluster members.
   - Appends `{ cluster_id, representative_title, titles }` to `cluster_samples_for_model`.

If any samples need labeling:

- Calls `LabelingClient.label_clusters(cluster_samples_for_model)`.
- For each returned label:
  - Adds it to `resolved_labels`.
  - Queues `(tab_ids, name, reason)` in `label_entries_for_cache` for persistence.
- Persists new labels via `ClusterLabelStore.save_cluster_labels`.

This design:

- Avoids calling the labeling model for clusters that already have a sufficiently similar cached label.
- Builds up a label history so recurring clusters reuse names and reasons.

### 5. Final Group and Plan Construction

- For each cluster index and `tab_ids` in `final_clusters`:
  - If the cluster size < `min_group_size`, it is ignored.
  - Uses `resolved_labels[index]` if available; otherwise falls back to `name = f"Cluster {index}", reason = "Embedding-based cluster."`.
  - Creates `GroupingPlanGroup(groupId=f"cluster-{index}", name, reason, tabIds=tab_ids)` and adds it to `groups`.

- Computes:
  - `known_tab_ids` from the request.
  - `grouped_ids` from the constructed groups.
  - `ungrouped_ids_set = known_tab_ids - grouped_ids`, plus any `noise_ids`.

- Builds `GroupingPlan`:
  - `planId` – a new UUID;
  - `summary` – either "Grouped tabs into iterative embedding-based clusters." or a negative summary;
  - `groups`,
  - `ungroupedTabIds` (sorted),
  - `warnings` (including a count of ungrouped tabs when non-empty).

- Calls `validate_grouping_plan(plan, request)` to enforce invariants.

## LabelingClient Behavior

`app.services.labeling_client.LabelingClient`:

- Expects an OpenAI-style `/chat/completions` endpoint.
- `label_clusters(cluster_samples)`:
  - If no API key, raises `LabelingClientError`.
  - Batches `cluster_samples` into groups of 3 clusters.
  - For each batch:
    - Builds a prompt via `_build_prompt(batch)`, including:
      - a representative title,
      - up to the top 10 titles by word count for each cluster.
    - Sends a chat-completions request with JSON output.
    - Parses the content field as JSON and extracts `clusters`.
    - Checks that `len(clusters)` matches the batch size; otherwise raises `LabelingClientError`.
    - Extracts `cluster_id`, `name`, and `reason` for each cluster.

This batching design:

- Controls prompt size by limiting titles.
- Reduces model calls by grouping clusters.
- Ensures consistency between requested and returned labels.

## Validation Rules

`app.services.validator.validate_grouping_plan` enforces:

- Each group has at least `minimumGroupSize` tabs.
- Each group has non-empty `name` and `reason`.
- All group tab ids and ungrouped tab ids are drawn from the requests tabs.
- No tab appears in more than one group.

These rules are applied both to intermediate grouping plans (if needed) and the final plan returned to the extension.

## Summary of Backend Design Decisions

- **Separation of embeddings and labels** – embeddings live in `embed.sql3`; labels in `cluster_labels.sql3`.
- **Cache-first labeling** – cluster labels are reused when clusters are at least 90% similar, reducing LLM usage and stabilizing naming.
- **Chunked embedding and clustering** – embeddings are computed in batches of up to 32 texts; clustering runs iteratively with peeling logic to handle large tab sets.
- **Strict validation** – both backend and extension validate grouping plans before use.
- **Robust error handling** – dedicated exceptions for embedding and labeling clients, plus global handlers, provide clear, structured failure modes.

Together, these decisions create a robust, testable backend that can scale to large tab sets, reuse past cluster knowledge, and integrate safely with LLM providers and the STG extension.

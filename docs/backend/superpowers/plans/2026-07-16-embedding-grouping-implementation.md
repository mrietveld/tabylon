# Embedding-Based Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current LLM-only grouping logic in the backend with an embedding + HDBSCAN clustering + LLM labeling pipeline while keeping the HTTP API contract unchanged.

**Architecture:** Introduce separate services for embeddings, embedding persistence, clustering, and cluster labeling. `GroupingService.generate_grouping_plan` becomes an orchestrator that uses these components to produce `GroupingPlan` instances from `GroupingRequest` inputs.

**Tech Stack:** FastAPI, Pydantic, httpx, sqlite3, numpy, scikit-learn, hdbscan, existing LLM-like HTTP client patterns.

## Global Constraints

- Do not change the external API contract:
  - `POST /api/groupings/generate` still accepts `GroupingRequest` and returns `GroupingPlan`.
- The extension must not need any changes.
- Validation logic in `app.services.validator.validate_grouping_plan` must still be applied to every final plan.
- Provider-agnostic HTTP clients: no hard-coded vendor-specific assumptions; rely on configurable base URLs, models, and API keys.
- Grouping must handle up to ~1500 tabs per request.
- Minimum group size is driven by `GroupingRequest.constraints.minimumGroupSize`.

---

## Files Overview

**New:**
- `backend/app/services/embedding_client.py`
- `backend/app/services/embedding_store.py`
- `backend/app/services/clusterer.py`
- `backend/app/services/labeling_client.py`

**Modified:**
- `backend/app/services/grouping_service.py`
- `backend/app/services/llm_client.py` (optional if we reuse patterns)
- `backend/app/core/config.py`
- `backend/backend/logs/` (no code change; confirm paths)
- `backend/requirements.txt`
- `backend/app/main.py` (wire up new dependencies into `GroupingService`)
- `backend/tests/test_generate_grouping.py`
- `backend/tests/test_chunked_grouping.py` (repurpose or replace)
- `backend/tests/test_llm_client.py` (only if shared code is reused)
- New tests for embedding client, store, clusterer, and labeling client.

---

## Task 1: Add Dependencies

**Files:**
- Modify: `backend/requirements.txt`

**Interfaces:**
- None.

- [ ] **Step 1: Add scientific and clustering dependencies**

Append the following lines to `backend/requirements.txt`:

```text
numpy
scikit-learn
hdbscan
```

(Respect any existing version pinning style, adding versions only if the project requires it.)

---

## Task 2: Extend Settings for Embedding and Labeling Models

**Files:**
- Modify: `backend/app/core/config.py`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- `Settings` dataclass gains new fields.
- `get_settings()` reads new environment variables.

- [ ] **Step 1: Extend Settings dataclass**

In `backend/app/core/config.py`, update `Settings` to include:

```python
@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 5050
    log_dir: Path = Path("backend/logs")
    service_name: str = "tab-organizer-backend"
    llm_api_key: str | None = None
    llm_model: str = "gpt-4o-mini"
    llm_base_url: str = "https://api.openai.com/v1"
    embedding_api_key: str | None = None
    embedding_model: str = "embedding-model"
    embedding_base_url: str = "https://api.example.com/v1"
    embedding_timeout_seconds: float = 30.0
    labeling_api_key: str | None = None
    labeling_model: str = "labeling-model"
    labeling_base_url: str = "https://api.example.com/v1"
    labeling_timeout_seconds: float = 30.0
    embedding_db_path: Path = Path("backend/data/embeddings.sqlite3")
```

Adjust defaults generically (no vendor-specific names beyond placeholders like `embedding-model`).

- [ ] **Step 2: Read new settings from environment**

In `get_settings()`, add reads for:

```python
    embedding_api_key = read_setting("TAB_ORGANIZER_EMBEDDING_API_KEY")
    embedding_model = read_setting("TAB_ORGANIZER_EMBEDDING_MODEL", "embedding-model")
    embedding_base_url = read_setting("TAB_ORGANIZER_EMBEDDING_BASE_URL", "https://api.example.com/v1")
    embedding_timeout_seconds = float(read_setting("TAB_ORGANIZER_EMBEDDING_TIMEOUT_SECONDS", "30"))

    labeling_api_key = read_setting("TAB_ORGANIZER_LABELING_API_KEY")
    labeling_model = read_setting("TAB_ORGANIZER_LABELING_MODEL", "labeling-model")
    labeling_base_url = read_setting("TAB_ORGANIZER_LABELING_BASE_URL", "https://api.example.com/v1")
    labeling_timeout_seconds = float(read_setting("TAB_ORGANIZER_LABELING_TIMEOUT_SECONDS", "30"))

    embedding_db_path = Path(read_setting("TAB_ORGANIZER_EMBEDDING_DB_PATH", "backend/data/embeddings.sqlite3"))
```

Include them in the `Settings(...)` constructor.

- [ ] **Step 3: Update config tests**

In `backend/tests/test_config.py`, add assertions for default values of the new fields and environment overrides.

Run:

```bash
cd backend
pytest tests/test_config.py -q
```

Expected: tests pass.

---

## Task 3: Implement EmbeddingStore

**Files:**
- Create: `backend/app/services/embedding_store.py`
- Test: `backend/tests/test_embedding_store.py`

**Interfaces:**
- New `EmbeddingStore` class.

- [ ] **Step 1: Implement EmbeddingStore**

Create `embedding_store.py` with a minimal SQLite-backed store:

```python
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Tuple, List


@dataclass
class EmbeddingRecord:
    tab_key: str
    text_hash: str
    embedding: list[float]


class EmbeddingStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tab_embeddings (
                tab_key TEXT PRIMARY KEY,
                text_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                embedding_json TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def get_cached_embeddings(self, keys_and_hashes: Dict[str, str]) -> Dict[str, list[float]]:
        if not keys_and_hashes:
            return {}
        placeholders = ",".join(["?"] * len(keys_and_hashes))
        sql = f"SELECT tab_key, text_hash, embedding_json FROM tab_embeddings WHERE tab_key IN ({placeholders})"
        cursor = self._conn.execute(sql, tuple(keys_and_hashes.keys()))
        results: Dict[str, list[float]] = {}
        for tab_key, text_hash, embedding_json in cursor.fetchall():
            expected_hash = keys_and_hashes.get(tab_key)
            if expected_hash and expected_hash == text_hash:
                results[tab_key] = json.loads(embedding_json)
        return results

    def save_embeddings(self, entries: Dict[str, Tuple[str, list[float]]]) -> None:
        if not entries:
            return
        rows = [
            (tab_key, text_hash, "", json.dumps(embedding))
            for tab_key, (text_hash, embedding) in entries.items()
        ]
        # updated_at can be filled with an empty string or a timestamp if needed later
        self._conn.executemany(
            "REPLACE INTO tab_embeddings (tab_key, text_hash, updated_at, embedding_json) VALUES (?, ?, datetime('now'), ?)",
            rows,
        )
        self._conn.commit()
```

- [ ] **Step 2: Add tests for EmbeddingStore**

Create `backend/tests/test_embedding_store.py` to cover:

- Creating a store in a temporary path.
- Saving embeddings and retrieving them with matching `text_hash`.
- Ensuring mismatched `text_hash` entries are not returned.

Run:

```bash
cd backend
pytest tests/test_embedding_store.py -q
```

Expected: tests pass.

---

## Task 4: Implement EmbeddingClient

**Files:**
- Create: `backend/app/services/embedding_client.py`
- Test: `backend/tests/test_embedding_client.py`

**Interfaces:**
- New `EmbeddingClient` and `EmbeddingClientError`.

- [ ] **Step 1: Implement EmbeddingClient**

Create `embedding_client.py`:

```python
from __future__ import annotations

from typing import Any, Iterable, List

import httpx


class EmbeddingClientError(Exception):
    """Raised when the embedding provider cannot return usable embeddings."""


class EmbeddingClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        timeout_seconds: float = 30.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._http_client = http_client or httpx.Client(timeout=timeout_seconds)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not self._api_key:
            raise EmbeddingClientError("TAB_ORGANIZER_EMBEDDING_API_KEY is not configured")
        if not texts:
            return []
        try:
            response = self._http_client.post(
                f"{self._base_url}/embeddings",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={"model": self._model, "input": texts},
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise EmbeddingClientError(f"Embedding request failed: {error}") from error

        payload = response.json()
        try:
            data = payload["data"]
        except (KeyError, TypeError) as error:
            raise EmbeddingClientError("Embedding response did not contain data") from error

        embeddings: list[list[float]] = []
        for item in data:
            vector = item.get("embedding")
            if not isinstance(vector, list):
                raise EmbeddingClientError("Embedding response contained invalid vector")
            embeddings.append(vector)

        if len(embeddings) != len(texts):
            raise EmbeddingClientError("Embedding response count did not match input count")

        return embeddings
```

- [ ] **Step 2: Add tests for EmbeddingClient**

Create `backend/tests/test_embedding_client.py` to verify:

- Error when `api_key` is empty.
- Proper handling of HTTP errors (mock `httpx.Client`).
- Parsing of well-formed responses.
- Error on malformed responses or mismatched lengths.

Run:

```bash
cd backend
pytest tests/test_embedding_client.py -q
```

Expected: tests pass.

---

## Task 5: Implement Clusterer

**Files:**
- Create: `backend/app/services/clusterer.py`
- Test: `backend/tests/test_clusterer.py`

**Interfaces:**
- New `Clusterer` and `ClusterResult`.

- [ ] **Step 1: Implement Clusterer using HDBSCAN**

Create `clusterer.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import hdbscan
import numpy as np


@dataclass
class ClusterResult:
    labels: list[int]


class Clusterer:
    def __init__(self, min_cluster_size: int = 5, min_samples: int | None = None) -> None:
        self._min_cluster_size = min_cluster_size
        self._min_samples = min_samples if min_samples is not None else min_cluster_size

    def cluster(self, embeddings: Sequence[Sequence[float]]) -> ClusterResult:
        if not embeddings:
            return ClusterResult(labels=[])
        matrix = np.array(embeddings, dtype=float)
        # Normalize rows to unit length for cosine-style similarity.
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix = matrix / norms

        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=self._min_cluster_size,
            min_samples=self._min_samples,
            metric="euclidean",
        )
        labels = clusterer.fit_predict(matrix)
        return ClusterResult(labels=labels.tolist())
```

- [ ] **Step 2: Add tests for Clusterer**

Create `backend/tests/test_clusterer.py` to cover:

- Empty input returns empty labels.
- Simple synthetic cases where clearly separated embedding clouds form different clusters.
- Presence of `-1` labels for noise points when applicable.

Run:

```bash
cd backend
pytest tests/test_clusterer.py -q
```

Expected: tests pass.

---

## Task 6: Implement LabelingClient

**Files:**
- Create: `backend/app/services/labeling_client.py`
- Test: `backend/tests/test_labeling_client.py`

**Interfaces:**
- New `LabelingClient` and `LabelingClientError`.

- [ ] **Step 1: Implement LabelingClient**

Create `labeling_client.py`:

```python
from __future__ import annotations

from typing import Any

import httpx


class LabelingClientError(Exception):
    """Raised when the labeling model cannot return usable labels."""


class LabelingClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str,
        timeout_seconds: float = 30.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._http_client = http_client or httpx.Client(timeout=timeout_seconds)

    def label_clusters(self, cluster_samples: list[dict[str, object]]) -> list[dict[str, str]]:
        if not self._api_key:
            raise LabelingClientError("TAB_ORGANIZER_LABELING_API_KEY is not configured")
        if not cluster_samples:
            return []

        prompt = self._build_prompt(cluster_samples)
        try:
            response = self._http_client.post(
                f"{self._base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._model,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You label clusters of browser tabs. "
                                "Return strict JSON only and do not include markdown fences."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                },
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise LabelingClientError(f"Labeling request failed: {error}") from error

        payload = response.json()
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise LabelingClientError("Labeling response did not contain a chat completion message") from error

        import json

        try:
            data = json.loads(content)
        except json.JSONDecodeError as error:
            raise LabelingClientError("Labeling response content was not valid JSON") from error

        labels = data.get("clusters")
        if not isinstance(labels, list):
            raise LabelingClientError("Labeling response did not contain a clusters list")

        result: list[dict[str, str]] = []
        for item in labels:
            result.append(
                {
                    "cluster_id": item["cluster_id"],
                    "name": item["name"],
                    "reason": item["reason"],
                }
            )
        return result

    def _build_prompt(self, cluster_samples: list[dict[str, object]]) -> str:
        lines = [
            "You will receive clusters of browser tabs and should assign each cluster a short label and brief reason.",
            "Return JSON with a top-level 'clusters' array, where each item has cluster_id, name, and reason.",
        ]
        for item in cluster_samples:
            cluster_id = item["cluster_id"]
            representative_title = item["representative_title"]
            titles = item["titles"]
            lines.append(f"Cluster {cluster_id} representative: {representative_title!r}")
            lines.append("Titles:")
            for title in titles:
                lines.append(f"- {title!r}")
        return "\n".join(lines)
```

- [ ] **Step 2: Add tests for LabelingClient**

Create `backend/tests/test_labeling_client.py` to verify:

- Error when API key is missing.
- Proper handling of HTTP errors.
- JSON parsing and validation of `clusters` output.

Run:

```bash
cd backend
pytest tests/test_labeling_client.py -q
```

Expected: tests pass.

---

## Task 7: Rewrite GroupingService.generate_grouping_plan

**Files:**
- Modify: `backend/app/services/grouping_service.py`
- Test: reuse/replace `backend/tests/test_chunked_grouping.py` and possibly add new tests.

**Interfaces:**
- `GroupingService.__init__` now accepts embedding + labeling components instead of an LLM client.
- `generate_grouping_plan` is fully replaced with embedding-based pipeline.

- [ ] **Step 1: Update GroupingService constructor**

In `grouping_service.py`, change `__init__` to:

```python
class GroupingService:
    def __init__(
        self,
        embedding_client: EmbeddingClient,
        labeling_client: LabelingClient,
        embedding_store: EmbeddingStore,
        clusterer: Clusterer,
    ) -> None:
        self._embedding_client = embedding_client
        self._labeling_client = labeling_client
        self._embedding_store = embedding_store
        self._clusterer = clusterer
        self._logger = logging.getLogger("tab_organizer")
```

Remove all references to `llm_client` and chunked behavior.

- [ ] **Step 2: Implement new generate_grouping_plan**

Replace the old method with the embedding pipeline using the design document as a guide:

- Normalize titles + domains.
- Compute `tab_key` and `text_hash` (e.g., using `hashlib.sha256`).
- Use `EmbeddingStore` to load cached embeddings.
- Use `EmbeddingClient` for missing ones.
- Build embeddings array and tab ID list.
- Cluster via `Clusterer`.
- For each cluster label:
  - Collect member tab IDs and embeddings.
  - Compute centroid and nearest representative.
  - Build `cluster_samples` for `LabelingClient`.
- Label clusters.
- Build groups and `ungroupedTabIds`.
- Construct `GroupingPlan` and run `validate_grouping_plan`.

Add logging at key points (embedding, clustering, labeling, validation).

- [ ] **Step 3: Remove obsolete chunking helpers**

Delete `_call_llm_client`, `_validate_chunk_plan`, `_merge_groups`, and `_chunk_tabs` from `GroupingService` as they are no longer used.

- [ ] **Step 4: Update / replace chunked grouping tests**

Repurpose `backend/tests/test_chunked_grouping.py` into tests for the new behavior, using fake clients and a simple in-memory store or a temporary SQLite DB.

Focus on:

- At least one cluster of size >= 5 becomes a group.
- Noise points / undersized clusters become ungrouped.
- No tab lands in more than one group.

---

## Task 8: Wire Up Dependencies in app.main

**Files:**
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_generate_grouping.py` (uses `create_app`).

**Interfaces:**
- `create_app()` must construct `EmbeddingClient`, `EmbeddingStore`, `Clusterer`, and `LabelingClient` from settings and pass them into `GroupingService`.

- [ ] **Step 1: Instantiate new services in create_app**

In `create_app` after loading `settings`:

```python
from app.services.embedding_client import EmbeddingClient
from app.services.embedding_store import EmbeddingStore
from app.services.clusterer import Clusterer
from app.services.labeling_client import LabelingClient

embedding_client = EmbeddingClient(
    api_key=settings.embedding_api_key or "",
    model=settings.embedding_model,
    base_url=settings.embedding_base_url,
    timeout_seconds=settings.embedding_timeout_seconds,
)

embedding_store = EmbeddingStore(settings.embedding_db_path)

clusterer = Clusterer(min_cluster_size=5)  # min size will be overridden per-request if needed

labeling_client = LabelingClient(
    api_key=settings.labeling_api_key or "",
    model=settings.labeling_model,
    base_url=settings.labeling_base_url,
    timeout_seconds=settings.labeling_timeout_seconds,
)

app.state.grouping_service = GroupingService(
    embedding_client=embedding_client,
    labeling_client=labeling_client,
    embedding_store=embedding_store,
    clusterer=clusterer,
)
```

- [ ] **Step 2: Add error handlers for new client errors (optional)**

Optionally add FastAPI exception handlers for `EmbeddingClientError` and `LabelingClientError` similar to `LlmClientError`, returning HTTP 502 with appropriate error codes.

---

## Task 9: Update Route Tests for New Service Behavior

**Files:**
- Modify: `backend/tests/test_generate_grouping.py`

**Interfaces:**
- Tests will construct `create_app` with a custom `GroupingService` or with fake clients injected.

- [ ] **Step 1: Adapt tests to new constructor signature**

Adjust `test_generate_grouping_plan_returns_validated_plan` and `test_generate_grouping_plan_rejects_invalid_model_output` to:

- Use a fake `GroupingService` or a fake `EmbeddingClient` + `LabelingClient` + `EmbeddingStore` + `Clusterer` that produce deterministic `GroupingPlan` outputs.
- Focus on verifying that:
  - A valid plan returns HTTP 200.
  - Validation failures still return HTTP 422 with `PLAN_VALIDATION_FAILED`.

Run:

```bash
cd backend
pytest tests/test_generate_grouping.py -q
```

Expected: tests pass.

---

## Task 10: End-to-End Backend Test Run

**Files:**
- All backend tests.

- [ ] **Step 1: Run full test suite**

From `backend/`:

```bash
pytest -q
```

Ensure all tests pass and fix any remaining issues (import paths, config, or missing error handlers).

---

## Self-Review Checklist

- [ ] All new components (`EmbeddingStore`, `EmbeddingClient`, `Clusterer`, `LabelingClient`) are covered by unit tests.
- [ ] `GroupingService.generate_grouping_plan` contains no references to the old LLM chunking logic.
- [ ] The external API contract and Pydantic models remain unchanged.
- [ ] Validation behavior is preserved and enforced for final plans.
- [ ] New configuration fields have sensible defaults and tests.
- [ ] All backend tests pass.

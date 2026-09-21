"""Tests for embedding-based clustering of large tab sets.

These tests verify that the embedding+clustering pipeline can form valid
clusters and leave noise tabs ungrouped.
"""

import pytest

from app.api.schemas import BrowserTab, GroupingConstraints, GroupingRequest
from app.core.config import get_settings
from app.services.cluster_label_store import ClusterLabelStore
from app.services.clusterer import Clusterer
from app.services.embedding_client import EmbeddingClient, EmbeddingClientError
from app.services.embedding_store import EmbeddingStore
from app.services.grouping_service import GroupingService


def make_request(total_tabs: int, tabs=None) -> GroupingRequest:
    """Create a deterministic request for clustering tests."""

    return GroupingRequest(
            requestId="req-clustering",
            capturedAt="2026-07-16T10:00:00Z",
            constraints=GroupingConstraints(minimumGroupSize=5),
            tabs=[
                BrowserTab(
                        tabId=index,
                        windowId=1,
                        title=f"Tab {index}",
                        url=f"https://example.com/{index}",
                        active=False,
                        pinned=False,
                        audible=False,
                        discarded=False,
                )
                for index in range(1, total_tabs + 1)
            ],
    )


class FakeEmbeddingClient:
    def __init__(self):
        self.calls = []

    def embed(self, texts):
        self.calls.append(list(texts))
        # Return simple 1D embeddings that group by tens: 1-5, 6-10, etc.
        return [[float(int(text.split()[1]) // 5)] for text in texts]


class FakeEmbeddingStore:
    def __init__(self):
        self.saved = {}
        self.saved_cluster_labels = []

    def get_cached_embeddings(self, keys_and_hashes):
        return {}

    def save_embeddings(self, entries):
        self.saved.update(entries)

    # New methods to satisfy GroupingService's label caching API.
    def save_cluster_labels(self, entries):
        # entries: list of (tab_ids, name, reason)
        self.saved_cluster_labels.extend(entries)

    def get_similar_cluster_label(self, tab_ids, similarity_threshold=0.9):
        # For tests we can ignore similarity and always behave as if there is
        # no cached label. This ensures the labeling client is exercised.
        return None


class FakeClusterer:
    def __init__(self):
        self._min_cluster_size = 5

    def cluster(self, embeddings):
        # Simple clustering: all tabs with the same embedding value go to one cluster.
        labels = []
        for embedding in embeddings:
            labels.append(int(embedding[0]))
        return type("Result", (), {"labels": labels})()


class FakeLabelingClient:
    def __init__(self):
        self.calls = []

    def label_clusters(self, cluster_samples):
        self.calls.append(cluster_samples)
        return [
            {
                "cluster_id": sample["cluster_id"],
                "name":       f"Group {sample['cluster_id']}",
                "reason":     "Synthetic cluster for testing.",
            }
            for sample in cluster_samples
        ]


def test_grouping_service_forms_groups_from_clusters():
    """Embedding-based clustering should produce groups meeting the minimum size."""
    request = make_request(15)

    embedding_client = FakeEmbeddingClient()
    labeling_client = FakeLabelingClient()
    store = FakeEmbeddingStore()
    store = FakeEmbeddingStore()
    clusterer = FakeClusterer()

    service = GroupingService(embedding_client, labeling_client, store, clusterer)
    plan = service.generate_grouping_plan(request)

    assert len(plan.groups) >= 1
    for group in plan.groups:
        assert len(group.tabIds) >= 5
    # Some tabs may remain ungrouped depending on the synthetic mapping.
    assert set(plan.ungroupedTabIds).issubset({tab.tabId for tab in request.tabs})


def test_grouping_service_batches_embedding_requests_and_saves_per_batch():
    """Missing tabs should be embedded in batches of at most 32 and saved per batch."""
    # 70 tabs -> 3 batches: 32, 32, 6
    request = make_request(70)

    embedding_client = FakeEmbeddingClient()

    class TrackingStore(FakeEmbeddingStore):
        def __init__(self):
            super().__init__()
            self.save_calls = []

        def save_embeddings(self, entries):
            # Record each batch separately
            self.save_calls.append(dict(entries))
            super().save_embeddings(entries)

    labeling_client = FakeLabelingClient()
    store = TrackingStore()
    clusterer = FakeClusterer()

    service = GroupingService(embedding_client, labeling_client, store, clusterer)
    plan = service.generate_grouping_plan(request)

    # Embedding client should be called once per batch, with batch size <= 32
    assert len(embedding_client.calls) == 3
    assert all(len(batch) <= 32 for batch in embedding_client.calls)
    assert sum(len(batch) for batch in embedding_client.calls) == 70

    # Store should persist once per batch, with entries covering all missing tabs
    assert len(store.save_calls) == 3
    assert sum(len(entries) for entries in store.save_calls) == 70

    # Plan should still reference only known tab IDs
    assert set(plan.ungroupedTabIds).issubset({tab.tabId for tab in request.tabs})


def test_grouping_service_retries_embedding_batch_once_then_succeeds():
    """A failing batch should be retried once and then succeed without duplicating saves."""
    request = make_request(10)

    class FlakyEmbeddingClient:
        def __init__(self):
            self.calls = 0

        def embed(self, texts):
            self.calls += 1
            if self.calls == 1:
                raise EmbeddingClientError("temporary failure")
            # On retry, return simple embeddings
            return [[0.0] for _ in texts]

    class TrackingStore(FakeEmbeddingStore):
        def __init__(self):
            super().__init__()
            self.save_calls = 0

        def save_embeddings(self, entries):
            self.save_calls += 1
            super().save_embeddings(entries)

    embedding_client = FlakyEmbeddingClient()
    labeling_client = FakeLabelingClient()
    store = TrackingStore()
    clusterer = FakeClusterer()

    service = GroupingService(embedding_client, labeling_client, store, clusterer)
    plan = service.generate_grouping_plan(request)

    # One initial attempt + one retry
    assert embedding_client.calls == 2
    # Embeddings should be saved exactly once for the successful batch
    assert store.save_calls == 1
    # Plan is still produced and references known tab IDs only
    assert set(plan.ungroupedTabIds).issubset({tab.tabId for tab in request.tabs})


def test_grouping_service_aborts_after_two_failed_embedding_attempts():
    """If a batch fails twice, grouping should abort and not save embeddings for that batch."""
    request = make_request(10)

    class AlwaysFailEmbeddingClient:
        def __init__(self):
            self.calls = 0

        def embed(self, texts):
            self.calls += 1
            raise EmbeddingClientError("persistent failure")

    class TrackingStore(FakeEmbeddingStore):
        def __init__(self):
            super().__init__()
            self.save_calls = 0

        def save_embeddings(self, entries):
            self.save_calls += 1
            super().save_embeddings(entries)

    embedding_client = AlwaysFailEmbeddingClient()
    labeling_client = FakeLabelingClient()
    store = TrackingStore()
    clusterer = FakeClusterer()

    service = GroupingService(embedding_client, labeling_client, store, clusterer)

    with pytest.raises(EmbeddingClientError):
        service.generate_grouping_plan(request)

    # Two attempts should have been made for the failing batch
    assert embedding_client.calls == 2
    # No embeddings should be saved for a batch that never succeeds
    assert store.save_calls == 0



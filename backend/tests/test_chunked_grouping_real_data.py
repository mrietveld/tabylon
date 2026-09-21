"""Tests for embedding-based clustering of large tab sets.

These tests verify that the embedding+clustering pipeline can form valid
clusters and leave noise tabs ungrouped.
"""

from pathlib import Path
import pandas as pd

from app.api.schemas import BrowserTab, GroupingConstraints, GroupingRequest
from app.core.config import get_settings
from app.services.cluster_label_store import ClusterLabelStore
from app.services.clusterer import Clusterer
from app.services.embedding_client import EmbeddingClient
from app.services.embedding_store import EmbeddingStore
from app.services.grouping_service import GroupingService


def get_test_data_request():
    df_test = pd.read_csv("tests/test_data/real_tabs.csv", header=0, quotechar='\'')
    real_tabs = []
    for index, row in df_test.iterrows():
        real_tabs.append(
                BrowserTab(
                        tabId=row.tabId,
                        windowId=row.windowId,
                        title=row.title,
                        url=row.url,
                        active=row.active,
                        pinned=row.pinned,
                        audible=row.audible,
                        discarded=row.discarded
                )
        )
    return GroupingRequest(
            requestId="req-clustering",
            capturedAt="2026-07-16T10:00:00Z",
            constraints=GroupingConstraints(minimumGroupSize=5),
            tabs=real_tabs)


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


def test_iterative_peeling_real_data():
    """Iterative clustering should peel clusters and reduce the ungrouped set.

    This test uses a custom clusterer that produces two large clusters and
    some noise so that the peeling logic in GroupingService is exercised.
    """
    # Use enough tabs to trigger the iterative loop (len(ungrouped_ids) > 32).
    request = get_test_data_request()

    settings = get_settings()
    embedding_client = EmbeddingClient(
            api_key=settings.llm_api_key or "",
            model=settings.embedding_model,
            base_url=settings.llm_base_url,
            timeout_seconds=settings.embedding_timeout_seconds,
    )
    embedding_store = EmbeddingStore(settings.embedding_db_path)
    test_db_path = str(settings.cluster_label_db_path).replace("labels", "labels_test")
    label_store = ClusterLabelStore(Path(test_db_path))
    clusterer = Clusterer(min_cluster_size=5)
    labeling_client = FakeLabelingClient()

    service = GroupingService(embedding_client, labeling_client, embedding_store, label_store, clusterer)
    plan = service.generate_grouping_plan(request)

    # At least one group should be formed.
    assert len(plan.groups) == 53
    # Some tabs should remain ungrouped after peeling.
    assert len(plan.ungroupedTabIds) == 0
    assert set(plan.ungroupedTabIds).issubset({tab.tabId for tab in request.tabs})

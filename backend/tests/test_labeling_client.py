"""Tests for the labeling client batching and prompt behavior."""

import json

import httpx
import pytest

from app.services.labeling_client import LabelingClient, LabelingClientError


def make_cluster_sample(cluster_id: int, titles: list[str]) -> dict[str, object]:
    return {
        "cluster_id": cluster_id,
        "representative_title": f"Rep {cluster_id}",
        "titles": titles,
    }


def test_labeling_client_batches_clusters_in_threes_and_limits_titles():
    """Clusters should be labeled in batches of 3, with top-10 titles per cluster."""

    # Prepare 5 clusters, which should result in 2 batches: 3 + 2.
    cluster_samples = [
        make_cluster_sample(idx, [f"Title {idx}-{i} word " * (i + 1) for i in range(12)])
        for idx in range(5)
    ]

    seen_prompts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_prompts.append(request.content.decode("utf-8"))
        payload = json.loads(request.content.decode("utf-8"))
        clusters_in_prompt = 0
        # Count how many "Cluster X representative" lines we see in the prompt.
        for message in payload["messages"]:
            if message["role"] == "user":
                content = message["content"]
                clusters_in_prompt = content.count("Cluster ")
                # Ensure that no cluster has more than 10 titles listed.
                assert content.count("- ") <= clusters_in_prompt * 10

        # Build a response with one label per cluster in this batch
        # The server doesn't know cluster_ids from the prompt structure here, so
        # we just echo simple sequential IDs [0..clusters_in_prompt-1]; the
        # client doesn't depend on exact IDs for this test.
        clusters = [
            {"cluster_id": i, "name": f"Group {i}", "reason": "Reason"}
            for i in range(clusters_in_prompt)
        ]

        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps({"clusters": clusters})
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    client = LabelingClient(
        api_key="test-api-key",
        model="test-model",
        base_url="https://llm.example.test/v1",
        http_client=http_client,
    )

    result = client.label_clusters(cluster_samples)

    # 5 clusters should have produced 2 HTTP calls (batches of 3 and 2)
    assert len(seen_prompts) == 2
    # The client returns one label per response cluster entry.
    assert len(result) == 5


def test_labeling_client_rejects_mismatched_cluster_counts():
    """If the model returns a different number of clusters than requested, fail fast."""

    cluster_samples = [make_cluster_sample(1, ["a", "b", "c"])]

    def handler(request: httpx.Request) -> httpx.Response:
        # Return zero clusters even though one was requested
        clusters = []
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps({"clusters": clusters})
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    client = LabelingClient(
        api_key="test-api-key",
        model="test-model",
        base_url="https://llm.example.test/v1",
        http_client=http_client,
    )

    with pytest.raises(LabelingClientError, match="count did not match batch size"):
        client.label_clusters(cluster_samples)

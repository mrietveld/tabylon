from app.services.clusterer import Clusterer


def test_clusterer_empty_input():
    clusterer = Clusterer()
    result = clusterer.cluster([])
    assert result.labels == []


def test_clusterer_simple_clusters():
    # Two tight clusters in 2D space and one noise point far away.
    embeddings = [
        [0.0, 0.0],
        [0.1, 0.0],
        [10.0, 10.0],
        [10.1, 10.0],
        [100.0, 100.0],
    ]
    clusterer = Clusterer(min_cluster_size=2)
    result = clusterer.cluster(embeddings)

    labels = result.labels
    assert len(labels) == len(embeddings)
    # The clusterer should return one integer label per embedding.
    assert all(isinstance(label, int) for label in labels)

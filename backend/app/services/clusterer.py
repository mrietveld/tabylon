from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import hdbscan
import numpy as np


@dataclass
class ClusterResult:
    labels: list[int]  # -1 for noise


class Clusterer:
    """HDBSCAN-based clustering over embedding vectors.

    Uses Euclidean distance on unit-normalized vectors to approximate
    cosine similarity.
    """

    def __init__(self, min_cluster_size: int = 5, min_samples: int | None = None) -> None:
        self._min_cluster_size = min_cluster_size
        self._min_samples = min_samples if min_samples is not None else min_cluster_size

    def cluster(self, embeddings: Sequence[Sequence[float]]) -> ClusterResult:
        if not embeddings:
            return ClusterResult(labels=[])

        matrix = np.array(embeddings, dtype=float)
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

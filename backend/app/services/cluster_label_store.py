from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import List, Tuple


class ClusterLabelStore:
    """SQLite-backed storage for cluster labels.

    Cluster membership is represented as a JSON-encoded list of tab IDs,
    paired with a human-readable name and reason. Similarity between
    clusters is measured using Jaccard similarity over the tab ID sets.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)

        self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cluster_labels (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  tab_ids_json TEXT NOT NULL,
                  label_name TEXT NOT NULL,
                  label_reason TEXT NOT NULL,
                  created_at TEXT NOT NULL
                )
                """
        )
        self._conn.commit()

    def save_cluster_labels(self, entries: List[Tuple[List[int], str, str]]) -> None:
        """Persist labels for clusters.

        entries is a list of (tab_ids, label_name, label_reason) tuples.
        """
        if not entries:
            return

        rows = [
            (json.dumps(sorted(tab_ids)), label_name, label_reason)
            for tab_ids, label_name, label_reason in entries
            if tab_ids and label_name and label_reason
        ]
        if not rows:
            return

        self._conn.executemany(
                "INSERT INTO cluster_labels (tab_ids_json, label_name, label_reason, created_at) "
                "VALUES (?, ?, ?, datetime('now'))",
                rows,
        )
        self._conn.commit()

    def get_similar_cluster_label(self, tab_ids: List[int], similarity_threshold: float = 0.9) -> Tuple[str, str] | None:
        """Return a cached (name, reason) for a cluster similar to *tab_ids*.

        Similarity is measured using Jaccard similarity over the tab ID sets,
        and only labels with similarity >= *similarity_threshold* are
        considered. The most similar matching label is returned.
        """
        if not tab_ids:
            return None

        current_set = set(tab_ids)
        cursor = self._conn.execute(
                "SELECT tab_ids_json, label_name, label_reason FROM cluster_labels"
        )

        best_match: Tuple[str, str] | None = None
        best_similarity = 0.0

        for tab_ids_json, label_name, label_reason in cursor.fetchall():
            try:
                saved_ids = json.loads(tab_ids_json)
            except json.JSONDecodeError:
                continue
            if not isinstance(saved_ids, list):
                continue
            saved_set = {int(tab_id) for tab_id in saved_ids if isinstance(tab_id, int) or isinstance(tab_id, float)}
            if not saved_set:
                continue
            intersection = len(current_set & saved_set)
            union = len(current_set | saved_set)
            if union == 0:
                continue
            similarity = intersection / union
            if similarity >= similarity_threshold and similarity > best_similarity:
                best_similarity = similarity
                best_match = (label_name, label_reason)

        return best_match

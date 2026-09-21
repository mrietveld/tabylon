from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Tuple


@dataclass
class EmbeddingRecord:
    tab_key: str
    text_hash: str
    embedding: list[float]


class EmbeddingStore:
    """SQLite-backed storage for tab embeddings.

    Embeddings are keyed by a stable tab_key plus a text_hash so we can
    detect when the underlying text has changed and re-embed.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)

        # Table for per-tab embeddings
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
        """Return embeddings whose stored text_hash matches the requested hash.

        Keys with missing records or mismatched hashes are omitted.
        """
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
        """Persist embeddings for the given tab keys.

        entries maps tab_key -> (text_hash, embedding).
        """
        if not entries:
            return
        rows = [
            (tab_key, text_hash, json.dumps(embedding))
            for tab_key, (text_hash, embedding) in entries.items()
        ]
        self._conn.executemany(
                "REPLACE INTO tab_embeddings (tab_key, text_hash, updated_at, embedding_json) VALUES (?, ?, datetime('now'), ?)",
                rows,
        )
        self._conn.commit()

from pathlib import Path

from app.services.embedding_store import EmbeddingStore


def test_embedding_store_round_trip(tmp_path):
    db_path = tmp_path / "one.sqlite3"
    store = EmbeddingStore(db_path)

    keys_and_hashes = {"key-1": "hash-1"}
    assert store.get_cached_embeddings(keys_and_hashes) == {}

    store.save_embeddings({"key-1": ("hash-1", [0.1, 0.2, 0.3])})
    cached = store.get_cached_embeddings(keys_and_hashes)
    assert "key-1" in cached
    assert cached["key-1"] == [0.1, 0.2, 0.3]


def test_embedding_store_ignores_mismatched_hash(tmp_path):
    db_path = tmp_path / "two.sqlite3"
    store = EmbeddingStore(db_path)

    store.save_embeddings({"key-1": ("hash-1", [0.1])})
    cached = store.get_cached_embeddings({"key-1": "hash-2"})
    assert cached == {}

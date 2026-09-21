"""Tests for environment-based backend settings.

These tests document how operator-provided environment variables control the
backend network and LLM configuration.
"""

from pathlib import Path

from app.core.config import get_settings


ENV_LOCAL_CONTENT = """
TAB_ORGANIZER_HOST=127.0.0.1
TAB_ORGANIZER_PORT=6060
TAB_ORGANIZER_LOG_DIR=/tmp/from-env-local
TAB_ORGANIZER_LLM_API_KEY=env-local-key
TAB_ORGANIZER_LLM_BASE_URL=https://env-local.example.test/v1
TAB_ORGANIZER_EMBEDDING_MODEL=env-local-embed-model
TAB_ORGANIZER_EMBEDDING_TIMEOUT_SECONDS=8.5
TAB_ORGANIZER_LABELING_MODEL=env-local-label-model
TAB_ORGANIZER_LABELING_TIMEOUT_SECONDS=7.5
TAB_ORGANIZER_EMBEDDING_DB_PATH=/tmp/from-env-local/db.sqlite3
""".strip()


def test_get_settings_reads_env_overrides(monkeypatch):
    """Environment variables should override the default backend settings."""
    monkeypatch.setenv("TAB_ORGANIZER_HOST", "127.0.0.1")
    monkeypatch.setenv("TAB_ORGANIZER_PORT", "9000")
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", "/tmp/tab-organizer-logs")
    monkeypatch.setenv("TAB_ORGANIZER_LLM_API_KEY", "test-key")
    monkeypatch.setenv("TAB_ORGANIZER_LLM_MODEL", "test-model")
    monkeypatch.setenv("TAB_ORGANIZER_LLM_BASE_URL", "https://llm.example.test/v1")
    monkeypatch.setenv("TAB_ORGANIZER_LLM_TIMEOUT_SECONDS", "12.5")
    monkeypatch.setenv("TAB_ORGANIZER_EMBEDDING_MODEL", "embed-model")
    monkeypatch.setenv("TAB_ORGANIZER_EMBEDDING_TIMEOUT_SECONDS", "11.5")
    monkeypatch.setenv("TAB_ORGANIZER_LABELING_MODEL", "label-model")
    monkeypatch.setenv("TAB_ORGANIZER_LABELING_TIMEOUT_SECONDS", "10.5")
    monkeypatch.setenv("TAB_ORGANIZER_EMBEDDING_DB_PATH", "/tmp/embeddings.sqlite3")

    settings = get_settings()

    assert settings.host == "127.0.0.1"
    assert settings.port == 9000
    assert settings.log_dir == Path("/tmp/tab-organizer-logs")
    assert settings.llm_api_key == "test-key"
    assert settings.llm_base_url == "https://llm.example.test/v1"
    assert settings.embedding_model == "embed-model"
    assert settings.embedding_timeout_seconds == 11.5
    assert settings.labeling_model == "label-model"
    assert settings.labeling_timeout_seconds == 10.5
    assert settings.embedding_db_path == Path("/tmp/embeddings.sqlite3")


def test_get_settings_reads_backend_env_local_file(monkeypatch, tmp_path):
    """Settings should automatically load values from backend/.env.local when present."""
    env_file = tmp_path / ".env.local"
    env_file.write_text(ENV_LOCAL_CONTENT)

    monkeypatch.delenv("TAB_ORGANIZER_HOST", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_PORT", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LOG_DIR", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LLM_API_KEY", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LLM_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_EMBEDDING_MODEL", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_EMBEDDING_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LABELING_MODEL", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_LABELING_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("TAB_ORGANIZER_EMBEDDING_DB_PATH", raising=False)
    monkeypatch.setenv("TAB_ORGANIZER_ENV_FILE", str(env_file))

    settings = get_settings()

    assert settings.port == 6060
    assert settings.log_dir == Path("/tmp/from-env-local")
    assert settings.llm_api_key == "env-local-key"
    assert settings.llm_base_url == "https://env-local.example.test/v1"
    assert settings.embedding_model == "env-local-embed-model"
    assert settings.embedding_timeout_seconds == 8.5
    assert settings.labeling_model == "env-local-label-model"
    assert settings.labeling_timeout_seconds == 7.5
    assert settings.embedding_db_path == Path("/tmp/from-env-local/db.sqlite3")

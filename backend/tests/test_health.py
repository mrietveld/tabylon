"""Tests for backend startup health and file logging behavior.

These tests intentionally stay small and fast because they exercise the
minimum backend boot path used by the Firefox extension before any grouping
work starts.
"""

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.core.logging_setup import configure_logging


def test_health_endpoint_reports_backend_ok(tmp_path, monkeypatch):
    """The health endpoint should report that the backend is reachable.

    The extension uses this endpoint before attempting to collect tabs and
    request a grouping plan, so the response shape needs to stay stable.
    """
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", str(tmp_path / "logs"))

    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "tab-organizer-backend",
    }


def test_configure_logging_creates_log_directory_and_file(tmp_path):
    """Logging setup should create the target directory and log file path.

    The backend is required to write operational logs to a local log folder,
    so this test locks in that filesystem side effect.
    """
    log_dir = tmp_path / "logs"

    log_file = configure_logging(log_dir)

    assert log_dir.exists()
    assert log_dir.is_dir()
    assert log_file == log_dir / "tab_organizer_backend.log"
    assert isinstance(log_file, Path)

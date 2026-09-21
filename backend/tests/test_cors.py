"""Tests for backend CORS behavior.

These tests protect the extension-to-backend integration by ensuring the local
backend includes the headers the Firefox extension needs to read responses.
"""

from fastapi.testclient import TestClient

from app.main import create_app


EXTENSION_ORIGIN = "moz-extension://tab-organizer-test-origin"


def test_health_endpoint_allows_extension_origin(monkeypatch, tmp_path):
    """Simple GET requests should include a matching CORS allow-origin header."""
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", str(tmp_path / "logs"))

    client = TestClient(create_app())
    response = client.get("/health", headers={"Origin": EXTENSION_ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == EXTENSION_ORIGIN


def test_grouping_endpoint_handles_preflight_for_extension_origin(monkeypatch, tmp_path):
    """The backend should respond to browser preflight requests for JSON POSTs."""
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", str(tmp_path / "logs"))

    client = TestClient(create_app())
    response = client.options(
        "/api/groupings/generate",
        headers={
            "Origin": EXTENSION_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == EXTENSION_ORIGIN
    assert "POST" in response.headers["access-control-allow-methods"]

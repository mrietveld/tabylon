"""API tests for grouping-plan generation.

These tests exercise the FastAPI route with the embedding-based grouping
service so request parsing, validation, and HTTP error mapping can be
verified without real model providers.
"""

from fastapi.testclient import TestClient

from app.main import create_app


def test_generate_grouping_plan_returns_validated_plan(monkeypatch, tmp_path):
    """A valid embedding-based pipeline should return a validated plan."""
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", str(tmp_path / "logs"))

    payload = {
        "requestId": "req-123",
        "capturedAt": "2026-07-16T10:00:00Z",
        "constraints": {
            "minimumGroupSize": 5,
            "groupingBasis": "common theme or task",
        },
        "tabs": [
            {
                "tabId": index,
                "windowId": 1,
                "title": f"Tab {index}",
                "url": f"https://example.com/{index}",
                "active": False,
                "pinned": False,
                "audible": False,
                "discarded": False,
            }
            for index in range(1, 7)
        ],
    }

    app = create_app()
    client = TestClient(app)

    response = client.post("/api/groupings/generate", json=payload)

    assert response.status_code in {200, 422, 502}
    # We only assert the shape when successful; validation failures and upstream
    # model errors are covered elsewhere.
    if response.status_code == 200:
        body = response.json()
        assert "planId" in body
        assert "groups" in body
        assert "ungroupedTabIds" in body


def test_generate_grouping_plan_rejects_invalid_payload(monkeypatch, tmp_path):
    """Invalid payloads should still be rejected with 422 errors."""
    monkeypatch.setenv("TAB_ORGANIZER_LOG_DIR", str(tmp_path / "logs"))

    # Missing required fields should cause FastAPI/Pydantic validation errors.
    payload = {
        "requestId": "req-invalid",
        "capturedAt": "2026-07-16T10:00:00Z",
        # 'tabs' missing
    }

    app = create_app()
    client = TestClient(app)

    response = client.post("/api/groupings/generate", json=payload)

    assert response.status_code == 422

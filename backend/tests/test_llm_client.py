"""Integration-style tests for the concrete LLM client.

These tests use an HTTP mock transport so the client exercises its real request
formatting and response parsing logic without requiring network access.
"""

import httpx
import pytest

from app.api.schemas import BrowserTab, GroupingConstraints, GroupingRequest
from app.services.llm_client import LlmClient, LlmClientError


def make_request() -> GroupingRequest:
    """Create deterministic tab data for an end-to-end client call."""
    return GroupingRequest(
        requestId="req-integration",
        capturedAt="2026-07-16T10:00:00Z",
        constraints=GroupingConstraints(minimumGroupSize=5),
        tabs=[
            BrowserTab(
                tabId=index,
                windowId=1,
                title=f"Tab {index}",
                url=f"https://example.com/{index}",
                active=False,
                pinned=False,
                audible=False,
                discarded=False,
            )
            for index in range(1, 7)
        ],
    )


def test_llm_client_calls_openai_compatible_api_and_parses_grouping_plan():
    """The client should send a chat-completions request and parse JSON content."""

    existing_groups = [
        {
            "groupId": "existing-1",
            "name": "Existing Group",
            "reason": "Already grouped.",
            "tabIds": [101, 102, 103, 104, 105],
        }
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url == httpx.URL("https://llm.example.test/v1/chat/completions")
        assert request.headers["Authorization"] == "Bearer test-api-key"

        payload = __import__("json").loads(request.content.decode("utf-8"))
        assert payload["model"] == "test-model"
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["messages"][0]["role"] == "system"
        assert payload["messages"][1]["role"] == "user"
        assert "Every group must contain at least 5 tabs." in payload["messages"][1]["content"]
        assert "Existing groups that may be preserved or extended:" in payload["messages"][1]["content"]

        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "{\"planId\":\"plan-live\",\"requestId\":\"req-integration\",\"summary\":\"Grouped tabs.\",\"groups\":[{\"groupId\":\"group-1\",\"name\":\"Example\",\"reason\":\"Five tabs share a task.\",\"tabIds\":[1,2,3,4,5]}],\"ungroupedTabIds\":[6],\"warnings\":[]}"
                        }
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)
    llm_client = LlmClient(
        api_key="test-api-key",
        model="test-model",
        base_url="https://llm.example.test/v1",
        http_client=http_client,
    )

    plan = llm_client.generate_grouping(make_request(), existing_groups=existing_groups)

    assert plan["planId"] == "plan-live"
    assert plan["groups"][0]["tabIds"] == [1, 2, 3, 4, 5]
    assert plan["ungroupedTabIds"] == [6]


def test_llm_client_requires_api_key():
    """A missing API key should fail fast with a clear configuration error."""
    llm_client = LlmClient(api_key="", model="test-model")

    with pytest.raises(LlmClientError, match="TAB_ORGANIZER_LLM_API_KEY"):
        llm_client.generate_grouping(make_request())

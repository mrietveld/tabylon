import json
from typing import Any

import httpx

from app.api.schemas import GroupingPlanGroup, GroupingRequest
from app.services.prompt_builder import build_grouping_prompt


class LlmClientError(Exception):
    """Raised when the configured LLM provider cannot return a usable response."""


class LlmClient:
    """Minimal OpenAI-compatible chat completions client.

    The backend uses this client to send a prompt to a local or remote provider
    that supports the OpenAI-style `/chat/completions` API.
    """

    def __init__(
            self,
            api_key: str,
            model: str,
            base_url: str = "https://api.openai.com/v1",
            timeout_seconds: float = 30.0,
            http_client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._http_client = http_client or httpx.Client(timeout=timeout_seconds)

    def generate_grouping(
            self,
            request: GroupingRequest,
            existing_groups: list[GroupingPlanGroup] | None = None,
    ) -> dict[str, Any]:
        if not self._api_key:
            raise LlmClientError("TAB_ORGANIZER_LLM_API_KEY is not configured")

        prompt = build_grouping_prompt(request, existing_groups=existing_groups)

        try:
            response = self._http_client.post(
                    f"{self._base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type":  "application/json",
                    },
                    json={
                        "model":           self._model,
                        "response_format": {"type": "json_object"},
                        "messages":        [
                            {
                                "role":    "system",
                                "content": (
                                    "You are a tab-grouping assistant. "
                                    "Return strict JSON only and do not include markdown fences."
                                ),
                            },
                            {
                                "role":    "user",
                                "content": prompt,
                            },
                        ],
                    },
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise LlmClientError(f"LLM request failed: {error}") from error

        payload = response.json()

        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise LlmClientError("LLM response did not contain a chat completion message") from error

        if not isinstance(content, str) or not content.strip():
            raise LlmClientError("LLM response content was empty")

        try:
            return json.loads(content)
        except json.JSONDecodeError as error:
            raise LlmClientError("LLM response content was not valid JSON") from error

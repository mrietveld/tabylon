from __future__ import annotations

import httpx


class EmbeddingClientError(Exception):
    """Raised when the embedding provider cannot return usable embeddings."""


class EmbeddingClient:
    """Minimal provider-agnostic embedding client.

    Expects an OpenAI-style /embeddings endpoint but does not depend on a
    specific provider name.
    """

    def __init__(
            self,
            api_key: str,
            model: str,
            base_url: str,
            timeout_seconds: float = 30.0,
            http_client: httpx.Client | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._http_client = http_client or httpx.Client(timeout=timeout_seconds)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not self._api_key:
            raise EmbeddingClientError("TAB_ORGANIZER_EMBEDDING_API_KEY is not configured")
        if not texts:
            return []

        try:
            response = self._http_client.post(
                    f"{self._base_url}/embeddings",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type":  "application/json",
                    },
                    json={"model": self._model, "input": texts},
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise EmbeddingClientError(f"Embedding request failed: {error}") from error

        payload = response.json()
        try:
            data = payload["data"]
        except (KeyError, TypeError) as error:
            raise EmbeddingClientError("Embedding response did not contain data") from error

        embeddings: list[list[float]] = []
        for item in data:
            vector = item.get("embedding")
            if not isinstance(vector, list):
                raise EmbeddingClientError("Embedding response contained invalid vector")
            embeddings.append(vector)

        if len(embeddings) != len(texts):
            raise EmbeddingClientError("Embedding response count did not match input count")

        return embeddings

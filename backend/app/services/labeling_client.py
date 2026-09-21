from __future__ import annotations

import json
import logging

import httpx


class LabelingClientError(Exception):
    """Raised when the labeling model cannot return usable labels."""


class LabelingClient:
    """Provider-agnostic client for generating cluster labels.

    Uses a chat-completions style endpoint and expects strict JSON
    responses with a top-level "clusters" list.
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

    def label_clusters(self, cluster_samples: list[dict[str, object]]) -> list[dict[str, str]]:
        if not self._api_key:
            raise LabelingClientError("TAB_ORGANIZER_LABELING_API_KEY is not configured")
        if not cluster_samples:
            return []

        logger = logging.getLogger("tab_organizer")
        all_results: list[dict[str, str]] = []

        batch_size = 3
        for index in range(0, len(cluster_samples), batch_size):
            batch = cluster_samples[index: index + batch_size]
            prompt = self._build_prompt(batch)

            logger.info(f"PROMPT: [{prompt}]")
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
                                        "You label clusters of browser tabs. "
                                        "Return strict JSON only and do not include markdown fences."
                                    ),
                                },
                                {"role": "user", "content": prompt},
                            ],
                        },
                )
                response.raise_for_status()
            except httpx.HTTPError as error:
                raise LabelingClientError(f"Labeling request failed: {error}") from error

            payload = response.json()
            try:
                content = payload["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as error:
                raise LabelingClientError("Labeling response did not contain a chat completion message") from error

            try:
                data = json.loads(content)
            except json.JSONDecodeError as error:
                raise LabelingClientError("Labeling response content was not valid JSON") from error

            clusters = data.get("clusters")
            if not isinstance(clusters, list):
                raise LabelingClientError("Labeling response did not contain a clusters list")

            if len(clusters) != len(batch):
                raise LabelingClientError("Labeling response cluster count did not match batch size")

            for item in clusters:
                try:
                    cluster_id = item["cluster_id"]
                    name = item["name"]
                    reason = item["reason"]
                except (KeyError, TypeError) as error:
                    raise LabelingClientError("Labeling response contained an invalid cluster entry") from error
                all_results.append({"cluster_id": cluster_id, "name": name, "reason": reason})

        return all_results

    def _build_prompt(self, cluster_samples: list[dict[str, object]]) -> str:
        lines = [
            "You will receive clusters of browser tabs and should assign each cluster a short label and brief reason.",
            "Return JSON with a top-level 'clusters' array, where each item has cluster_id, name, and reason.",
        ]
        for item in cluster_samples:
            cluster_id = item["cluster_id"]
            representative_title = item["representative_title"]
            titles = item["titles"]

            # Only submit the top 10 titles by number of words to keep prompts concise.
            sorted_titles = sorted(titles, key=lambda t: len(str(t).split()), reverse=True)
            top_titles = sorted_titles[:10]

            lines.append(f"Cluster {cluster_id} representative: {representative_title!r}")
            lines.append("Titles:")
            for title in top_titles:
                lines.append(f"- {title!r}")
        return "\n".join(lines)

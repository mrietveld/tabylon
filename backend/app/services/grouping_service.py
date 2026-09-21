import hashlib
import logging
from collections import defaultdict
from typing import Dict, List, Tuple
from uuid import uuid4

from app.api.schemas import GroupingPlan, GroupingPlanGroup, GroupingRequest
from app.services.cluster_label_store import ClusterLabelStore
from app.services.clusterer import Clusterer
from app.services.embedding_client import EmbeddingClient
from app.services.embedding_store import EmbeddingStore
from app.services.labeling_client import LabelingClient
from app.services.validator import validate_grouping_plan

logger = logging.getLogger("tab_organizer")

MAX_CLUSTER_SZ = 35

class GroupingService:
    def __init__(
            self,
            embedding_client: EmbeddingClient,
            labeling_client: LabelingClient,
            embedding_store: EmbeddingStore,
            cluster_label_store: ClusterLabelStore,
            clusterer: Clusterer,
    ) -> None:
        self._embedding_client = embedding_client
        self._labeling_client = labeling_client
        self._embedding_store = embedding_store
        self._cluster_label_store = cluster_label_store
        self._clusterer = clusterer
        self._logger = logging.getLogger("tab_organizer")

    def generate_grouping_plan(self, request: GroupingRequest) -> GroupingPlan:
        self._logger.info("Grouping request %s received with %s tabs", request.requestId, len(request.tabs))

        if not request.tabs:
            empty_plan = GroupingPlan(
                    planId=str(uuid4()),
                    requestId=request.requestId,
                    summary="No tabs to group.",
                    groups=[],
                    ungroupedTabIds=[],
                    warnings=[],
            )
            validated = validate_grouping_plan(empty_plan, request)
            self._logger.info("Plan validation succeeded for %s with no tabs", request.requestId)
            return validated

        # Step 1: prepare embedding texts and keys
        tab_keys: Dict[int, str] = {}
        text_hashes: Dict[str, str] = {}
        texts: Dict[str, str] = {}

        for tab in request.tabs:
            normalized_title = (tab.title or "").strip().lower()
            normalized_url = (tab.url or "").strip().lower()
            embedding_text = f"{normalized_title} {normalized_url}".strip()
            # Some environments may send strings containing lone surrogate code
            # points (invalid Unicode) which cannot be encoded as UTF-8. We
            # defensively sanitize the text so hashing and downstream model
            # calls do not fail on such inputs.
            embedding_text = self._sanitize_text(embedding_text)
            safe_bytes = embedding_text.encode("utf-8")

            tab_key = self._build_tab_key(tab.tabId, embedding_text)
            text_hash = hashlib.sha256(safe_bytes).hexdigest()
            tab_keys[tab.tabId] = tab_key
            text_hashes[tab_key] = text_hash
            texts[tab_key] = embedding_text

        # Step 2: load cached embeddings
        cached = self._embedding_store.get_cached_embeddings(text_hashes)
        missing_keys = [key for key in text_hashes.keys() if key not in cached]
        self._logger.info(
                "Embedding cache lookup for request %s: %s cached, %s missing",
                request.requestId,
                len(cached),
                len(missing_keys),
        )
        print(f"Embeddings: {len(cached)} available / {len(missing_keys)} missing")

        # Step 3: embed missing texts in batches
        if missing_keys:
            batch_size = 32
            total_missing = len(missing_keys)
            total_batches = (total_missing + batch_size - 1) // batch_size

            for index in range(0, total_missing, batch_size):
                batch_keys = missing_keys[index: index + batch_size]
                batch_texts = [texts[key] for key in batch_keys]
                batch_number = index // batch_size + 1

                self._logger.info(
                        "Requesting %s new embeddings for grouping request %s (batch %s/%s)",
                        len(batch_texts),
                        request.requestId,
                        batch_number,
                        total_batches,
                )

                self._embed_and_store_batch(
                        batch_keys=batch_keys,
                        batch_texts=batch_texts,
                        text_hashes=text_hashes,
                        cached=cached,
                        request_id=request.requestId,
                )

        # Step 4: build embedding list aligned with tab IDs
        embeddings: List[list[float]] = []
        tab_id_order: List[int] = []

        for tab in request.tabs:
            key = tab_keys[tab.tabId]
            embedding = cached.get(key)
            if embedding is None:
                # This should not happen, but fail-safe: treat as ungrouped.
                self._logger.warning(
                        "Missing embedding for tab %s in request %s; it will be left ungrouped",
                        tab.tabId,
                        request.requestId,
                )
                continue
            embeddings.append(embedding)
            tab_id_order.append(tab.tabId)

        if not embeddings:
            plan = GroupingPlan(
                    planId=str(uuid4()),
                    requestId=request.requestId,
                    summary="No embeddings available for tabs.",
                    groups=[],
                    ungroupedTabIds=[tab.tabId for tab in request.tabs],
                    warnings=["All tabs remain ungrouped because embeddings were unavailable."],
            )
            validated = validate_grouping_plan(plan, request)
            self._logger.info(
                    "Plan validation succeeded for %s with all tabs ungrouped due to missing embeddings",
                    request.requestId,
            )
            return validated

        # Step 5: iteratively cluster embeddings, peeling dense clusters from ungrouped tabs
        min_group_size = request.constraints.minimumGroupSize
        peel_min_size_large = max(min_group_size, 6)
        base_tab_ids = tab_id_order
        base_embeddings = embeddings
        ungrouped_ids: set[int] = set(base_tab_ids)
        final_clusters: List[List[int]] = []

        self._logger.info(
                "Starting iterative clustering for request %s with %s tabs (min_group_size=%s, peel_min_size_large=%s)",
                request.requestId,
                len(base_tab_ids),
                min_group_size,
                peel_min_size_large,
        )

        tot_tids = len(base_tab_ids)

        # Phase 1: iterative clustering while many tabs remain ungrouped
        while len(ungrouped_ids) > 32:
            self._logger.info(
                    "Iterative clustering loop for request %s: %s tabs currently ungrouped",
                    request.requestId,
                    len(ungrouped_ids),
            )

            subset_ids, subset_embs = self._subset_embeddings(base_tab_ids, base_embeddings, ungrouped_ids)

            progressed, found_clusters, grouped_ids = self.run_default_clustering(ungrouped_ids, peel_min_size_large, min_group_size, subset_ids, subset_embs)
            if not progressed:
                assert len(found_clusters) == 0
                assert len(grouped_ids) == 0
                progressed, found_clusters, grouped_ids = self.run_kmeans_clustering(ungrouped_ids, peel_min_size_large, subset_ids, subset_embs)

            final_clusters.extend(found_clusters)
            ungrouped_ids = ungrouped_ids - grouped_ids
            num_ungr_tids = len(ungrouped_ids)
            print(f"Clusters: [{len(final_clusters):2}] {num_ungr_tids:4} ({((tot_tids - num_ungr_tids) / tot_tids) * 100:5.2f}% clustered)")

            if not progressed:
                # Neither algorithm could peel more clusters from the remaining tabs.
                break

        # Step 6: resolve labels, preferring cached labels and only calling the
        # labeling model for clusters that do not have a suitable cached label.
        tab_by_id = {tab.tabId: tab for tab in request.tabs}
        resolved_labels: Dict[int, Dict[str, str]] = {}
        label_entries_for_cache: List[Tuple[List[int], str, str]] = []
        cluster_samples_for_model: List[dict[str, object]] = []

        for index, tab_ids in enumerate(final_clusters):
            if len(tab_ids) < min_group_size:
                continue

            # Try to reuse a cached label when the tab ID set is at least 90% similar
            cached_label = self._cluster_label_store.get_similar_cluster_label(tab_ids, similarity_threshold=0.9)
            if cached_label is not None:
                name, reason = cached_label
                title_source = "cached"
                print(f"Cluster title ({title_source:12}): {index} | {name} | {reason}")
                resolved_labels[index] = {"name": name, "reason": reason}
                self._logger.info(
                        "Reusing cached label for cluster %s in request %s (name=%r)",
                        index,
                        request.requestId,
                        name,
                )
                continue

            # No cached label; prepare a sample for the labeling model
            id_to_index = {tid: idx for idx, tid in enumerate(base_tab_ids)}
            member_indices = [id_to_index[tid] for tid in tab_ids if tid in id_to_index]
            member_embeddings = [base_embeddings[i] for i in member_indices]
            centroid = self._compute_centroid(member_embeddings)
            representative_index = self._nearest_embedding_index(member_embeddings, centroid)
            representative_tab_id = tab_ids[representative_index]
            representative_title = tab_by_id[representative_tab_id].title or "(untitled)"
            titles = [tab_by_id[tid].title or "(untitled)" for tid in tab_ids]

            cluster_samples_for_model.append(
                    {
                        "cluster_id":           index,
                        "representative_title": representative_title,
                        "titles":               titles,
                    }
            )

        # Step 7: label only those clusters that do not have cached labels
        if cluster_samples_for_model:
            labels_for_clusters = self._labeling_client.label_clusters(cluster_samples_for_model)
            for item in labels_for_clusters:
                cluster_id = item["cluster_id"]
                name = item["name"]
                reason = item["reason"]
                resolved_labels[cluster_id] = {"name": name, "reason": reason}
                # Queue this label for caching so future similar clusters can reuse it.
                # We use the original tab_ids from final_clusters.
                title_source = "retrieved"
                print(f"Cluster title ({title_source:12}): {cluster_id} | {name} | {reason}")
                label_entries_for_cache.append((final_clusters[cluster_id], name, reason))

            if label_entries_for_cache:
                self._cluster_label_store.save_cluster_labels(label_entries_for_cache)

        # Step 8: build groups and ungrouped list from resolved labels
        groups: List[GroupingPlanGroup] = []
        total_clu_tabs = 0
        for idx, tabs in enumerate(final_clusters):
            total_clu_tabs += len(tabs)
            print(f"Final: {idx:2}: {len(tabs)}")
        print(f"Clustered: {total_clu_tabs}")

        for index, tab_ids in enumerate(final_clusters):
            if len(tab_ids) < min_group_size:
                continue
            label_info = resolved_labels.get(index)
            if label_info is None:
                # Fallback, should be rare: assign a generic name/reason.
                label_info = {"name": f"Cluster {index}", "reason": "Embedding-based cluster."}
            name = label_info["name"]
            reason = label_info["reason"]

            print(f"Group: {index:2} - {len(tab_ids):3} [{name:>16}/{reason}]")
            group = GroupingPlanGroup(
                    groupId=f"cluster-{index}",
                    name=name,
                    reason=reason,
                    tabIds=tab_ids,
            )
            groups.append(group)

        # Any tab that did not make it into groups becomes ungrouped
        known_tab_ids = {tab.tabId for tab in request.tabs}
        grouped_ids = {tab_id for group in groups for tab_id in group.tabIds}
        ungrouped_ids_set = set(known_tab_ids) - set(grouped_ids)

        ungrouped_ids_sorted = sorted(ungrouped_ids_set)
        warnings: List[str] = []
        if ungrouped_ids_sorted:
            warnings.append(
                    f"{len(ungrouped_ids_sorted)} tabs remain ungrouped after iterative clustering."
            )

        summary = "Grouped tabs into iterative embedding-based clusters." if groups else "No clusters met the minimum group size."

        plan = GroupingPlan(
                planId=str(uuid4()),
                requestId=request.requestId,
                summary=summary,
                groups=groups,
                ungroupedTabIds=ungrouped_ids_sorted,
                warnings=warnings,
        )

        validated = validate_grouping_plan(plan, request)
        self._logger.info(
                "Plan validation succeeded for %s with %s groups and %s ungrouped tabs",
                request.requestId,
                len(validated.groups),
                len(validated.ungroupedTabIds),
        )
        return validated

    def run_default_clustering(self, selected_ids: set[int], peel_min_size: int, min_group_size: int, subset_ids: List[int], subset_embs: List[List[float]]) -> tuple[
        bool, List[List[int]], set]:
        """Run the default clusterer on the selected IDs and peel dense clusters.

        Returns True if any clusters were peeled, False otherwise.
        """
        if not selected_ids:
            return False, [], set()

        # Configure default Clusterer with current min_group_size
        self._clusterer._min_cluster_size = min_group_size
        self._logger.info("Default clustering (HDBSCAN) on %s ungrouped tabs", len(subset_ids))
        cluster_result = self._clusterer.cluster(subset_embs)
        labels = cluster_result.labels

        subset_clusters: Dict[int, List[int]] = defaultdict(list)
        subset_noise: List[int] = []

        for tab_id, label in zip(subset_ids, labels):
            if label == -1:
                subset_noise.append(tab_id)
            else:
                subset_clusters[label].append(tab_id)
        tabs_clustered = len(subset_ids) - len(subset_noise)
        print(
                f"Default clustering: {len(subset_clusters.keys()):2} clusters using {tabs_clustered:3} tabs [{(tabs_clustered / len(subset_ids)) * 100:4.2f}%] (Noise: {len(subset_noise):3})")

        peelable: List[tuple[int, List[int]]] = [
            (label, tab_ids)
            for label, tab_ids in subset_clusters.items()
            if len(tab_ids) >= peel_min_size
        ]

        if len(peelable) < 2:
            self._logger.info(
                    "Default clustering found fewer than 2 peelable clusters; switching algorithm",
            )
            return False, [], set()

        # Compute density for each peelable cluster and peel the N-1 most dense
        clusters_with_density: List[tuple[float, int, List[int]]] = []
        for label, tab_ids in sorted(peelable, key=lambda x: x[0]):
            # Map tab_ids to embeddings within subset_embs
            id_to_index = {tid: idx for idx, tid in enumerate(subset_ids)}
            member_embs = [subset_embs[id_to_index[tid]] for tid in tab_ids if tid in id_to_index]
            density = self._cluster_density(member_embs)
            clusters_with_density.append((density, label, tab_ids))
        clusters_with_density.sort(key=lambda item: item[0])  # most dense first ("density" is mean distance to centroid)

        grouped_ids: set = set()
        found_clusters: List[List[int]] = []

        # Peel off N-1 most dense clusters
        for density, label, tab_ids in clusters_with_density[:-1]:
            print(f"Peeling  : {label:2} | {density:2.4f} | {len(tab_ids)}")
            self._logger.info(
                    "Peeling default cluster %s (density=%.4f, size=%s)",
                    label,
                    density,
                    len(tab_ids),
            )
            found_clusters.append(tab_ids)
            for tid in tab_ids:
                grouped_ids.add(tid)

        sparse = clusters_with_density[-1]
        if sparse[0] < 0.67 or len(sparse[2]) < 40:
            density, label, tab_ids = sparse
            print(f"Also Peel: {label:2} | {density:2.4f} | {len(tab_ids)}")
            found_clusters.append(tab_ids)
            for tid in tab_ids:
                grouped_ids.add(tid)
        else:
            print(f">Exclude : {sparse[1]:2} | {sparse[0]:2.4f} | {len(sparse[2])}")

        return True, found_clusters, grouped_ids

    # Helper function to run KMeans-based clustering on a subset of tab IDs
    def run_kmeans_clustering(self, selected_ids: set[int], peel_min_size: int, subset_ids: List[int], subset_embs: List[List[float]]) -> tuple[bool, List[List[int]], set]:
        """Run KMeans on the selected IDs and peel dense clusters.

        Returns True if any clusters were peeled, False otherwise.
        """
        if not selected_ids:
            return False, [], set()

        from sklearn.cluster import KMeans

        # Determine cluster count per user rule: n_clusters = min(6, max(3, len(ungrouped) / minimumGroupSize))
        if peel_min_size > 0:
            max_by_size = len(subset_ids) // MAX_CLUSTER_SZ
        else:
            max_by_size = 0
        raw_n = max(3, max_by_size)
        n_clusters = max(6, raw_n)
        print(f"KMeans attempt: [{n_clusters}] clusters.")

        if n_clusters < 3:
            self._logger.info(
                    "KMeans skipped; not enough tabs (%s) for 3 clusters of size >= %s",
                    len(subset_ids),
                    peel_min_size,
            )
            return False, [], set()

        self._logger.info(
                "KMeans clustering on %s ungrouped tabs (n_clusters=%s)",
                len(subset_ids),
                n_clusters,
        )
        kmeans = KMeans(n_clusters=n_clusters, random_state=0)
        labels = kmeans.fit_predict(subset_embs)

        subset_clusters: Dict[int, List[int]] = defaultdict(list)
        for tab_id, label in zip(subset_ids, labels):
            subset_clusters[label].append(tab_id)
        print(f"KMeans clustering : {len(subset_clusters.keys()):2} clusters using {len(subset_ids):3} tabs")

        peelable: List[List[int]] = [
            tab_ids for tab_ids in subset_clusters.values() if len(tab_ids) >= peel_min_size
        ]

        if len(peelable) < 2:
            self._logger.info("KMeans found fewer than 2 peelable clusters; stopping", )
            return False, [], set()

        clusters_with_density: List[tuple[float, List[int]]] = []
        id_to_index = {tid: idx for idx, tid in enumerate(subset_ids)}
        for tab_ids in peelable:
            member_embs = [subset_embs[id_to_index[tid]] for tid in tab_ids if tid in id_to_index]
            density = self._cluster_density(member_embs)
            clusters_with_density.append((density, tab_ids))
        clusters_with_density.sort(key=lambda item: item[0])  # most dense first

        grouped_ids: set = set()
        found_clusters: List[List[int]] = []

        # Peel off N-1 most dense clusters
        for density, tab_ids in clusters_with_density:
            if len(tab_ids) > MAX_CLUSTER_SZ:
                print(f">Exclude : {density:2.4f} | {len(tab_ids)}")
                continue
            print(f"Peeling  : {density:2.4f} | {len(tab_ids)}")
            self._logger.info(
                    "Peeling KMeans cluster (density=%.4f, size=%s)",
                    density,
                    len(tab_ids),
            )
            found_clusters.append(tab_ids)
            for tid in tab_ids:
                grouped_ids.add(tid)

        if len(found_clusters) == 0:
            return False, [], set()

        return True, found_clusters, grouped_ids

    def _embed_and_store_batch(
            self,
            batch_keys: list[str],
            batch_texts: list[str],
            text_hashes: dict[str, str],
            cached: dict[str, list[float]],
            request_id: str,
    ) -> None:
        """Embed a batch of texts, retrying once on failure, and persist results.

        Successful embeddings are saved immediately and the in-memory cache is
        updated. If both attempts fail, the last error is re-raised, aborting the
        grouping request while preserving any previously saved embeddings.
        """
        attempts = 0
        last_error: Exception | None = None

        while attempts < 2:
            attempts += 1
            try:
                embeddings = self._embedding_client.embed(batch_texts)
                entries = {
                    key: (text_hashes[key], embedding)
                    for key, embedding in zip(batch_keys, embeddings)
                }
                # Persist new embeddings for this batch and update the in-memory cache.
                self._embedding_store.save_embeddings(entries)
                for key, (_, embedding) in entries.items():
                    cached[key] = embedding
                return
            except Exception as error:  # noqa: BLE001
                last_error = error
                self._logger.warning(
                        "Embedding batch failed (attempt %s/2) for request %s: %s",
                        attempts,
                        request_id,
                        error,
                )

        self._logger.error(
                "Embedding batch failed after 2 attempts for request %s; aborting grouping",
                request_id,
        )
        if last_error is not None:
            raise last_error

    @staticmethod
    def _sanitize_text(text: str) -> str:
        """Return a UTF-8-safe version of *text*.

        Some tab titles/URLs may arrive containing lone surrogate code points,
        which are invalid in Unicode and cannot be encoded as UTF-8. We
        normalize such inputs by replacing invalid sequences with the Unicode
        replacement character so hashing and downstream model calls are robust.
        """
        if not text:
            return ""
        return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")

    @staticmethod
    def _build_tab_key(tab_id: int, embedding_text: str) -> str:
        # embedding_text is expected to have been sanitized already.
        return hashlib.sha256(f"{tab_id}:{embedding_text}".encode("utf-8")).hexdigest()

    @staticmethod
    def _compute_centroid(vectors: List[List[float]]) -> List[float]:
        import numpy as np

        if not vectors:
            return []
        matrix = np.array(vectors, dtype=float)
        centroid = matrix.mean(axis=0)
        return centroid.tolist()

    @staticmethod
    def _nearest_embedding_index(vectors: List[List[float]], centroid: List[float]) -> int:
        import numpy as np

        if not vectors or not centroid:
            return 0
        matrix = np.array(vectors, dtype=float)
        centroid_vec = np.array(centroid, dtype=float)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        matrix = matrix / norms
        centroid_norm = np.linalg.norm(centroid_vec)
        if centroid_norm == 0:
            centroid_norm = 1.0
        centroid_vec = centroid_vec / centroid_norm
        similarities = matrix @ centroid_vec
        return int(similarities.argmax())

    @staticmethod
    def _subset_embeddings(
            base_tab_ids: List[int],
            base_embeddings: List[List[float]],
            selected_ids: set[int],
    ) -> tuple[List[int], List[List[float]]]:
        """Return tab IDs and embeddings restricted to the selected IDs.

        The IDs are returned in sorted order for stability.
        """
        id_to_index = {tab_id: idx for idx, tab_id in enumerate(base_tab_ids)}
        subset_ids = sorted(selected_ids)
        subset_embs = [base_embeddings[id_to_index[tid]] for tid in subset_ids if tid in id_to_index]
        return subset_ids, subset_embs

    def _cluster_density(self, vectors: List[List[float]]) -> float:
        """Compute an average distance-to-centroid density score for a cluster.

        Lower values indicate denser clusters.
        """
        import numpy as np

        if not vectors:
            return float("inf")
        centroid = self._compute_centroid(vectors)
        if not centroid:
            return float("inf")
        matrix = np.array(vectors, dtype=float)
        centroid_vec = np.array(centroid, dtype=float)
        diffs = matrix - centroid_vec
        distances = np.linalg.norm(diffs, axis=1)
        return float(distances.mean())

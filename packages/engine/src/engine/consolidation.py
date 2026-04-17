"""
engine/consolidation.py
=======================
MemoryConsolidator — a sleep-cycle analogue for episodic memory pruning.

During biological sleep the hippocampus "replays" the day's episodic memories
and consolidates them: highly similar traces are merged and redundant copies
are pruned.  This module mimics that process:

1. Each raw episodic log string is embedded via the shared character-level
   embedding layer (same weights as app.py's ``_EMBEDDING``).
2. A *pairwise* Epanechnikov similarity matrix is computed over the mean-pooled
   embedding vectors — using the *inverse* of the bounded-parabolic kernel
   to measure *similarity* rather than distance.
3. Any pair whose similarity exceeds ``prune_threshold`` (default 0.9) causes
   the *later* log to be flagged for deletion ("Memory Pruning").
4. The surviving logs are concatenated into a ``consolidated_context`` string
   for downstream consumption.

Usage::

    consolidator = MemoryConsolidator(embedding, prune_threshold=0.9)
    result = consolidator.consolidate(["log A", "log B", "log B (near duplicate)"])
    # result.indices_to_delete  → [2]
    # result.consolidated_context → "log A\nlog B"
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class ConsolidationResult:
    """Output of :meth:`MemoryConsolidator.consolidate`.

    Attributes:
        indices_to_delete:      Indices into the original log list that are
                                flagged as redundant and should be pruned.
        consolidated_context:   Newline-joined surviving log strings, ready
                                to be used as the distilled memory context.
        similarity_matrix:      Full ``(N, N)`` pairwise Epanechnikov
                                similarity matrix (CPU float tensor, detached).
    """

    indices_to_delete: List[int] = field(default_factory=list)
    consolidated_context: str = ""
    similarity_matrix: List[List[float]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# MemoryConsolidator
# ---------------------------------------------------------------------------


class MemoryConsolidator:
    """Sleep-cycle memory consolidator using Epanechnikov pairwise similarity.

    Args:
        embedding:       A ``torch.nn.Embedding`` layer used to convert
                         character byte-ids to dense vectors.  Typically the
                         same singleton instance as used in ``app.py``.
        prune_threshold: Similarity value in ``[0, 1]`` above which a log
                         is considered a near-duplicate and flagged for
                         deletion.  Default: ``0.9``.
        tau:             Epanechnikov bandwidth parameter.  Higher values make
                         the similarity kernel sharper (sparser non-zeros).
                         Default: ``1.0``.
        text_limit:      Maximum number of UTF-8 bytes taken from each log
                         string before embedding.  Default: ``2048``.
    """

    def __init__(
        self,
        embedding: nn.Embedding,
        prune_threshold: float = 0.9,
        tau: float = 1.0,
        text_limit: int = 2048,
    ) -> None:
        if not (0.0 <= prune_threshold <= 1.0):
            raise ValueError(
                f"`prune_threshold` must be in [0, 1], got {prune_threshold}"
            )
        if tau <= 0:
            raise ValueError(f"`tau` must be positive, got {tau}")

        self.embedding = embedding
        self.prune_threshold = prune_threshold
        self.tau = tau
        self.text_limit = text_limit

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _embed_log(self, text: str) -> Tensor:
        """Embed a single log string → mean-pooled vector ``(D,)``."""
        text = text[: self.text_limit]
        byte_ids = torch.tensor(
            [b % 256 for b in text.encode("utf-8")],
            dtype=torch.long,
        )  # (T,)

        if byte_ids.numel() == 0:
            # Edge case: empty string → zero vector
            d_model = self.embedding.embedding_dim
            return torch.zeros(d_model)

        with torch.no_grad():
            embedded = self.embedding(byte_ids)  # (T, D)

        # Mean-pool across token dimension → (D,)
        return embedded.mean(dim=0)

    @staticmethod
    def _epanechnikov_similarity(a: Tensor, b: Tensor, tau: float) -> float:
        """Compute the Epanechnikov similarity score between two ``(D,)`` vectors.

        Steps (mirrors the ASE Layer's inline kernel):
            1. Cosine similarity → cos_sim ∈ [-1, 1]
            2. Rescale to [0, 1]: x = (cos_sim + 1) / 2
            3. Apply Epanechnikov kernel: S = max(0, 1 − τ·(1 − x)²)

        Note: we do *not* normalise across keys here because we are computing
        a single pairwise score, not a full attention distribution.
        """
        cos_sim = F.cosine_similarity(a.unsqueeze(0), b.unsqueeze(0)).item()
        x = (cos_sim + 1.0) / 2.0  # ∈ [0, 1]
        score = max(0.0, 1.0 - tau * (1.0 - x) ** 2)
        return score

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def consolidate(self, logs: List[str]) -> ConsolidationResult:
        """Run the sleep-cycle consolidation pass over *logs*.

        Algorithm
        ---------
        1. Embed every log string to a mean-pooled ``(D,)`` vector.
        2. Compute the upper-triangular pairwise Epanechnikov similarity.
        3. For each pair ``(i, j)`` with ``i < j`` whose similarity exceeds
           ``prune_threshold``, mark index ``j`` for deletion (the *later*
           entry is considered the redundant copy).
        4. Build ``consolidated_context`` from the non-deleted logs.

        Args:
            logs: Raw episodic text strings representing the day's log entries.
                  May be empty; returns an empty result in that case.

        Returns:
            A :class:`ConsolidationResult` with the pruned indices, the
            distilled context string, and the full similarity matrix.
        """
        if not logs:
            return ConsolidationResult()

        n = len(logs)

        # Step 1: Embed all logs
        vectors: List[Tensor] = [self._embed_log(log) for log in logs]

        # Step 2: Build full N×N similarity matrix
        sim_matrix: List[List[float]] = [
            [0.0] * n for _ in range(n)
        ]
        to_delete: set[int] = set()

        for i in range(n):
            sim_matrix[i][i] = 1.0  # self-similarity is always 1
            for j in range(i + 1, n):
                score = self._epanechnikov_similarity(
                    vectors[i], vectors[j], self.tau
                )
                sim_matrix[i][j] = score
                sim_matrix[j][i] = score  # symmetric

                # Step 3: Flag the later (j) entry for deletion
                if score > self.prune_threshold:
                    to_delete.add(j)

        # Step 4: Build consolidated context from surviving logs
        indices_to_delete = sorted(to_delete)
        surviving_logs = [
            log for idx, log in enumerate(logs) if idx not in to_delete
        ]
        consolidated_context = "\n".join(surviving_logs)

        return ConsolidationResult(
            indices_to_delete=indices_to_delete,
            consolidated_context=consolidated_context,
            similarity_matrix=sim_matrix,
        )

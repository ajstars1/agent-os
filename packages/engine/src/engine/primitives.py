"""
engine/primitives.py
====================
Custom PyTorch primitives used by the neural engine.

Three operations are provided:

1. bind_vectors        – Holographic Binding via element-wise Hadamard product.
2. compute_surprise    – Astrocyte Surprise Metric (query-vector variance).
3. epanechnikov_attention – Bounded parabolic attention replacing Softmax.

All functions are differentiable; gradients flow through every operation.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import Tensor


# ---------------------------------------------------------------------------
# 1. Holographic Binding
# ---------------------------------------------------------------------------

def bind_vectors(x: Tensor, y: Tensor) -> Tensor:
    """Bind a concept vector *x* to a role vector *y* via Hadamard product.

    This is the standard binding operation used in Holographic Reduced
    Representations (HRRs).  The result lives in the same vector space and
    can be unbound by element-wise division (or approximate unbinding via the
    pseudo-inverse).

    Args:
        x: Concept vector of shape ``(..., D)``.
        y: Role vector of shape ``(..., D)``  (broadcast-compatible with *x*).

    Returns:
        Bound vector of shape ``(..., D)``.  Gradients flow through both
        inputs.

    Example::

        concept = torch.randn(8, 512)
        role    = torch.randn(8, 512)
        bound   = bind_vectors(concept, role)   # shape (8, 512)
    """
    if x.shape != y.shape:
        # Allow broadcasting; torch will raise a descriptive error if shapes
        # are truly incompatible.
        pass
    return x * y


# ---------------------------------------------------------------------------
# 2. Astrocyte Surprise Metric
# ---------------------------------------------------------------------------

def compute_surprise(q: Tensor) -> Tensor:
    """Compute the *astrocyte surprise* of a batch of query vectors.

    Surprise is measured as the variance of each query vector across its
    hidden dimension (dim=-1).  High variance → the query activates many
    distinct dimensions → the input is considered *novel*.  Low variance →
    the query is concentrated / familiar.

    Args:
        q: Query tensor of shape ``(B, H, D)`` or any shape where the last
           dimension is the hidden/feature dimension.

    Returns:
        Surprise scalar tensor of shape ``(B, H)`` (or the leading dims of
        *q* minus the last), representing per-head per-token surprise.
        Gradients flow through the variance computation.

    Example::

        queries  = torch.randn(4, 8, 64)        # (batch, heads, d_head)
        surprise = compute_surprise(queries)    # (4, 8)
    """
    # Variance along the last (hidden) dimension, keeping the rest.
    # torch.var uses Bessel's correction (unbiased=True) by default.
    return torch.var(q, dim=-1)


# ---------------------------------------------------------------------------
# 3. Epanechnikov Attention
# ---------------------------------------------------------------------------

def epanechnikov_attention(q: Tensor, k: Tensor, tau: float = 1.0) -> Tensor:
    """Bounded parabolic attention weight function replacing Softmax.

    Algorithm
    ---------
    Given queries **Q** ``(B, H, T_q, D)`` and keys **K** ``(B, H, T_k, D)``:

    1. Compute *normalised* cosine similarity between every query and key pair,
       giving scores in ``[-1, 1]``.
    2. Rescale to ``[0, 1]``:  ``x = (cos_sim + 1) / 2``.
    3. Apply the Epanechnikov kernel:
       ``S(x) = max(0, 1 − τ · (1 − x)²)``
    4. Normalise across the key dimension (``dim=-1``) so weights sum to 1
       (equivalent to what Softmax does in standard attention).

    The Epanechnikov kernel is bounded, has compact support when τ > 1, and
    gives zero weight to sufficiently dissimilar keys — a form of *sparse*
    attention that keeps gradients well-scaled.

    Args:
        q:   Query tensor ``(B, H, T_q, D)`` or ``(B, T_q, D)``.
        k:   Key tensor   ``(B, H, T_k, D)`` or ``(B, T_k, D)``.
        tau: Bandwidth / sharpness parameter (``τ > 0``).  Higher values
             concentrate attention on the most similar keys.  Default: 1.0.

    Returns:
        Attention weights of the same leading shape as ``(B, H, T_q, T_k)``
        (or ``(B, T_q, T_k)``), summing to 1 along ``dim=-1``.  Fully
        differentiable.

    Example::

        B, H, T, D = 2, 4, 16, 64
        q = torch.randn(B, H, T, D)
        k = torch.randn(B, H, T, D)
        weights = epanechnikov_attention(q, k, tau=1.5)  # (2, 4, 16, 16)
    """
    if tau <= 0:
        raise ValueError(f"`tau` must be positive, got {tau}")

    # --- Step 1: normalised cosine similarity --------------------------------
    # Normalise along the feature dimension so dot-product == cosine similarity.
    q_norm = F.normalize(q, p=2, dim=-1)   # (..., T_q, D)
    k_norm = F.normalize(k, p=2, dim=-1)   # (..., T_k, D)

    # Batched matrix multiply: (..., T_q, D) × (..., D, T_k) → (..., T_q, T_k)
    cos_sim = torch.matmul(q_norm, k_norm.transpose(-2, -1))  # ∈ [-1, 1]

    # --- Step 2: rescale to [0, 1] -------------------------------------------
    x = (cos_sim + 1.0) / 2.0  # ∈ [0, 1]

    # --- Step 3: Epanechnikov kernel S(x) = max(0, 1 − τ(1 − x)²) ----------
    scores = torch.clamp(1.0 - tau * (1.0 - x) ** 2, min=0.0)

    # --- Step 4: normalise across key dimension ------------------------------
    # Add a small epsilon to avoid division by zero when all scores are 0.
    scores_sum = scores.sum(dim=-1, keepdim=True).clamp(min=1e-9)
    weights = scores / scores_sum

    return weights

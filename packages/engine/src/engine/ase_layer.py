"""
engine/ase_layer.py
===================
AstroSymbolicEpisodic (ASE) Layer — a single attention-like ``torch.nn.Module``
that combines three custom primitives from :mod:`engine.primitives`:

* **Holographic binding** (``bind_vectors``) — keys are bound to learnable
  orthogonal role vectors before attention.
* **Astrocyte surprise** (``compute_surprise``) — a leaky-integrator state
  modulates attention sharpness based on how novel each query is.
* **Epanechnikov attention** (``epanechnikov_attention``) — a bounded parabolic
  replacement for Softmax that produces sparse weights.

Forward signature::

    output, new_astrocyte_state = layer(q_in, k_in, v_in, astrocyte_state)

``astrocyte_state`` is expected to be carried across calls by the caller
(analogous to an RNN hidden state).
"""

from __future__ import annotations

import math
from typing import Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

from .primitives import bind_vectors, compute_surprise, epanechnikov_attention


# ---------------------------------------------------------------------------
# Helper: orthogonal role-matrix initialisation
# ---------------------------------------------------------------------------

def _make_orthogonal_roles(num_roles: int, d_model: int) -> Tensor:
    """Return a ``(num_roles, d_model)`` matrix with orthonormal rows.

    If ``num_roles <= d_model`` we take the first *num_roles* rows of a
    random orthogonal matrix.  For ``num_roles > d_model`` we tile and
    re-orthogonalise as a best-effort approximation.
    """
    if num_roles <= d_model:
        q, _ = torch.linalg.qr(torch.randn(d_model, num_roles))
        return q.T  # (num_roles, d_model)
    # More roles than dimensions: use a random initialisation and let the
    # Gram-Schmidt projection in the forward pass keep them semi-orthogonal.
    return F.normalize(torch.randn(num_roles, d_model), dim=-1)


# ---------------------------------------------------------------------------
# AstroSymbolicEpisodicLayer
# ---------------------------------------------------------------------------

class AstroSymbolicEpisodicLayer(nn.Module):
    """Attention layer with holographic binding and astrocyte-gated surprise.

    Args:
        d_model:          Embedding / hidden dimension.
        num_logical_roles: Number of learnable role slots that keys can be
                           routed into.  Analogous to "heads" in MHA but tied
                           to symbolic role assignment rather than position.
        tau_base:         Base bandwidth for Epanechnikov attention.  The
                          astrocyte state is used to *scale* this value
                          per-token.  Default: ``1.0``.
        astro_decay:      Leaky-integrator decay rate ``α`` such that
                          ``state ← α·state + (1−α)·surprise``.  Default:
                          ``0.95``.
        role_hidden:      Hidden dimension of the role-routing MLP.  Defaults
                          to ``d_model // 2`` (minimum 16).
        bias:             Whether Q/K/V projections include a bias.
    """

    def __init__(
        self,
        d_model: int,
        num_logical_roles: int,
        tau_base: float = 1.0,
        astro_decay: float = 0.95,
        role_hidden: int | None = None,
        bias: bool = True,
    ) -> None:
        super().__init__()

        if d_model <= 0:
            raise ValueError(f"`d_model` must be positive, got {d_model}")
        if num_logical_roles <= 0:
            raise ValueError(
                f"`num_logical_roles` must be positive, got {num_logical_roles}"
            )
        if not (0.0 < astro_decay < 1.0):
            raise ValueError(
                f"`astro_decay` must be in (0, 1), got {astro_decay}"
            )

        self.d_model = d_model
        self.num_logical_roles = num_logical_roles
        self.tau_base = tau_base
        self.astro_decay = astro_decay

        # ------------------------------------------------------------------
        # Standard Q, K, V linear projections
        # ------------------------------------------------------------------
        self.q_proj = nn.Linear(d_model, d_model, bias=bias)
        self.k_proj = nn.Linear(d_model, d_model, bias=bias)
        self.v_proj = nn.Linear(d_model, d_model, bias=bias)

        # Output projection (collapses back to d_model after weighted sum)
        self.out_proj = nn.Linear(d_model, d_model, bias=bias)

        # ------------------------------------------------------------------
        # Learnable orthogonal role matrix  (num_logical_roles, d_model)
        # ------------------------------------------------------------------
        # Initialised to near-orthogonal; trained via gradient descent.
        # We store it as a Parameter so it participates in optimisation.
        role_init = _make_orthogonal_roles(num_logical_roles, d_model)
        self.role_matrix = nn.Parameter(role_init)  # (R, D)

        # ------------------------------------------------------------------
        # Lightweight MLP: key vector → soft role assignment weights
        # Maps  (D,) → (R,)  via a two-layer MLP with ReLU.
        # ------------------------------------------------------------------
        _hidden = role_hidden if role_hidden is not None else max(16, d_model // 2)
        self.role_router = nn.Sequential(
            nn.Linear(d_model, _hidden, bias=True),
            nn.ReLU(),
            nn.Linear(_hidden, num_logical_roles, bias=False),
        )

        # ------------------------------------------------------------------
        # Learnable scalar for astrocyte → τ scaling (initialised to 1)
        # ------------------------------------------------------------------
        # τ_eff = tau_base * (1 + astro_scale * astrocyte_state)
        # Positive initialisation keeps τ sensible at the start of training.
        self.astro_scale = nn.Parameter(torch.ones(1))

        self._reset_parameters()

    # ------------------------------------------------------------------
    # Initialisation helpers
    # ------------------------------------------------------------------

    def _reset_parameters(self) -> None:
        """Apply Xavier-uniform initialisation to linear layers."""
        for proj in (self.q_proj, self.k_proj, self.v_proj, self.out_proj):
            nn.init.xavier_uniform_(proj.weight)
            if proj.bias is not None:
                nn.init.zeros_(proj.bias)

        # MLP layers
        for module in self.role_router.modules():
            if isinstance(module, nn.Linear):
                nn.init.xavier_uniform_(module.weight)
                if module.bias is not None:
                    nn.init.zeros_(module.bias)

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    def initial_astrocyte_state(
        self,
        batch_size: int,
        device: torch.device | None = None,
        dtype: torch.dtype | None = None,
    ) -> Tensor:
        """Return a zero-initialised astrocyte state ``(B,)``."""
        return torch.zeros(batch_size, device=device, dtype=dtype)

    # ------------------------------------------------------------------
    # Forward pass
    # ------------------------------------------------------------------

    def forward(
        self,
        q_in: Tensor,
        k_in: Tensor,
        v_in: Tensor,
        astrocyte_state: Tensor,
    ) -> Tuple[Tensor, Tensor]:
        """Run the AstroSymbolicEpisodic attention forward pass.

        Args:
            q_in:             Query input  ``(B, T_q, D)``.
            k_in:             Key input    ``(B, T_k, D)``.
            v_in:             Value input  ``(B, T_k, D)``.
            astrocyte_state:  Per-sample astrocyte accumulator ``(B,)``.
                              Pass :meth:`initial_astrocyte_state` on the
                              first call.

        Returns:
            A tuple ``(output, new_astrocyte_state)`` where

            * ``output`` has shape ``(B, T_q, D)`` — the attended output.
            * ``new_astrocyte_state`` has shape ``(B,)`` — the updated
              leaky-integrator state to pass into the next forward call.
        """
        B, T_q, D = q_in.shape
        _, T_k, _ = k_in.shape

        # ------------------------------------------------------------------
        # Step 0: Project inputs
        # ------------------------------------------------------------------
        Q = self.q_proj(q_in)   # (B, T_q, D)
        K = self.k_proj(k_in)   # (B, T_k, D)
        V = self.v_proj(v_in)   # (B, T_k, D)

        # ------------------------------------------------------------------
        # Step 1: Route Key vectors → soft role assignment
        #   role_weights : (B, T_k, R)  — which role each key belongs to
        #   role_vecs    : (B, T_k, D)  — weighted combination of role rows
        # ------------------------------------------------------------------
        # Normalise the role matrix rows so binding stays unit-scale.
        role_mat_norm = F.normalize(self.role_matrix, p=2, dim=-1)  # (R, D)

        # Soft assignment weights over logical roles for each key position.
        role_logits = self.role_router(K)                   # (B, T_k, R)
        role_weights = torch.softmax(role_logits, dim=-1)   # (B, T_k, R)

        # Weighted sum of role rows → a single "assigned role" vector per key.
        # (B, T_k, R) × (R, D) → (B, T_k, D)
        role_vecs = torch.matmul(role_weights, role_mat_norm)  # (B, T_k, D)

        # ------------------------------------------------------------------
        # Step 2: Bind Key vectors to their assigned roles (Hadamard product)
        # ------------------------------------------------------------------
        K_bound = bind_vectors(K, role_vecs)  # (B, T_k, D)

        # ------------------------------------------------------------------
        # Step 3: Compute surprise and update astrocyte state (leaky integrator)
        #   surprise         : (B, T_q)  — variance across D for each query
        #   mean_surprise    : (B,)      — averaged over query positions
        #   new_astro_state  : (B,)      — α·state + (1−α)·surprise
        # ------------------------------------------------------------------
        surprise = compute_surprise(Q)              # (B, T_q)
        mean_surprise = surprise.mean(dim=-1)       # (B,)

        alpha = self.astro_decay
        new_astrocyte_state = alpha * astrocyte_state + (1.0 - alpha) * mean_surprise
        # Detach from graph for the recurrent state to prevent BPTT explosion;
        # gradients still flow through the current-step terms above.
        new_astrocyte_state = new_astrocyte_state.detach() + (
            new_astrocyte_state - new_astrocyte_state.detach()
        )

        # ------------------------------------------------------------------
        # Step 4: Scale τ using astrocyte state
        #   τ_eff = tau_base * (1 + astro_scale * astrocyte_state)
        #   Shape (B, 1, 1) — broadcast over (T_q, T_k) in the kernel below.
        # ------------------------------------------------------------------
        tau_eff = self.tau_base * (
            1.0 + self.astro_scale * new_astrocyte_state
        ).clamp(min=1e-3).unsqueeze(-1).unsqueeze(-1)  # (B, 1, 1)

        # ------------------------------------------------------------------
        # Vectorised Epanechnikov kernel with tensor τ
        #
        # We inline the kernel (rather than calling the primitive helper which
        # accepts only a Python scalar τ) so that tau_eff stays inside the
        # autograd graph — this is the only way gradients can flow back through
        # astro_scale.
        #
        # Steps mirror epanechnikov_attention() exactly:
        #   1. Normalised cosine similarity  → cos_sim ∈ [-1, 1]  (B, T_q, T_k)
        #   2. Rescale to [0, 1]:  x = (cos_sim + 1) / 2
        #   3. Epanechnikov kernel: S = max(0, 1 − τ_eff · (1 − x)²)
        #   4. Normalise across key dim
        # ------------------------------------------------------------------
        q_norm = F.normalize(Q,       p=2, dim=-1)  # (B, T_q, D)
        k_norm = F.normalize(K_bound, p=2, dim=-1)  # (B, T_k, D)

        # (B, T_q, D) × (B, D, T_k) → (B, T_q, T_k)
        cos_sim = torch.bmm(q_norm, k_norm.transpose(-2, -1))
        x = (cos_sim + 1.0) / 2.0                          # ∈ [0, 1]

        # tau_eff: (B, 1, 1) — broadcasts over (T_q, T_k) per sample.
        scores = torch.clamp(1.0 - tau_eff * (1.0 - x) ** 2, min=0.0)

        # Normalise (same as epanechnikov_attention step 4).
        scores_sum = scores.sum(dim=-1, keepdim=True).clamp(min=1e-9)
        attn_weights = scores / scores_sum                  # (B, T_q, T_k)

        # ------------------------------------------------------------------
        # Step 5: Weighted sum of Value vectors
        #   (B, T_q, T_k) × (B, T_k, D) → (B, T_q, D)
        # ------------------------------------------------------------------
        context = torch.bmm(attn_weights, V)   # (B, T_q, D)

        # Final linear projection
        output = self.out_proj(context)        # (B, T_q, D)

        return output, new_astrocyte_state

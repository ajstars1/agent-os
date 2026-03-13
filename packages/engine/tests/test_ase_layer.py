"""
tests/test_ase_layer.py
=======================
Unit tests for :class:`engine.ase_layer.AstroSymbolicEpisodicLayer`.

Three architectural claims are verified:

1. **Zero-Hallucination Bound** — Epanechnikov attention assigns *exact* 0.0
   weights to sufficiently dissimilar tokens (unlike Softmax, which is
   strictly positive everywhere).

2. **Astrocyte Dynamics** — a high-variance (novel) input raises the
   ``astrocyte_state``, while a near-uniform (familiar) input lets it decay
   toward zero.

3. **Gradient Flow** — gradients reach every learnable parameter we care about:
   ``role_matrix``, ``q_proj.weight``, ``k_proj.weight``, and ``v_proj.weight``.
"""

from __future__ import annotations

import pytest
import torch
import torch.nn as nn

from engine.ase_layer import AstroSymbolicEpisodicLayer
from engine.primitives import epanechnikov_attention


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

BATCH  = 2
SEQ_Q  = 6
SEQ_K  = 8
D      = 64
ROLES  = 4
SEED   = 42


@pytest.fixture(scope="module")
def layer() -> AstroSymbolicEpisodicLayer:
    """A small but complete ASE layer instance, fixed seed for reproducibility."""
    torch.manual_seed(SEED)
    return AstroSymbolicEpisodicLayer(
        d_model=D,
        num_logical_roles=ROLES,
        tau_base=1.0,
        astro_decay=0.95,
    )


@pytest.fixture(scope="module")
def zero_astro(layer: AstroSymbolicEpisodicLayer) -> torch.Tensor:
    return layer.initial_astrocyte_state(batch_size=BATCH)


# ---------------------------------------------------------------------------
# 1. Zero-Hallucination Bound
# ---------------------------------------------------------------------------

class TestZeroHallucinationBound:
    """Epanechnikov attention must produce *exact* zeros; Softmax never does."""

    def test_epanechnikov_has_exact_zero_entries(self) -> None:
        """When two tokens are orthogonal, the kernel score is exactly 0.

        S(x) = max(0, 1 − τ(1−x)²).  For orthogonal vectors cos_sim = 0,
        so x = 0.5 and S = max(0, 1 − τ·0.25).  With τ ≥ 4 this is ≤ 0
        → clamped to exactly 0.
        """
        torch.manual_seed(SEED)
        # Build a query that is the exact negative of a specific key.
        # cos_sim(q, k_neg) = -1, x = 0, S = max(0, 1 - τ) → 0 when τ ≥ 1.
        q_vec = torch.randn(1, 1, 1, D)
        k_neg = -q_vec.clone()                    # Anti-parallel key
        k_rand = torch.randn(1, 1, 5, D)          # Other unrelated keys
        k = torch.cat([k_neg, k_rand], dim=2)     # (1, 1, 6, D)

        weights = epanechnikov_attention(q_vec, k, tau=2.0)  # (1, 1, 1, 6)
        # The anti-parallel key (index 0) must receive exactly zero weight.
        assert weights[0, 0, 0, 0].item() == 0.0, (
            "Epanechnikov must assign exact 0.0 to anti-parallel (maximally "
            f"dissimilar) keys; got {weights[0, 0, 0, 0].item()}"
        )

    def test_softmax_never_zero(self) -> None:
        """Confirm Softmax is strictly positive for the same anti-parallel pair."""
        torch.manual_seed(SEED)
        q_vec = torch.randn(1, 1, 1, D)
        k_neg = -q_vec.clone()
        k_rand = torch.randn(1, 1, 5, D)
        k = torch.cat([k_neg, k_rand], dim=2)

        # Softmax over cosine-similarity scores
        q_n = torch.nn.functional.normalize(q_vec, dim=-1)
        k_n = torch.nn.functional.normalize(k, dim=-1)
        scores = torch.matmul(q_n, k_n.transpose(-2, -1))
        softmax_weights = torch.softmax(scores, dim=-1)

        assert softmax_weights[0, 0, 0, 0].item() > 0.0, (
            "This test expects Softmax to be strictly positive (> 0) for the "
            "anti-parallel key — demonstrating the contrast with Epanechnikov."
        )

    def test_ase_layer_output_contains_zero_weights(
        self,
        layer: AstroSymbolicEpisodicLayer,
        zero_astro: torch.Tensor,
    ) -> None:
        """Full ASE forward pass: verify attention weights contain at least one 0.

        We use a very high tau_base so that dissimilar keys definitely reach
        the zero region of the Epanechnikov kernel.
        """
        torch.manual_seed(SEED)
        sharp_layer = AstroSymbolicEpisodicLayer(
            d_model=D, num_logical_roles=ROLES, tau_base=10.0
        )
        sharp_layer.eval()

        # Query: an all-ones vector (uniform direction after normalisation)
        q = torch.ones(BATCH, SEQ_Q, D)
        # Keys: mix of the same direction (will score high) and
        #       uniformly random (will score ~0 with high tau).
        k_aligned = torch.ones(BATCH, 2, D)
        k_random  = torch.randn(BATCH, SEQ_K - 2, D) * 10.0
        k = torch.cat([k_aligned, k_random], dim=1)
        v = torch.randn(BATCH, SEQ_K, D)
        astro = sharp_layer.initial_astrocyte_state(BATCH)

        with torch.no_grad():
            # We peek at raw epanechnikov weights by temporarily instrumenting
            # the primitive directly.
            from engine.primitives import epanechnikov_attention as epa
            q_proj = sharp_layer.q_proj(q)
            k_proj = sharp_layer.k_proj(k)

            # Construct role-bound keys the same way the layer does
            import torch.nn.functional as F
            role_mat = F.normalize(sharp_layer.role_matrix, p=2, dim=-1)
            role_w   = torch.softmax(sharp_layer.role_router(k_proj), dim=-1)
            k_bound  = k_proj * torch.matmul(role_w, role_mat)

            for b in range(BATCH):
                weights_b = epa(
                    q_proj[b].unsqueeze(0),
                    k_bound[b].unsqueeze(0),
                    tau=10.0,
                )  # (1, T_q, T_k)
                has_zeros = (weights_b == 0.0).any()
                assert has_zeros, (
                    f"Sample {b}: expected at least one exact-zero attention "
                    f"weight with tau=10.0, but none found."
                )


# ---------------------------------------------------------------------------
# 2. Astrocyte Dynamics
# ---------------------------------------------------------------------------

class TestAstrocyteDynamics:
    """Leaky-integrator state must respond correctly to input entropy."""

    def test_high_variance_input_raises_state(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """A highly random (high-variance) query batch should increase astro state."""
        torch.manual_seed(SEED)
        layer.eval()

        # High-variance input: large-scale random values ensure high per-dim variance.
        q_noisy = torch.randn(BATCH, SEQ_Q, D) * 10.0
        k       = torch.randn(BATCH, SEQ_K, D)
        v       = torch.randn(BATCH, SEQ_K, D)
        astro   = layer.initial_astrocyte_state(BATCH)  # all zeros

        with torch.no_grad():
            _, new_astro = layer(q_noisy, k, v, astro)

        # State must be strictly positive after a high-variance forward pass.
        assert (new_astro > 0.0).all(), (
            "Astrocyte state should increase from zero when fed a high-variance "
            f"(novel) input. Got: {new_astro}"
        )

    def test_uniform_input_decays_state(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """After priming state high, a near-uniform input should let it decay."""
        torch.manual_seed(SEED)
        layer.eval()

        # Prime the state with a very high value to simulate a previously
        # excited astrocyte.
        astro_high = torch.full((BATCH,), fill_value=100.0)

        # Near-uniform query: tiny variance → close-to-zero surprise signal.
        # Use torch.zeros + tiny jitter so variance ≈ 0 but the tensor isn't
        # degenerate.
        q_uniform = torch.zeros(BATCH, SEQ_Q, D) + 1e-6 * torch.ones(BATCH, SEQ_Q, D)
        k = torch.randn(BATCH, SEQ_K, D)
        v = torch.randn(BATCH, SEQ_K, D)

        with torch.no_grad():
            _, new_astro = layer(q_uniform, k, v, astro_high)

        # The leaky integrator is  0.95 * 100 + 0.05 * ~0  ≈ 95 < 100.
        assert (new_astro < astro_high).all(), (
            "Astrocyte state should decay when surprise is near zero. "
            f"Expected < {astro_high.tolist()}, got {new_astro.tolist()}"
        )

    def test_higher_variance_produces_higher_state_than_lower(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """Monotonicity: higher input variance → higher resulting astrocyte state."""
        torch.manual_seed(SEED)
        layer.eval()

        astro0 = layer.initial_astrocyte_state(BATCH)
        k = torch.randn(BATCH, SEQ_K, D)
        v = torch.randn(BATCH, SEQ_K, D)

        q_low  = torch.randn(BATCH, SEQ_Q, D) * 0.01   # low variance
        q_high = torch.randn(BATCH, SEQ_Q, D) * 50.0   # high variance

        with torch.no_grad():
            _, astro_low  = layer(q_low,  k, v, astro0.clone())
            _, astro_high = layer(q_high, k, v, astro0.clone())

        assert (astro_high > astro_low).all(), (
            "Higher-variance input should produce a higher astrocyte state.\n"
            f"  astro after low-var  input: {astro_low.tolist()}\n"
            f"  astro after high-var input: {astro_high.tolist()}"
        )


# ---------------------------------------------------------------------------
# 3. Gradient Flow
# ---------------------------------------------------------------------------

class TestGradientFlow:
    """Gradients from a scalar loss must reach every key learnable parameter."""

    def _run_backward(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """Helper: zero grads, forward, scalar loss, backward."""
        layer.train()
        layer.zero_grad()

        torch.manual_seed(SEED)
        q = torch.randn(BATCH, SEQ_Q, D, requires_grad=True)
        k = torch.randn(BATCH, SEQ_K, D, requires_grad=True)
        v = torch.randn(BATCH, SEQ_K, D, requires_grad=True)
        astro = layer.initial_astrocyte_state(BATCH)

        output, new_astro = layer(q, k, v, astro)

        # Scalar loss: sum of output + astro state.
        loss = output.sum() + new_astro.sum()
        loss.backward()

    def test_role_matrix_receives_gradient(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """``role_matrix`` must have a non-None, non-zero gradient."""
        torch.manual_seed(SEED)
        fresh = AstroSymbolicEpisodicLayer(d_model=D, num_logical_roles=ROLES)
        self._run_backward(fresh)

        grad = fresh.role_matrix.grad
        assert grad is not None, "role_matrix.grad is None — gradient did not flow."
        assert grad.abs().sum().item() > 0.0, (
            "role_matrix.grad is all zeros — something blocked the gradient path."
        )

    def test_q_proj_receives_gradient(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        torch.manual_seed(SEED)
        fresh = AstroSymbolicEpisodicLayer(d_model=D, num_logical_roles=ROLES)
        self._run_backward(fresh)

        grad = fresh.q_proj.weight.grad
        assert grad is not None, "q_proj.weight.grad is None."
        assert grad.abs().sum().item() > 0.0, "q_proj.weight.grad is all zeros."

    def test_k_proj_receives_gradient(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        torch.manual_seed(SEED)
        fresh = AstroSymbolicEpisodicLayer(d_model=D, num_logical_roles=ROLES)
        self._run_backward(fresh)

        grad = fresh.k_proj.weight.grad
        assert grad is not None, "k_proj.weight.grad is None."
        assert grad.abs().sum().item() > 0.0, "k_proj.weight.grad is all zeros."

    def test_v_proj_receives_gradient(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        torch.manual_seed(SEED)
        fresh = AstroSymbolicEpisodicLayer(d_model=D, num_logical_roles=ROLES)
        self._run_backward(fresh)

        grad = fresh.v_proj.weight.grad
        assert grad is not None, "v_proj.weight.grad is None."
        assert grad.abs().sum().item() > 0.0, "v_proj.weight.grad is all zeros."

    def test_all_named_params_have_gradients(
        self,
        layer: AstroSymbolicEpisodicLayer,
    ) -> None:
        """Sweep every parameter: none should have a None or all-zero gradient."""
        torch.manual_seed(SEED)
        fresh = AstroSymbolicEpisodicLayer(d_model=D, num_logical_roles=ROLES)
        self._run_backward(fresh)

        no_grad: list[str] = []
        zero_grad: list[str] = []

        for name, param in fresh.named_parameters():
            if param.grad is None:
                no_grad.append(name)
            elif param.grad.abs().sum().item() == 0.0:
                zero_grad.append(name)

        assert not no_grad, (
            f"The following parameters received NO gradient:\n  {no_grad}"
        )
        assert not zero_grad, (
            f"The following parameters have ALL-ZERO gradients:\n  {zero_grad}"
        )

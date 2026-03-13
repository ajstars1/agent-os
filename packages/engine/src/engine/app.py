"""FastAPI application – AgentOS Neural Engine."""

from __future__ import annotations

from typing import Any

import torch
import torch.nn as nn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine import __version__
from engine.ase_layer import AstroSymbolicEpisodicLayer
from engine.consolidation import MemoryConsolidator
from engine.model import NeuralEngine

app = FastAPI(
    title="AgentOS Neural Engine",
    description="Custom PyTorch-based neural engine for AgentOS inference.",
    version=__version__,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Singleton model instances
# ---------------------------------------------------------------------------

# Original inference engine (unchanged)
_engine = NeuralEngine()

# Memory processing components
# - vocab_size=256 covers the full ASCII / Latin-1 byte range
# - d_model=64 keeps the prototype lightweight
_D_MODEL = 64
_EMBEDDING = nn.Embedding(num_embeddings=256, embedding_dim=_D_MODEL)
_ASE_LAYER = AstroSymbolicEpisodicLayer(d_model=_D_MODEL, num_logical_roles=8)

# In-process session store: maps session_id → astrocyte_state Tensor (shape: (1,))
# Values are detached CPU tensors so they can be cheaply serialised to lists.
_SESSION_STATES: dict[str, torch.Tensor] = {}

# Singleton MemoryConsolidator (shares the same embedding weights)
_CONSOLIDATOR = MemoryConsolidator(embedding=_EMBEDDING, prune_threshold=0.9)


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class InferenceRequest(BaseModel):
    inputs: list[list[float]]
    """2-D list of floats (batch × features)."""

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "inputs": [[0.0 for _ in range(128)]]
                }
            ]
        }
    }


class InferenceResponse(BaseModel):
    outputs: list[list[float]]
    device: str
    model_version: str = __version__


class MemoryRequest(BaseModel):
    """Payload for the /process_memory endpoint."""

    text: str
    """Raw text to embed and process (max 2 048 characters enforced server-side)."""

    session_id: str
    """Opaque session identifier used to look up / store astrocyte state."""

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"text": "What is the capital of France?", "session_id": "session-abc123"}
            ]
        }
    }


class MemoryResponse(BaseModel):
    """Response from the /process_memory endpoint."""

    session_id: str
    output_shape: list[int]
    """Shape of the ASE layer output tensor, e.g. [1, 12, 64]."""

    astrocyte_state: list[float]
    """Updated per-sample astrocyte state after processing this request."""


class SleepRequest(BaseModel):
    """Payload for the /trigger_sleep endpoint."""

    logs: list[str]
    """Ordered list of raw episodic log strings from the current day/session."""

    prune_threshold: float = 0.9
    """Epanechnikov similarity threshold above which a log is considered
    redundant and flagged for deletion.  Must be in [0, 1]."""

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "logs": [
                        "User asked about the weather in Paris.",
                        "User asked about the temperature in Paris.",
                        "User requested a poem about autumn.",
                    ],
                    "prune_threshold": 0.9,
                }
            ]
        }
    }


class SleepResponse(BaseModel):
    """Response from the /trigger_sleep endpoint."""

    indices_to_delete: list[int]
    """Indices (into the original *logs* list) of near-duplicate entries that
    should be pruned from the episodic store."""

    consolidated_context: str
    """Newline-joined surviving log entries, forming the distilled memory
    context ready for long-term storage or prompt injection."""

    logs_total: int
    """Total number of logs received."""

    logs_pruned: int
    """Number of logs flagged for deletion."""

    logs_retained: int
    """Number of logs that survived the pruning pass."""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/", tags=["meta"])
async def root() -> dict[str, str]:
    return {"service": "AgentOS Neural Engine", "version": __version__}


@app.get("/health", tags=["meta"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/device", tags=["meta"])
async def device_info() -> dict[str, Any]:
    return {
        "device": _engine.device,
        "cuda_available": torch.cuda.is_available(),
        "torch_version": torch.__version__,
    }


@app.post("/infer", response_model=InferenceResponse, tags=["inference"])
async def infer(request: InferenceRequest) -> InferenceResponse:
    if not request.inputs:
        raise HTTPException(status_code=422, detail="inputs must be a non-empty list")

    try:
        tensor_in = torch.tensor(request.inputs, dtype=torch.float32)
        tensor_out = _engine.forward(tensor_in)
        outputs = tensor_out.tolist()
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return InferenceResponse(outputs=outputs, device=_engine.device)


@app.post("/process_memory", response_model=MemoryResponse, tags=["memory"])
async def process_memory(request: MemoryRequest) -> MemoryResponse:
    """Embed *text*, run it through the AstroSymbolicEpisodicLayer, and
    return the output shape together with the updated astrocyte state.

    The astrocyte state is persisted in-process keyed by *session_id*, so
    repeated calls within the same session accumulate novelty history.
    """
    if not request.text:
        raise HTTPException(status_code=422, detail="`text` must be a non-empty string")

    # Truncate to keep embeddings manageable in this prototype.
    TEXT_LIMIT = 2048
    text = request.text[:TEXT_LIMIT]

    try:
        # ------------------------------------------------------------------
        # Step 1: Character-level embedding
        # Convert each character to its byte value (0-255), then embed.
        # Shape: (1, T, D_MODEL)
        # ------------------------------------------------------------------
        byte_ids = torch.tensor(
            [b % 256 for b in text.encode("utf-8")],
            dtype=torch.long,
        ).unsqueeze(0)  # (1, T)

        with torch.no_grad():
            embedded = _EMBEDDING(byte_ids)  # (1, T, D_MODEL)

        # ------------------------------------------------------------------
        # Step 2: Retrieve or initialise per-session astrocyte state
        # Shape: (1,) — one sample in the batch
        # ------------------------------------------------------------------
        astro_state = _SESSION_STATES.get(
            request.session_id,
            _ASE_LAYER.initial_astrocyte_state(batch_size=1),
        )

        # ------------------------------------------------------------------
        # Step 3: ASE forward pass — self-attention (Q = K = V = embedding)
        # ------------------------------------------------------------------
        _ASE_LAYER.eval()
        with torch.no_grad():
            output, new_astro_state = _ASE_LAYER(
                q_in=embedded,
                k_in=embedded,
                v_in=embedded,
                astrocyte_state=astro_state,
            )

        # ------------------------------------------------------------------
        # Step 4: Persist updated astrocyte state for this session
        # ------------------------------------------------------------------
        _SESSION_STATES[request.session_id] = new_astro_state.detach()

    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return MemoryResponse(
        session_id=request.session_id,
        output_shape=list(output.shape),
        astrocyte_state=new_astro_state.tolist(),
    )


@app.post("/trigger_sleep", response_model=SleepResponse, tags=["memory"])
async def trigger_sleep(request: SleepRequest) -> SleepResponse:
    """Run the sleep-cycle memory consolidation pass.

    Accepts a list of recent episodic conversation/log strings, computes
    pairwise Epanechnikov similarity between every pair of mean-pooled
    embeddings, and flags near-duplicate entries (similarity > threshold)
    for deletion.  The surviving logs are joined into a ``consolidated_context``
    string.

    This is analogous to hippocampal replay during slow-wave sleep:
    the brain identifies redundant traces and consolidates / discards them,
    leaving a compact yet faithful episodic summary.

    **Request body**
    - ``logs``            – list of raw episodic text strings.
    - ``prune_threshold`` – similarity cutoff (default 0.9).

    **Response**
    - ``indices_to_delete``     – indices in *logs* flagged as redundant.
    - ``consolidated_context``  – distilled, deduplicated memory string.
    - ``logs_total`` / ``logs_pruned`` / ``logs_retained`` – accounting stats.
    """
    if not request.logs:
        raise HTTPException(
            status_code=422, detail="`logs` must be a non-empty list"
        )

    if not (0.0 <= request.prune_threshold <= 1.0):
        raise HTTPException(
            status_code=422,
            detail="`prune_threshold` must be in [0, 1]",
        )

    try:
        # Re-configure the consolidator's threshold if the caller overrides it.
        # We swap the threshold on the singleton rather than constructing a new
        # object so the embedding weights stay shared.
        _CONSOLIDATOR.prune_threshold = request.prune_threshold

        result = _CONSOLIDATOR.consolidate(request.logs)

    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    total = len(request.logs)
    pruned = len(result.indices_to_delete)

    return SleepResponse(
        indices_to_delete=result.indices_to_delete,
        consolidated_context=result.consolidated_context,
        logs_total=total,
        logs_pruned=pruned,
        logs_retained=total - pruned,
    )

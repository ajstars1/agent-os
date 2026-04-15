"""FastAPI application – AgentOS Neural Engine."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine import __version__
from engine.ase_layer import AstroSymbolicEpisodicLayer
from engine.bg_learner import BackgroundLearner
from engine.consolidation import MemoryConsolidator
from engine.model import NeuralEngine

# ---------------------------------------------------------------------------
# Background learner — reads companion.db path from env or default
# ---------------------------------------------------------------------------

def _resolve_companion_db() -> str:
    raw = os.environ.get(
        "COMPANION_DB_PATH",
        os.path.join(Path.home(), ".agent-os", "companion.db"),
    )
    return str(Path(raw).expanduser())


_LEARNER: BackgroundLearner | None = None


@asynccontextmanager
async def _lifespan(app: FastAPI):  # type: ignore[type-arg]
    global _LEARNER
    db_path = _resolve_companion_db()
    google_api_key = os.environ.get("GOOGLE_API_KEY")
    _LEARNER = BackgroundLearner(db_path, google_api_key=google_api_key)
    await _LEARNER.start()
    yield
    if _LEARNER:
        await _LEARNER.stop()


app = FastAPI(
    title="AgentOS Neural Engine",
    description="Custom PyTorch-based neural engine for AgentOS inference.",
    version=__version__,
    lifespan=_lifespan,
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
    query: str
    candidates: list[str]
    currentState: float = 0.0
    sessionId: str = "default"

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "query": "What is the capital of France?",
                    "candidates": ["Paris is the capital", "London is the capital"],
                    "currentState": 0.5,
                    "sessionId": "session-abc123"
                }
            ]
        }
    }


class MemoryResponse(BaseModel):
    """Response from the /process_memory endpoint."""
    astrocyteLevel: float
    attentionWeights: list[float]


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
    if not request.query:
        raise HTTPException(status_code=422, detail="`query` must be a non-empty string")

    TEXT_LIMIT = 2048
    query_text = request.query[:TEXT_LIMIT]
    
    from engine.primitives import epanechnikov_attention

    try:
        byte_ids = torch.tensor(
            [b % 256 for b in query_text.encode("utf-8")],
            dtype=torch.long,
        ).unsqueeze(0)

        with torch.no_grad():
            q_emb = _EMBEDDING(byte_ids)
            q_mean = q_emb.mean(dim=1, keepdim=True)

        weights = []
        if request.candidates:
            k_means = []
            for cand in request.candidates:
                cand_text = cand[:TEXT_LIMIT]
                cand_byte_ids = torch.tensor(
                    [b % 256 for b in cand_text.encode("utf-8")],
                    dtype=torch.long,
                ).unsqueeze(0)
                with torch.no_grad():
                    c_emb = _EMBEDDING(cand_byte_ids)
                    k_means.append(c_emb.mean(dim=1))
            
            k_tensor = torch.stack(k_means, dim=1)
            with torch.no_grad():
                att = epanechnikov_attention(q_mean, k_tensor)
                weights = att.squeeze(0).squeeze(0).tolist()
                
            if not isinstance(weights, list):
                weights = [weights] if isinstance(weights, float) else list(weights)

        astro_state = _SESSION_STATES.get(
            request.sessionId,
            _ASE_LAYER.initial_astrocyte_state(batch_size=1),
        )

        _ASE_LAYER.eval()
        with torch.no_grad():
            _, new_astro_state = _ASE_LAYER(
                q_in=q_emb,
                k_in=q_emb,
                v_in=q_emb,
                astrocyte_state=astro_state,
            )

        _SESSION_STATES[request.sessionId] = new_astro_state.detach()

    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "astrocyteLevel": float(new_astro_state.view(-1)[0].item()),
        "attentionWeights": weights,
    }


@app.get("/learner/stats", tags=["learner"])
async def learner_stats() -> dict[str, Any]:
    """Current background learner statistics — memory health, pass timestamps."""
    if _LEARNER is None:
        raise HTTPException(status_code=503, detail="Learner not started")
    return _LEARNER.get_stats()


@app.get("/learner/predictions", tags=["learner"])
async def learner_predictions() -> list[dict[str, Any]]:
    """Today's topic predictions — what the user will likely need."""
    if _LEARNER is None:
        return []
    return _LEARNER.get_predictions()


@app.get("/learner/hot-topics", tags=["learner"])
async def learner_hot_topics(limit: int = 10) -> list[dict[str, Any]]:
    """Current interest map — topics ranked by recency-weighted frequency."""
    if _LEARNER is None:
        return []
    return _LEARNER.get_hot_topics(limit=min(limit, 50))


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

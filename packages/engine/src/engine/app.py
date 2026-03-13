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


"""FastAPI application – AgentOS Neural Engine."""

from __future__ import annotations

from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine import __version__
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

# Singleton model instance
_engine = NeuralEngine()


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class InferenceRequest(BaseModel):
    inputs: list[list[float]]
    """2-D list of floats (batch × features)."""


class InferenceResponse(BaseModel):
    outputs: list[list[float]]
    device: str
    model_version: str = __version__


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
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return InferenceResponse(outputs=outputs, device=_engine.device)

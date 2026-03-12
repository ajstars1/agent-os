"""Unit tests for the NeuralEngine model."""

import torch
import pytest
from engine.model import NeuralEngine


@pytest.fixture()
def engine() -> NeuralEngine:
    return NeuralEngine(input_dim=4, hidden_dim=8, output_dim=2, num_layers=2)


def test_forward_shape(engine: NeuralEngine) -> None:
    batch_size = 5
    x = torch.randn(batch_size, 4)
    out = engine(x)
    assert out.shape == (batch_size, 2), f"Expected (5, 2), got {out.shape}"


def test_output_dtype(engine: NeuralEngine) -> None:
    x = torch.randn(3, 4)
    out = engine(x)
    assert out.dtype == torch.float32


def test_device_property(engine: NeuralEngine) -> None:
    assert engine.device in ("cpu", "cuda")


def test_invalid_num_layers() -> None:
    with pytest.raises(AssertionError):
        NeuralEngine(num_layers=1)

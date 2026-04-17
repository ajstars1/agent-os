"""Core PyTorch model for the AgentOS Neural Engine."""

from __future__ import annotations

import torch
import torch.nn as nn


class NeuralEngine(nn.Module):
    """A configurable multi-layer perceptron used as the base neural engine.

    Replace or extend this class with your domain-specific architecture as the
    project matures.

    Parameters
    ----------
    input_dim:
        Number of input features. Defaults to 128.
    hidden_dim:
        Width of the hidden layers. Defaults to 256.
    output_dim:
        Number of output features. Defaults to 64.
    num_layers:
        Total number of linear layers. Defaults to 3.
    """

    def __init__(
        self,
        input_dim: int = 128,
        hidden_dim: int = 256,
        output_dim: int = 64,
        num_layers: int = 3,
    ) -> None:
        super().__init__()

        assert num_layers >= 2, "num_layers must be at least 2"

        layers: list[nn.Module] = []
        in_features = input_dim
        for i in range(num_layers - 1):
            layers.append(nn.Linear(in_features, hidden_dim))
            layers.append(nn.ReLU())
            if i == 0:
                layers.append(nn.LayerNorm(hidden_dim))
            in_features = hidden_dim

        layers.append(nn.Linear(in_features, output_dim))
        self.network = nn.Sequential(*layers)

        self._device = "cuda" if torch.cuda.is_available() else "cpu"
        self.to(self._device)

    @property
    def device(self) -> str:
        return self._device

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # type: ignore[override]
        """Run a forward pass.

        Parameters
        ----------
        x:
            Input tensor of shape ``(batch_size, input_dim)``.

        Returns
        -------
        torch.Tensor
            Output tensor of shape ``(batch_size, output_dim)``.
        """
        x = x.to(self._device)
        return self.network(x)

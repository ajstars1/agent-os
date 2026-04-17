"""AgentOS Neural Engine package."""

__version__ = "0.1.0"

from engine.primitives import (  # noqa: F401
    bind_vectors,
    compute_surprise,
    epanechnikov_attention,
)
from engine.ase_layer import AstroSymbolicEpisodicLayer  # noqa: F401

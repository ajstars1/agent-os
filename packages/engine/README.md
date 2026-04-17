# @agent-os/engine

> Custom PyTorch-based neural engine for the AgentOS monorepo.

## Stack

| Library | Role |
|---|---|
| [PyTorch](https://pytorch.org/) | Deep-learning framework |
| [NumPy](https://numpy.org/) | Numerical utilities |
| [FastAPI](https://fastapi.tiangolo.com/) | REST API layer |
| [Uvicorn](https://www.uvicorn.org/) | ASGI server |

## Prerequisites

- Python ≥ 3.10
- [Poetry](https://python-poetry.org/docs/#installation) ≥ 1.8

## Setup

```bash
cd packages/engine
poetry install
```

## Development server

```bash
# via Poetry script
poetry run engine

# or directly
poetry run python main.py
```

Interactive API docs available at <http://localhost:8765/docs>.

## Testing

```bash
poetry run pytest
```

## Project layout

```
packages/engine/
├── main.py               # Uvicorn entry point
├── pyproject.toml        # Poetry manifest
├── src/
│   └── engine/
│       ├── __init__.py   # Package version
│       ├── app.py        # FastAPI application
│       └── model.py      # PyTorch NeuralEngine
└── tests/
    ├── test_api.py       # API integration tests
    └── test_model.py     # Model unit tests
```

## Extending the model

Replace or subclass `NeuralEngine` in `src/engine/model.py` with your
domain-specific PyTorch architecture.  The `app.py` module imports the
singleton at startup, so changes take effect immediately on server restart.

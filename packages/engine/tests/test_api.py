"""Integration tests for the FastAPI engine application."""

import pytest
from fastapi.testclient import TestClient

from engine.app import app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def test_root(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    data = resp.json()
    assert data["service"] == "AgentOS Neural Engine"


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_device_endpoint(client: TestClient) -> None:
    resp = client.get("/device")
    assert resp.status_code == 200
    data = resp.json()
    assert "device" in data
    assert "torch_version" in data


def test_infer(client: TestClient) -> None:
    payload = {"inputs": [[float(i) for i in range(128)]]}
    resp = client.post("/infer", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert "outputs" in data
    assert len(data["outputs"]) == 1


def test_infer_empty_inputs(client: TestClient) -> None:
    resp = client.post("/infer", json={"inputs": []})
    assert resp.status_code == 422

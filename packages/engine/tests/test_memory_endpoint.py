"""
tests/test_memory_endpoint.py
=============================
Integration tests for the /process_memory FastAPI endpoint.

Three scenarios are covered:

1. **Happy path** — valid payload returns 200 with correct JSON shape.
2. **Statefulness** — two calls with the same session_id return different
   astrocyte_states (proving the leaky integrator accumulates novelty).
3. **Validation** — missing required fields return 422.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from engine.app import app


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------

class TestProcessMemoryHappyPath:

    def test_returns_200(self, client: TestClient) -> None:
        resp = client.post(
            "/process_memory",
            json={"text": "Hello, world!", "session_id": "test-session-1"},
        )
        assert resp.status_code == 200, resp.text

    def test_response_has_required_fields(self, client: TestClient) -> None:
        resp = client.post(
            "/process_memory",
            json={"text": "The quick brown fox jumps over the lazy dog.",
                  "session_id": "test-session-2"},
        )
        data = resp.json()
        assert "session_id" in data
        assert "output_shape" in data
        assert "astrocyte_state" in data

    def test_session_id_is_echoed(self, client: TestClient) -> None:
        sid = "echo-session-xyz"
        resp = client.post(
            "/process_memory",
            json={"text": "Test echo.", "session_id": sid},
        )
        assert resp.json()["session_id"] == sid

    def test_output_shape_is_3d(self, client: TestClient) -> None:
        """Output must be (batch=1, seq_len, d_model=64)."""
        resp = client.post(
            "/process_memory",
            json={"text": "shape test", "session_id": "shape-session"},
        )
        shape = resp.json()["output_shape"]
        assert len(shape) == 3, f"Expected 3D shape, got {shape}"
        assert shape[0] == 1, f"batch dim must be 1, got {shape[0]}"
        assert shape[2] == 64, f"d_model must be 64, got {shape[2]}"
        # seq_len should equal number of UTF-8 bytes in "shape test" (10)
        assert shape[1] == len("shape test".encode("utf-8")), (
            f"seq_len mismatch: {shape[1]}"
        )

    def test_astrocyte_state_is_length_1_list(self, client: TestClient) -> None:
        """Batch size is 1, so astrocyte_state must be a list with one float."""
        resp = client.post(
            "/process_memory",
            json={"text": "state shape test", "session_id": "state-shape-session"},
        )
        state = resp.json()["astrocyte_state"]
        assert isinstance(state, list), "astrocyte_state must be a list"
        assert len(state) == 1, f"Expected 1 element (batch=1), got {len(state)}"
        assert isinstance(state[0], float), "state element must be float"

    def test_unicode_text_accepted(self, client: TestClient) -> None:
        """Non-ASCII text must not crash the endpoint."""
        resp = client.post(
            "/process_memory",
            json={"text": "こんにちは世界 🌍", "session_id": "unicode-session"},
        )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# 2. Statefulness — same session → astrocyte_state changes over calls
# ---------------------------------------------------------------------------

class TestProcessMemoryStatefulness:

    def test_astrocyte_state_changes_across_calls(self, client: TestClient) -> None:
        """Two calls with the same session_id must produce different states."""
        sid = "stateful-session-abc"
        first = client.post(
            "/process_memory",
            json={"text": "First call with random content.", "session_id": sid},
        ).json()["astrocyte_state"]

        second = client.post(
            "/process_memory",
            json={"text": "Second call with different random content!", "session_id": sid},
        ).json()["astrocyte_state"]

        assert first != second, (
            "astrocyte_state should differ between calls for the same session "
            f"(first={first}, second={second})"
        )

    def test_different_sessions_are_independent(self, client: TestClient) -> None:
        """Two sessions with identical text start from the same zero state, so
        their first-call states must be equal."""
        text = "Identical text for both sessions."
        state_a = client.post(
            "/process_memory",
            json={"text": text, "session_id": "independent-session-A"},
        ).json()["astrocyte_state"]

        state_b = client.post(
            "/process_memory",
            json={"text": text, "session_id": "independent-session-B"},
        ).json()["astrocyte_state"]

        assert state_a == state_b, (
            "Two brand-new sessions given identical text should produce the same "
            f"first astrocyte_state.\n  A={state_a}\n  B={state_b}"
        )


# ---------------------------------------------------------------------------
# 3. Validation
# ---------------------------------------------------------------------------

class TestProcessMemoryValidation:

    def test_missing_text_returns_422(self, client: TestClient) -> None:
        resp = client.post(
            "/process_memory",
            json={"session_id": "no-text-session"},
        )
        assert resp.status_code == 422, resp.text

    def test_missing_session_id_returns_422(self, client: TestClient) -> None:
        resp = client.post(
            "/process_memory",
            json={"text": "No session id here."},
        )
        assert resp.status_code == 422, resp.text

    def test_empty_payload_returns_422(self, client: TestClient) -> None:
        resp = client.post("/process_memory", json={})
        assert resp.status_code == 422, resp.text

    def test_text_is_truncated_to_2048_chars(self, client: TestClient) -> None:
        """Texts longer than 2048 chars should succeed (truncated silently)."""
        long_text = "A" * 4096
        resp = client.post(
            "/process_memory",
            json={"text": long_text, "session_id": "truncation-session"},
        )
        assert resp.status_code == 200, resp.text
        # seq_len in output_shape must be ≤ 2048 bytes
        shape = resp.json()["output_shape"]
        assert shape[1] <= 2048, f"Truncation failed: seq_len={shape[1]}"

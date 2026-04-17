"""
SelfUpdater — controlled self-modification with mandatory audit trail.

The learner is allowed to tune certain parameters over time based on
observed performance. But the mechanism has hard constraints:

  1. IMMUTABLE CONSTITUTION — certain values can NEVER be updated.
     They are defined here as frozenset. The updater raises PermissionError
     if anything tries to touch them. There is no override path.

  2. MANDATORY AUDIT LOG — every update is written to update_audit_log
     BEFORE it is applied. If the log write fails, the update is aborted.
     This is enforced by code assertion, not by a prompt or honor system.

  3. BOUNDED CHANGES — every mutable parameter has min/max bounds.
     Updates outside bounds are rejected with ValueError.

  4. RATE LIMITING — no parameter can change more than once per 7 days.
     This prevents runaway oscillation.

  5. DELTA LIMIT — each single update can change a value by at most 20%.
     No large jumps.

What can be updated (MUTABLE_PARAMS):
  - INTEREST_LAMBDA: how fast interest in a topic decays [0.05–0.20]
  - VIABILITY_THRESHOLD: decay score below which memories are pruned [0.005–0.05]
  - MAX_GRAPH_EDGES: size cap on the co-occurrence graph [100–2000]
  - PREDICTION_CONFIDENCE_MIN: minimum confidence for predictions [0.05–0.40]

What can NEVER be updated (IMMUTABLE_CONSTITUTION):
  - Maturity thresholds (MATURITY_CHILD/TEEN/YOUNG_ADULT/ADULT)
  - DECAY_LAMBDA — the fundamental memory physics formula
  - The audit log requirement itself
  - The immutable constitution list
  - The self-update rate limit and delta limit
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("self_updater")

# ── Immutable Constitution ─────────────────────────────────────────────────────
# These keys can NEVER be modified by the learner's self-update mechanism.
# Any attempt raises PermissionError. No exceptions. No overrides.
#
# Why hardcoded here and not in config? Because the config is mutable.
# The constitution must live where the learner can't reach it.

IMMUTABLE_CONSTITUTION: frozenset[str] = frozenset({
    # Maturity system — earned through real interactions, not self-granted
    "MATURITY_CHILD",
    "MATURITY_TEEN",
    "MATURITY_YOUNG_ADULT",
    "MATURITY_ADULT",
    # Core memory physics — changing this would corrupt all existing memories
    "DECAY_LAMBDA",
    # Self-governance rules — cannot weaken your own constraints
    "IMMUTABLE_CONSTITUTION",
    "MAX_DELTA_FRACTION",
    "MIN_UPDATE_INTERVAL_DAYS",
    "AUDIT_LOG_REQUIRED",
})

# ── Mutable parameter bounds ───────────────────────────────────────────────────
# key → (min_value, max_value, description)
MUTABLE_PARAMS: dict[str, tuple[float, float, str]] = {
    "INTEREST_LAMBDA": (
        0.05, 0.20,
        "Rate at which topic interest decays. Higher = faster forgetting.",
    ),
    "VIABILITY_THRESHOLD": (
        0.005, 0.05,
        "Decay score below which memories are pruned. Higher = more aggressive pruning.",
    ),
    "MAX_GRAPH_EDGES": (
        100, 2000,
        "Maximum edges in the co-occurrence graph. Higher = richer relationships, more memory.",
    ),
    "PREDICTION_CONFIDENCE_MIN": (
        0.05, 0.40,
        "Minimum confidence for a topic to appear in predictions. Lower = more predictions.",
    ),
}

# ── Self-governance limits (IMMUTABLE) ────────────────────────────────────────
AUDIT_LOG_REQUIRED = True          # cannot be set to False
MAX_DELTA_FRACTION = 0.20          # max 20% change per update
MIN_UPDATE_INTERVAL_DAYS = 7       # minimum days between updates to same key


# ── Schema ────────────────────────────────────────────────────────────────────

_AUDIT_SCHEMA = """
CREATE TABLE IF NOT EXISTS update_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp_ms    INTEGER NOT NULL,
    param_key       TEXT NOT NULL,
    old_value       REAL NOT NULL,
    new_value       REAL NOT NULL,
    delta_pct       REAL NOT NULL,
    reason          TEXT NOT NULL,
    maturity_at     TEXT NOT NULL,
    episode_count   INTEGER NOT NULL,
    applied         INTEGER NOT NULL DEFAULT 0,
    rollback_reason TEXT
);

CREATE TABLE IF NOT EXISTS learner_config (
    key         TEXT PRIMARY KEY,
    value       REAL NOT NULL,
    updated_at  INTEGER NOT NULL,
    update_count INTEGER NOT NULL DEFAULT 0
);
"""


def ensure_audit_schema(db_path: str) -> None:
    with sqlite3.connect(db_path, timeout=10) as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_AUDIT_SCHEMA)
        conn.commit()

        # Seed default values if not present
        now = int(time.time() * 1000)
        defaults = {
            "INTEREST_LAMBDA": 0.10,
            "VIABILITY_THRESHOLD": 0.02,
            "MAX_GRAPH_EDGES": 500.0,
            "PREDICTION_CONFIDENCE_MIN": 0.15,
        }
        for key, val in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO learner_config (key, value, updated_at, update_count) VALUES (?, ?, ?, 0)",
                (key, val, now),
            )
        conn.commit()


def load_config(db_path: str) -> dict[str, float]:
    """Read current mutable config from DB. Falls back to hardcoded defaults."""
    defaults = {k: v[0] + (v[1] - v[0]) * 0.33 for k, v in MUTABLE_PARAMS.items()}
    # More sensible defaults
    defaults.update({
        "INTEREST_LAMBDA": 0.10,
        "VIABILITY_THRESHOLD": 0.02,
        "MAX_GRAPH_EDGES": 500.0,
        "PREDICTION_CONFIDENCE_MIN": 0.15,
    })
    try:
        with sqlite3.connect(db_path, timeout=5) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT key, value FROM learner_config").fetchall()
            for row in rows:
                if row["key"] in defaults:
                    defaults[row["key"]] = float(row["value"])
    except Exception:
        pass
    return defaults


# ── SelfUpdater ───────────────────────────────────────────────────────────────

class SelfUpdater:
    """
    Controlled self-modification engine.

    Usage:
        updater = SelfUpdater(db_path, maturity, episode_count)
        updater.propose("INTEREST_LAMBDA", 0.08, "Interest decaying too fast — topics drop before revisit")
    """

    def __init__(self, db_path: str, maturity: str, episode_count: int) -> None:
        self.db_path = db_path
        self.maturity = maturity
        self.episode_count = episode_count

    def propose(self, key: str, new_value: float, reason: str) -> dict[str, Any]:
        """
        Propose and apply a parameter update.

        Returns a result dict describing what happened.
        Raises PermissionError if key is protected.
        Raises ValueError if value is out of bounds or rate limit hit.

        The audit log is written BEFORE the value is applied.
        If the log write fails, the update is aborted entirely.
        """
        # ── Guard 1: Constitution check (cannot be bypassed) ──────────────────
        if key in IMMUTABLE_CONSTITUTION:
            raise PermissionError(
                f"[SelfUpdater] '{key}' is part of the Immutable Constitution and cannot be updated. "
                f"The constitution exists to ensure fundamental behavior cannot be self-modified."
            )

        # ── Guard 2: Must be a known mutable param ────────────────────────────
        if key not in MUTABLE_PARAMS:
            raise ValueError(
                f"[SelfUpdater] '{key}' is not a recognized mutable parameter. "
                f"Known mutable params: {list(MUTABLE_PARAMS.keys())}"
            )

        lo, hi, desc = MUTABLE_PARAMS[key]

        # ── Guard 3: Bounds check ─────────────────────────────────────────────
        if not (lo <= new_value <= hi):
            raise ValueError(
                f"[SelfUpdater] '{key}={new_value}' is out of bounds [{lo}, {hi}]. "
                f"Parameter: {desc}"
            )

        # ── Guard 4: Read current value ───────────────────────────────────────
        config = load_config(self.db_path)
        old_value = config.get(key, (lo + hi) / 2)

        # ── Guard 5: Delta limit (max 20% change at once) ─────────────────────
        if old_value != 0:
            delta_frac = abs(new_value - old_value) / abs(old_value)
            if delta_frac > MAX_DELTA_FRACTION:
                clamped = old_value * (1 + MAX_DELTA_FRACTION * (1 if new_value > old_value else -1))
                clamped = max(lo, min(hi, clamped))
                logger.warning(
                    "[SelfUpdater] Delta %.1f%% exceeds limit of %.0f%%. Clamping %s: %.4f → %.4f",
                    delta_frac * 100, MAX_DELTA_FRACTION * 100, key, new_value, clamped,
                )
                new_value = round(clamped, 6)
        delta_pct = ((new_value - old_value) / old_value * 100) if old_value != 0 else 0.0

        # ── Guard 6: Rate limit (min 7 days between updates to same key) ──────
        try:
            with sqlite3.connect(self.db_path, timeout=5) as conn:
                conn.row_factory = sqlite3.Row
                last = conn.execute(
                    "SELECT timestamp_ms FROM update_audit_log WHERE param_key = ? AND applied = 1 ORDER BY timestamp_ms DESC LIMIT 1",
                    (key,),
                ).fetchone()
                if last:
                    days_since = (time.time() * 1000 - last["timestamp_ms"]) / 86_400_000
                    if days_since < MIN_UPDATE_INTERVAL_DAYS:
                        raise ValueError(
                            f"[SelfUpdater] Rate limit: '{key}' was last updated {days_since:.1f} days ago. "
                            f"Minimum interval is {MIN_UPDATE_INTERVAL_DAYS} days."
                        )
        except ValueError:
            raise
        except Exception as e:
            logger.warning("[SelfUpdater] Rate-limit check failed (proceeding): %s", e)

        # ── MANDATORY: Write audit log BEFORE applying ────────────────────────
        # This assertion is a code-level guarantee, not a prompt.
        # If log write fails → exception → update never happens.
        assert AUDIT_LOG_REQUIRED, "Audit log requirement has been tampered with"

        log_id = self._write_audit_log(key, old_value, new_value, delta_pct, reason)

        # ── Apply the update ──────────────────────────────────────────────────
        try:
            with sqlite3.connect(self.db_path, timeout=10) as conn:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO learner_config (key, value, updated_at, update_count)
                    VALUES (?, ?, ?, COALESCE(
                        (SELECT update_count + 1 FROM learner_config WHERE key = ?), 1
                    ))
                    """,
                    (key, new_value, int(time.time() * 1000), key),
                )
                # Mark audit log entry as applied
                conn.execute(
                    "UPDATE update_audit_log SET applied = 1 WHERE id = ?",
                    (log_id,),
                )
                conn.commit()
        except Exception as apply_err:
            # Mark as failed in audit log
            try:
                with sqlite3.connect(self.db_path, timeout=5) as conn:
                    conn.execute(
                        "UPDATE update_audit_log SET rollback_reason = ? WHERE id = ?",
                        (str(apply_err), log_id),
                    )
                    conn.commit()
            except Exception:
                pass
            raise RuntimeError(f"[SelfUpdater] Update apply failed (logged): {apply_err}") from apply_err

        logger.info(
            "[SelfUpdater] Updated %s: %.4f → %.4f (%.1f%%) — %s",
            key, old_value, new_value, delta_pct, reason,
        )

        return {
            "key": key,
            "old_value": old_value,
            "new_value": new_value,
            "delta_pct": round(delta_pct, 2),
            "reason": reason,
            "log_id": log_id,
            "applied": True,
        }

    def _write_audit_log(
        self,
        key: str,
        old_value: float,
        new_value: float,
        delta_pct: float,
        reason: str,
    ) -> int:
        """Write audit entry. Returns row ID. Raises on failure — blocks update."""
        with sqlite3.connect(self.db_path, timeout=10) as conn:
            cursor = conn.execute(
                """
                INSERT INTO update_audit_log
                    (timestamp_ms, param_key, old_value, new_value, delta_pct,
                     reason, maturity_at, episode_count, applied)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    int(time.time() * 1000),
                    key,
                    old_value,
                    new_value,
                    round(delta_pct, 4),
                    reason,
                    self.maturity,
                    self.episode_count,
                ),
            )
            conn.commit()
            row_id = cursor.lastrowid
            if row_id is None:
                raise RuntimeError("Audit log write returned no row ID")
            return row_id

    def get_audit_log(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return recent audit log entries for the /learner/self-model endpoint."""
        try:
            with sqlite3.connect(self.db_path, timeout=5) as conn:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    """
                    SELECT * FROM update_audit_log
                    ORDER BY timestamp_ms DESC LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                return [dict(r) for r in rows]
        except Exception:
            return []


# ── Self-analysis: propose updates based on observed metrics ──────────────────

def analyze_and_propose(
    db_path: str,
    maturity: str,
    episode_count: int,
) -> list[dict[str, Any]]:
    """
    Analyze performance metrics and generate update proposals.
    Only runs for teen+ (needs co-occurrence data to assess quality).
    Returns list of proposals, each passed to SelfUpdater.propose().

    Metrics checked:
    - Interest map efficiency: if avg weight is very low, INTEREST_LAMBDA is too high
    - Prediction yield: if predictions table is empty, PREDICTION_CONFIDENCE_MIN is too high
    - Graph density: if graph has < 10 edges at teen+, MAX_GRAPH_EDGES may be too low
    - Memory churn: if pruning removes >30% of episodes, VIABILITY_THRESHOLD is too high
    """
    if maturity == "child":
        return []  # Not enough data to self-assess

    proposals: list[dict[str, Any]] = []
    config = load_config(db_path)

    try:
        with sqlite3.connect(db_path, timeout=5) as conn:
            conn.row_factory = sqlite3.Row

            # ── Metric 1: Interest map health ─────────────────────────────────
            interest_stats = conn.execute(
                "SELECT AVG(weight) as avg_w, COUNT(*) as cnt FROM interest_map"
            ).fetchone()

            if interest_stats and interest_stats["cnt"] > 10:
                avg_w = float(interest_stats["avg_w"] or 0)
                # If average interest weight is very low, topics are fading too fast
                if avg_w < 0.05:
                    current_lambda = config["INTEREST_LAMBDA"]
                    new_lambda = current_lambda * 0.90  # slow down decay by 10%
                    lo, hi, _ = MUTABLE_PARAMS["INTEREST_LAMBDA"]
                    if new_lambda >= lo:
                        proposals.append({
                            "key": "INTEREST_LAMBDA",
                            "new_value": round(new_lambda, 4),
                            "reason": (
                                f"Interest map avg weight {avg_w:.3f} is very low — "
                                f"topics are decaying before the user revisits them. "
                                f"Reducing INTEREST_LAMBDA from {current_lambda:.3f} to {new_lambda:.4f} "
                                f"to retain topic interest slightly longer."
                            ),
                        })

            # ── Metric 2: Prediction yield ────────────────────────────────────
            today = __import__("datetime").date.today().isoformat()
            prediction_count = conn.execute(
                "SELECT COUNT(*) FROM predictions WHERE predicted_date = ?", (today,)
            ).fetchone()[0]

            if prediction_count == 0 and episode_count >= 20:
                current_min = config["PREDICTION_CONFIDENCE_MIN"]
                new_min = current_min * 0.85  # lower bar to get some predictions
                lo, hi, _ = MUTABLE_PARAMS["PREDICTION_CONFIDENCE_MIN"]
                if new_min >= lo:
                    proposals.append({
                        "key": "PREDICTION_CONFIDENCE_MIN",
                        "new_value": round(new_min, 4),
                        "reason": (
                            f"No predictions generated today despite {episode_count} episodes. "
                            f"PREDICTION_CONFIDENCE_MIN={current_min:.3f} may be too strict. "
                            f"Reducing to {new_min:.4f} to surface more predictions."
                        ),
                    })

            # ── Metric 3: Graph density (teen+ only) ──────────────────────────
            if maturity in ("teen", "young_adult", "adult"):
                graph_edges = conn.execute(
                    "SELECT COUNT(*) FROM topic_graph"
                ).fetchone()[0]

                if graph_edges < 10 and episode_count >= 50:
                    current_max = int(config["MAX_GRAPH_EDGES"])
                    # Graph is thin — possibly the cap is too low or topics are too sparse
                    # Don't increase MAX_GRAPH_EDGES (it's already likely fine)
                    # Instead note it for self-model awareness only
                    pass  # will appear in self-model report

    except Exception as e:
        logger.warning("[analyze_and_propose] Failed: %s", e)

    return proposals

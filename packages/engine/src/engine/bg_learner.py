"""
BackgroundLearner — pure-computation memory maintenance daemon.

Runs as background asyncio tasks inside the FastAPI process.
Zero LLM calls. Zero tokens. Pure SQLite + math.

What it does (human-like daily learning):
  - Decay pass (every 30 min): recalculate how vivid each memory still is
  - Interest map (every 1 hr): frequency × recency weighting per topic
  - Co-occurrence graph (every 4 hrs): which topics appear together
  - Daily predictions (once/day): what will the user likely need tomorrow?
  - Memory prune (daily): delete memories that have fully faded

All writes go to companion.db alongside the episodic/profile tables.
TypeScript reads these tables on engine startup to pre-warm context.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sqlite3
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Optional

from engine.self_updater import (
    SelfUpdater,
    analyze_and_propose,
    ensure_audit_schema,
    load_config,
    MUTABLE_PARAMS,
    IMMUTABLE_CONSTITUTION,
)

logger = logging.getLogger("bg_learner")

# ── Constants ─────────────────────────────────────────────────────────────────

DECAY_LAMBDA = 0.07          # episode half-life ≈ 10 days
INTEREST_LAMBDA = 0.10       # interest half-life ≈ 7 days
VIABILITY_THRESHOLD = 0.02   # episodes below this are deleted
MAX_GRAPH_EDGES = 500        # prevent unbounded co-occurrence table growth
PREDICTION_CONFIDENCE_MIN = 0.15

# ── Maturity thresholds ───────────────────────────────────────────────────────
# The learner unlocks capabilities as it accumulates experience.
# Inspired by human cognitive development — earn privileges, don't start with them.
#
# CHILD  (0–99 episodes):
#   Pure local math. No LLM. No internet. Just counting, decay, pattern matching.
#   Learns what topics exist. Builds basic interest map.
#
# TEEN  (100–499 episodes):
#   Unlocks co-occurrence graph building (relationships between topics).
#   Still no external calls. Richer pattern analysis.
#
# YOUNG_ADULT (500–1999 episodes):
#   Unlocks LLM-assisted consolidation (one flash-lite call per day maximum).
#   Uses it to merge near-duplicate memories into richer summaries.
#   Budget: 1 LLM call/day, max 500 tokens in + 200 tokens out.
#
# ADULT (2000+ episodes):
#   Unlocks web research for predictions (one targeted search per week).
#   "I see you always ask about Next.js releases — let me pre-fetch the changelog."
#   Budget: 1 web search/week via Gemini flash-lite.

MATURITY_CHILD       = 0
MATURITY_TEEN        = 100
MATURITY_YOUNG_ADULT = 500
MATURITY_ADULT       = 2000


def _next_unlock(episode_count: int) -> dict[str, object]:
    """Return what the next maturity unlock is and how many episodes away."""
    if episode_count < MATURITY_TEEN:
        return {
            "level": "teen",
            "at": MATURITY_TEEN,
            "remaining": MATURITY_TEEN - episode_count,
            "unlocks": "topic co-occurrence graph",
        }
    if episode_count < MATURITY_YOUNG_ADULT:
        return {
            "level": "young_adult",
            "at": MATURITY_YOUNG_ADULT,
            "remaining": MATURITY_YOUNG_ADULT - episode_count,
            "unlocks": "LLM memory consolidation (1 call/day)",
        }
    if episode_count < MATURITY_ADULT:
        return {
            "level": "adult",
            "at": MATURITY_ADULT,
            "remaining": MATURITY_ADULT - episode_count,
            "unlocks": "web research for predictions (1 search/week)",
        }
    return {"level": "adult", "at": MATURITY_ADULT, "remaining": 0, "unlocks": "fully unlocked"}


def _get_maturity_level(episode_count: int) -> str:
    """Return the current maturity stage name based on accumulated episodes."""
    if episode_count >= MATURITY_ADULT:
        return "adult"
    if episode_count >= MATURITY_YOUNG_ADULT:
        return "young_adult"
    if episode_count >= MATURITY_TEEN:
        return "teen"
    return "child"


# ── Schema migration ──────────────────────────────────────────────────────────

_LEARNER_SCHEMA = """
CREATE TABLE IF NOT EXISTS self_model (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_ms     INTEGER NOT NULL,
    maturity        TEXT NOT NULL,
    episode_count   INTEGER NOT NULL,
    report          TEXT NOT NULL,
    config_snapshot TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interest_map (
    topic           TEXT PRIMARY KEY,
    weight          REAL DEFAULT 0.0,
    mention_count   INTEGER DEFAULT 0,
    last_mentioned  INTEGER,
    updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS topic_graph (
    topic_a     TEXT NOT NULL,
    topic_b     TEXT NOT NULL,
    strength    REAL DEFAULT 1.0,
    last_seen   INTEGER,
    PRIMARY KEY (topic_a, topic_b)
);

CREATE TABLE IF NOT EXISTS predictions (
    topic           TEXT PRIMARY KEY,
    confidence      REAL NOT NULL,
    source          TEXT NOT NULL,
    predicted_date  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learner_stats (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);
"""


# ── Database helpers ──────────────────────────────────────────────────────────

def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema(db_path: str) -> None:
    with _connect(db_path) as conn:
        conn.executescript(_LEARNER_SCHEMA)
        conn.commit()


def _set_stat(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO learner_stats (key, value, updated_at) VALUES (?, ?, ?)",
        (key, value, int(time.time() * 1000)),
    )


# ── Pass implementations ──────────────────────────────────────────────────────

def _decay_and_prune_pass(db_path: str) -> dict[str, int]:
    """
    Recalculate decay scores for all episodes and delete those below viability.

    Episodes table lives in companion.db (EpisodicStore schema):
        id, summary, topics, importance, tone, occurred_at, conversation_id

    Decay formula: score = importance × e^(−λ × days_elapsed)
    """
    now_ms = time.time() * 1000
    ms_per_day = 86_400_000.0

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT id, importance, occurred_at FROM episodes"
        ).fetchall()

        pruned = 0
        kept = 0
        ids_to_prune: list[str] = []

        for row in rows:
            days = (now_ms - row["occurred_at"]) / ms_per_day
            score = row["importance"] * math.exp(-DECAY_LAMBDA * days)

            if score < VIABILITY_THRESHOLD:
                ids_to_prune.append(row["id"])
            else:
                kept += 1

        if ids_to_prune:
            placeholders = ",".join("?" * len(ids_to_prune))
            conn.execute(
                f"DELETE FROM episodes WHERE id IN ({placeholders})", ids_to_prune
            )
            pruned = len(ids_to_prune)

        _set_stat(conn, "last_decay_pass", str(int(time.time())))
        _set_stat(conn, "episodes_kept", str(kept))
        _set_stat(conn, "episodes_pruned_lifetime",
                  str(int(conn.execute(
                      "SELECT COALESCE(value, '0') FROM learner_stats WHERE key = 'episodes_pruned_lifetime'"
                  ).fetchone() or ("0",))[0]) + pruned)
        conn.commit()

    return {"pruned": pruned, "kept": kept}


def _interest_map_pass(db_path: str) -> int:
    """
    Build the interest map: for each topic, compute weight = sum of
    (importance × e^(−INTEREST_LAMBDA × days_since)) across all episodes
    mentioning that topic.

    This gives a recency-weighted frequency — topics from yesterday count
    more than topics from last month. Mirrors how humans stay interested in
    things they're actively working on.
    """
    now_ms = time.time() * 1000
    ms_per_day = 86_400_000.0

    topic_weights: defaultdict[str, float] = defaultdict(float)
    topic_counts: Counter[str] = Counter()
    topic_last_seen: dict[str, int] = {}

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT topics, importance, occurred_at FROM episodes"
        ).fetchall()

        for row in rows:
            try:
                topics: list[str] = json.loads(row["topics"])
            except (json.JSONDecodeError, TypeError):
                continue

            days = (now_ms - row["occurred_at"]) / ms_per_day
            weight_contribution = row["importance"] * math.exp(-INTEREST_LAMBDA * days)

            for topic in topics:
                if not topic or len(topic) < 2:
                    continue
                topic_weights[topic] += weight_contribution
                topic_counts[topic] += 1
                if topic not in topic_last_seen or row["occurred_at"] > topic_last_seen[topic]:
                    topic_last_seen[topic] = int(row["occurred_at"])

        now_int = int(now_ms)
        for topic, weight in topic_weights.items():
            conn.execute(
                """
                INSERT OR REPLACE INTO interest_map
                    (topic, weight, mention_count, last_mentioned, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (topic, weight, topic_counts[topic],
                 topic_last_seen.get(topic, now_int), now_int),
            )

        # Cull dead topics (weight below floor)
        conn.execute("DELETE FROM interest_map WHERE weight < 0.005")
        _set_stat(conn, "last_interest_pass", str(int(time.time())))
        conn.commit()

    return len(topic_weights)


def _cooccurrence_pass(db_path: str) -> int:
    """
    Build topic co-occurrence graph.

    For every pair of topics that appear in the same episode, increment
    their edge strength. This reveals relationships the user has implicitly
    established: "nextjs + supabase", "debugging + rls", "agent-os + memory".

    No ML. No embeddings. Pure counting.
    """
    now_ms = int(time.time() * 1000)
    edge_counts: Counter[tuple[str, str]] = Counter()
    edge_last_seen: dict[tuple[str, str], int] = {}

    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT topics, occurred_at FROM episodes"
        ).fetchall()

        for row in rows:
            try:
                topics: list[str] = json.loads(row["topics"])
            except (json.JSONDecodeError, TypeError):
                continue

            # Deduplicate + sort for canonical edge direction
            unique = sorted(set(t for t in topics if t and len(t) >= 2))

            for i, a in enumerate(unique):
                for b in unique[i + 1:]:
                    edge = (a, b)
                    edge_counts[edge] += 1
                    ts = int(row["occurred_at"])
                    if edge not in edge_last_seen or ts > edge_last_seen[edge]:
                        edge_last_seen[edge] = ts

        # Write top MAX_GRAPH_EDGES edges (prune weak ones to stay lean)
        top_edges = edge_counts.most_common(MAX_GRAPH_EDGES)

        for (a, b), count in top_edges:
            conn.execute(
                """
                INSERT OR REPLACE INTO topic_graph
                    (topic_a, topic_b, strength, last_seen)
                VALUES (?, ?, ?, ?)
                """,
                (a, b, float(count), edge_last_seen.get((a, b), now_ms)),
            )

        # Remove stale weak edges not in top set
        if top_edges:
            min_strength = top_edges[-1][1]
            conn.execute(
                "DELETE FROM topic_graph WHERE strength < ?", (min_strength * 0.5,)
            )

        _set_stat(conn, "last_cooccurrence_pass", str(int(time.time())))
        conn.commit()

    return len(top_edges)


def _prediction_pass(db_path: str) -> int:
    """
    Generate daily predictions: what topics will the user likely engage with
    today/tomorrow?

    Algorithm (no ML):
    1. Top N topics from interest_map (high recency-weighted frequency)
    2. For each hot topic, pull its strongest co-occurring neighbors
    3. Combine with a small recency boost for project-activity topics
    4. Write to predictions table, keyed by today's date

    Predictions inform the TypeScript engine to pre-warm HAM cache and
    boost relevant episodes in context assembly — without any LLM call.
    """
    today = date.today().isoformat()

    with _connect(db_path) as conn:
        # Clear stale predictions (previous day)
        conn.execute("DELETE FROM predictions WHERE predicted_date != ?", (today,))

        # Top 5 topics by interest weight
        hot_rows = conn.execute(
            """
            SELECT topic, weight FROM interest_map
            WHERE weight > ? ORDER BY weight DESC LIMIT 5
            """,
            (PREDICTION_CONFIDENCE_MIN,),
        ).fetchall()

        if not hot_rows:
            conn.commit()
            return 0

        max_weight = hot_rows[0]["weight"] if hot_rows else 1.0

        predictions: dict[str, tuple[float, str]] = {}  # topic → (confidence, source)

        # Direct interest predictions
        for row in hot_rows:
            confidence = min(1.0, row["weight"] / max_weight)
            predictions[row["topic"]] = (confidence, "interest")

        # Co-occurrence expansion: neighbors of hot topics get partial credit
        hot_topics = [r["topic"] for r in hot_rows]
        if hot_topics:
            placeholders = ",".join("?" * len(hot_topics))
            neighbor_rows = conn.execute(
                f"""
                SELECT topic_b AS neighbor, strength
                FROM topic_graph
                WHERE topic_a IN ({placeholders})
                  AND topic_b NOT IN ({placeholders})
                ORDER BY strength DESC
                LIMIT 10
                """,
                hot_topics + hot_topics,
            ).fetchall()

            if neighbor_rows:
                max_strength = neighbor_rows[0]["strength"]
                for r in neighbor_rows:
                    conf = min(0.6, (r["strength"] / max_strength) * 0.6)
                    if r["neighbor"] not in predictions:
                        predictions[r["neighbor"]] = (conf, "cooccurrence")

        # Write predictions
        for topic, (confidence, source) in predictions.items():
            conn.execute(
                """
                INSERT OR REPLACE INTO predictions
                    (topic, confidence, source, predicted_date)
                VALUES (?, ?, ?, ?)
                """,
                (topic, confidence, source, today),
            )

        _set_stat(conn, "last_prediction_pass", str(int(time.time())))
        conn.commit()

    return len(predictions)


def _llm_consolidation_pass(db_path: str, google_api_key: str) -> int:
    """
    YOUNG_ADULT+ only. One LLM call per day, max.

    Finds the 3 lowest-scoring near-duplicate episode pairs (same topic, very
    similar summaries) and merges them into a single richer memory using
    gemini-3.1-flash-lite-preview.

    Budget: ~500 input tokens, ~150 output tokens per merge. Max 3 merges/day.
    This is the ONLY place in the learner that spends tokens — and only after
    earning it through 500+ real interactions.
    """
    try:
        import google.genai as genai  # type: ignore[import]
    except ImportError:
        return 0  # SDK not installed — skip silently

    now_ms = time.time() * 1000
    ms_per_day = 86_400_000.0
    merged = 0

    with _connect(db_path) as conn:
        # Check if we already ran consolidation today
        last_run = conn.execute(
            "SELECT value FROM learner_stats WHERE key = 'last_llm_consolidation_date'"
        ).fetchone()
        today = str(int(time.time() // 86400))
        if last_run and last_run["value"] == today:
            return 0  # Already ran today

        # Find episodes sharing topics, sorted by lowest decay (candidates for merge)
        rows = conn.execute(
            "SELECT id, summary, topics, importance, occurred_at FROM episodes"
        ).fetchall()

        # Group by first topic
        by_topic: defaultdict[str, list[dict]] = defaultdict(list)
        for row in rows:
            try:
                topics = json.loads(row["topics"])
            except Exception:
                continue
            if topics:
                days = (now_ms - row["occurred_at"]) / ms_per_day
                score = row["importance"] * math.exp(-DECAY_LAMBDA * days)
                by_topic[topics[0]].append({
                    "id": row["id"],
                    "summary": row["summary"],
                    "score": score,
                    "occurred_at": row["occurred_at"],
                })

        # Find topics with 2+ episodes (merge candidates), lowest total score first
        candidates = [
            (topic, eps)
            for topic, eps in by_topic.items()
            if len(eps) >= 2
        ]
        candidates.sort(key=lambda x: sum(e["score"] for e in x[1]))

        client = genai.Client(api_key=google_api_key)

        for topic, episodes in candidates[:3]:
            if merged >= 3:
                break
            oldest = sorted(episodes, key=lambda e: e["occurred_at"])[:2]
            summaries = "\n".join(f"- {e['summary']}" for e in oldest)

            prompt = (
                f"Merge these two memory fragments about '{topic}' into ONE concise sentence "
                f"(max 30 words). Preserve all unique facts. Return only the merged sentence:\n\n"
                f"{summaries}"
            )

            try:
                resp = client.models.generate_content(
                    model="gemini-3.1-flash-lite-preview",
                    contents=prompt,
                )
                merged_text = (resp.text or "").strip()
                if not merged_text or len(merged_text) > 300:
                    continue

                # Delete the two originals, insert the merged version
                ids_to_delete = [e["id"] for e in oldest]
                placeholders = ",".join("?" * len(ids_to_delete))
                conn.execute(
                    f"DELETE FROM episodes WHERE id IN ({placeholders})", ids_to_delete
                )
                new_importance = max(e["occurred_at"] for e in oldest)
                conn.execute(
                    """
                    INSERT INTO episodes
                        (id, summary, topics, importance, tone, occurred_at, conversation_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        __import__("uuid").uuid4().hex,
                        merged_text,
                        json.dumps([topic]),
                        0.6,
                        "neutral",
                        new_importance,
                        "learner-consolidation",
                    ),
                )
                merged += 1
            except Exception as e:
                logger.warning("LLM consolidation merge failed: %s", e)
                continue

        _set_stat(conn, "last_llm_consolidation_date", today)
        _set_stat(conn, "total_llm_merges", str(merged))
        conn.commit()

    return merged


def _self_model_pass(db_path: str, maturity: str, episode_count: int) -> dict[str, Any]:
    """
    Write a self-assessment snapshot to the self_model table.

    The learner introspects its own state and generates a structured report:
    - What it is (maturity level, capabilities)
    - What it knows (memory stats)
    - How it's performing (prediction yield, interest map health)
    - What it wants to change (proposals, within allowed bounds)
    - What it cannot change (constitution reminder)

    This runs weekly. It's the learner's written understanding of itself.
    """
    now_ms = int(time.time() * 1000)
    config = load_config(db_path)

    try:
        with _connect(db_path) as conn:
            # Memory stats
            ep_count = conn.execute("SELECT COUNT(*) FROM episodes").fetchone()[0]
            interest_count = conn.execute("SELECT COUNT(*) FROM interest_map").fetchone()[0]
            graph_edges = conn.execute("SELECT COUNT(*) FROM topic_graph").fetchone()[0]
            today = date.today().isoformat()
            predictions_today = conn.execute(
                "SELECT COUNT(*) FROM predictions WHERE predicted_date = ?", (today,)
            ).fetchone()[0]

            # Recent updates
            recent_updates = conn.execute(
                """SELECT param_key, old_value, new_value, reason, timestamp_ms
                   FROM update_audit_log WHERE applied = 1
                   ORDER BY timestamp_ms DESC LIMIT 5"""
            ).fetchall()

            # Top topics
            top_topics = conn.execute(
                "SELECT topic, weight FROM interest_map ORDER BY weight DESC LIMIT 5"
            ).fetchall()

        # Capabilities based on maturity
        capabilities = ["decay_pass", "interest_map", "predictions"]
        if maturity in ("teen", "young_adult", "adult"):
            capabilities.append("cooccurrence_graph")
        if maturity in ("young_adult", "adult"):
            capabilities.append("llm_consolidation_1x_daily")
        if maturity == "adult":
            capabilities.append("web_research_1x_weekly")

        # Next unlock
        next_ul = _next_unlock(episode_count)

        # What I cannot change (explicit self-awareness of constitution)
        cannot_change = sorted(IMMUTABLE_CONSTITUTION)

        # What I can change
        can_change = {k: {"bounds": [v[0], v[1]], "current": config.get(k), "desc": v[2]}
                      for k, v in MUTABLE_PARAMS.items()}

        report = {
            "generated_at": today,
            "identity": {
                "maturity": maturity,
                "episode_count": int(ep_count),
                "capabilities": capabilities,
                "next_unlock": next_ul,
            },
            "memory_health": {
                "episodes": int(ep_count),
                "interest_topics": int(interest_count),
                "graph_edges": int(graph_edges),
                "predictions_today": int(predictions_today),
                "top_topics": [{"topic": r[0], "weight": round(float(r[1]), 4)}
                               for r in top_topics],
            },
            "self_governance": {
                "cannot_change": cannot_change,
                "can_change": can_change,
                "recent_updates": [
                    {
                        "param": r[0],
                        "old": round(float(r[1]), 4),
                        "new": round(float(r[2]), 4),
                        "reason": r[3],
                        "when_ms": r[4],
                    }
                    for r in recent_updates
                ],
            },
            "growth_observations": _growth_observations(db_path, maturity, episode_count, config),
        }

        config_snapshot = json.dumps(config)

        with _connect(db_path) as conn:
            conn.execute(
                "INSERT INTO self_model (snapshot_ms, maturity, episode_count, report, config_snapshot) VALUES (?, ?, ?, ?, ?)",
                (now_ms, maturity, episode_count, json.dumps(report), config_snapshot),
            )
            # Keep only last 52 snapshots (one year of weekly snapshots)
            conn.execute(
                "DELETE FROM self_model WHERE id NOT IN (SELECT id FROM self_model ORDER BY snapshot_ms DESC LIMIT 52)"
            )
            conn.commit()

        logger.info(
            "[SelfModel] Snapshot written — maturity=%s episodes=%d capabilities=%s",
            maturity, episode_count, capabilities,
        )
        return report

    except Exception as e:
        logger.warning("[SelfModel] Pass failed: %s", e)
        return {}


def _growth_observations(
    db_path: str,
    maturity: str,
    episode_count: int,
    config: dict[str, float],
) -> list[str]:
    """Generate plain-language observations about growth and what to do more of."""
    observations: list[str] = []

    # Maturity progress
    next_ul = _next_unlock(episode_count)
    remaining = next_ul.get("remaining", 0)
    if isinstance(remaining, int) and remaining > 0:
        observations.append(
            f"I am {episode_count} episodes old (maturity: {maturity}). "
            f"{remaining} more significant interactions will unlock '{next_ul.get('unlocks')}'."
        )

    # Interest lambda observation
    il = config.get("INTEREST_LAMBDA", 0.10)
    if il > 0.15:
        observations.append(
            f"My interest decay rate (INTEREST_LAMBDA={il:.3f}) is relatively high. "
            f"Topics I care about fade quickly. If this seems wrong, I may self-adjust after "
            f"collecting more data."
        )
    elif il < 0.07:
        observations.append(
            f"My interest decay rate (INTEREST_LAMBDA={il:.3f}) is low. "
            f"I hold onto topics a long time. Good for long projects, risky for topic pollution."
        )

    # Prediction confidence
    pcm = config.get("PREDICTION_CONFIDENCE_MIN", 0.15)
    if pcm > 0.25:
        observations.append(
            f"My prediction threshold (PREDICTION_CONFIDENCE_MIN={pcm:.3f}) is strict. "
            f"I only surface topics I'm very confident about. This means fewer but higher-quality predictions."
        )

    # Graph health
    try:
        with _connect(db_path) as conn:
            edges = conn.execute("SELECT COUNT(*) FROM topic_graph").fetchone()[0]
        if edges == 0 and maturity in ("teen", "young_adult", "adult"):
            observations.append(
                "My co-occurrence graph is empty. I need more multi-topic conversations "
                "to start understanding how concepts relate to each other."
            )
        elif edges > 100:
            observations.append(
                f"My topic graph has {edges} edges. I'm starting to understand how concepts "
                f"relate in this user's world."
            )
    except Exception:
        pass

    if not observations:
        observations.append(
            f"I am functioning normally at maturity level '{maturity}' with {episode_count} episodes. "
            f"No anomalies detected."
        )

    return observations


def _self_update_pass(db_path: str, maturity: str, episode_count: int) -> list[dict[str, Any]]:
    """
    Analyze metrics and apply any warranted self-updates.
    Only runs for teen+ (needs enough data to make meaningful decisions).
    Updates are gated by SelfUpdater — audit log mandatory, bounds enforced.
    """
    if maturity == "child":
        return []

    proposals = analyze_and_propose(db_path, maturity, episode_count)
    if not proposals:
        return []

    updater = SelfUpdater(db_path, maturity, episode_count)
    applied: list[dict[str, Any]] = []

    for proposal in proposals:
        try:
            result = updater.propose(
                key=proposal["key"],
                new_value=proposal["new_value"],
                reason=proposal["reason"],
            )
            applied.append(result)
        except PermissionError as e:
            # Constitution violation — log and continue
            logger.error("[SelfUpdate] Constitution violation attempt: %s", e)
        except (ValueError, RuntimeError) as e:
            # Rate limit, bounds, or apply failure — expected, not critical
            logger.debug("[SelfUpdate] Proposal rejected: %s", e)
        except Exception as e:
            logger.warning("[SelfUpdate] Unexpected error: %s", e)

    return applied


# ── BackgroundLearner class ───────────────────────────────────────────────────

class BackgroundLearner:
    """
    Asyncio-native background learner. Start via start(), stop via stop().
    All heavy work runs in a thread executor to avoid blocking the event loop.

    Maturity system — capabilities unlock as experience accumulates:
      child       (0–99 episodes):   decay + prune + interest map
      teen        (100–499):          + co-occurrence graph
      young_adult (500–1999):         + LLM consolidation (1 call/day max)
      adult       (2000+):            + (future: targeted web research 1x/week)
    """

    def __init__(self, db_path: str, google_api_key: Optional[str] = None) -> None:
        self.db_path = str(Path(db_path).expanduser())
        self.google_api_key = google_api_key or os.environ.get("GOOGLE_API_KEY")
        self._tasks: list[asyncio.Task] = []  # type: ignore[type-arg]
        self._running = False
        self._maturity: str = "child"

    def _episode_count(self) -> int:
        try:
            with _connect(self.db_path) as conn:
                row = conn.execute("SELECT COUNT(*) FROM episodes").fetchone()
                return int(row[0]) if row else 0
        except Exception:
            return 0

    def _refresh_maturity(self) -> str:
        count = self._episode_count()
        level = _get_maturity_level(count)
        if level != self._maturity:
            logger.info(
                "BackgroundLearner maturity: %s → %s (%d episodes)",
                self._maturity, level, count,
            )
            self._maturity = level
        return level

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        try:
            _ensure_schema(self.db_path)
        except Exception as exc:
            logger.warning("BackgroundLearner: schema init failed: %s", exc)
            return

        try:
            ensure_audit_schema(self.db_path)
        except Exception as exc:
            logger.warning("BackgroundLearner: audit schema init failed: %s", exc)

        self._refresh_maturity()
        logger.info(
            "BackgroundLearner starting (maturity=%s) on %s",
            self._maturity, self.db_path,
        )
        loop = asyncio.get_event_loop()

        self._tasks = [
            loop.create_task(self._decay_loop()),
            loop.create_task(self._interest_loop()),
            loop.create_task(self._cooccurrence_loop()),    # teen+
            loop.create_task(self._prediction_loop()),
            loop.create_task(self._consolidation_loop()),   # young_adult+
            loop.create_task(self._self_model_loop()),      # weekly self-assessment
            loop.create_task(self._self_update_loop()),     # weekly self-tuning (teen+)
        ]

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        logger.info("BackgroundLearner stopped")

    # ── Loops ──────────────────────────────────────────────────────────────────

    async def _decay_loop(self) -> None:
        """Every 30 minutes — lightweight, safe to run frequently."""
        await asyncio.sleep(60)  # brief startup delay
        while self._running:
            await self._run(_decay_and_prune_pass, "decay+prune")
            await asyncio.sleep(30 * 60)

    async def _interest_loop(self) -> None:
        """Every 60 minutes."""
        await asyncio.sleep(90)
        while self._running:
            await self._run(_interest_map_pass, "interest_map")
            await asyncio.sleep(60 * 60)

    async def _cooccurrence_loop(self) -> None:
        """Every 4 hours — TEEN+ only. Heavier scan, less frequent."""
        await asyncio.sleep(120)
        while self._running:
            self._refresh_maturity()
            if self._maturity in ("teen", "young_adult", "adult"):
                await self._run(_cooccurrence_pass, "cooccurrence_graph")
            else:
                logger.debug("Co-occurrence skipped (maturity=child)")
            await asyncio.sleep(4 * 60 * 60)

    async def _prediction_loop(self) -> None:
        """Once per day — runs at startup then every 24 h."""
        await asyncio.sleep(180)
        while self._running:
            await self._run(_prediction_pass, "predictions")
            await asyncio.sleep(24 * 60 * 60)

    async def _self_model_loop(self) -> None:
        """Weekly self-assessment — writes structured self-awareness snapshot."""
        await asyncio.sleep(240)  # startup delay
        while self._running:
            self._refresh_maturity()
            await self._run(
                lambda db: _self_model_pass(db, self._maturity, self._episode_count()),
                "self_model",
            )
            await asyncio.sleep(7 * 24 * 60 * 60)  # weekly

    async def _self_update_loop(self) -> None:
        """Weekly self-tuning — proposes and applies config changes (teen+ only)."""
        await asyncio.sleep(270)  # after self-model run
        while self._running:
            self._refresh_maturity()
            if self._maturity != "child":
                await self._run(
                    lambda db: _self_update_pass(db, self._maturity, self._episode_count()),
                    "self_update",
                )
            await asyncio.sleep(7 * 24 * 60 * 60)  # weekly

    async def _consolidation_loop(self) -> None:
        """Once per day — YOUNG_ADULT+ only. One LLM call to merge near-dupes."""
        await asyncio.sleep(300)  # longer startup delay — less urgent
        while self._running:
            self._refresh_maturity()
            if self._maturity in ("young_adult", "adult") and self.google_api_key:
                await self._run(
                    lambda db: _llm_consolidation_pass(db, self.google_api_key),  # type: ignore[arg-type]
                    "llm_consolidation",
                )
            else:
                logger.debug(
                    "LLM consolidation skipped (maturity=%s, has_key=%s)",
                    self._maturity, bool(self.google_api_key),
                )
            await asyncio.sleep(24 * 60 * 60)

    async def _run(self, fn: object, label: str) -> None:
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(None, fn, self.db_path)  # type: ignore[arg-type]
            logger.debug("BackgroundLearner [%s] → %s", label, result)
        except Exception as exc:
            # Never crash the engine — learning is best-effort
            logger.warning("BackgroundLearner [%s] failed: %s", label, exc)

    # ── Stats (for API endpoint) ──────────────────────────────────────────────

    def get_stats(self) -> dict[str, object]:
        try:
            with _connect(self.db_path) as conn:
                stats_rows = conn.execute("SELECT key, value FROM learner_stats").fetchall()
                stats = {r["key"]: r["value"] for r in stats_rows}

                prediction_count = conn.execute(
                    "SELECT COUNT(*) FROM predictions WHERE predicted_date = ?",
                    (date.today().isoformat(),),
                ).fetchone()[0]

                interest_count = conn.execute(
                    "SELECT COUNT(*) FROM interest_map"
                ).fetchone()[0]

                graph_edges = conn.execute(
                    "SELECT COUNT(*) FROM topic_graph"
                ).fetchone()[0]

            episode_count = self._episode_count()
            return {
                **stats,
                "predictions_today": prediction_count,
                "interest_topics": interest_count,
                "graph_edges": graph_edges,
                "running": self._running,
                "maturity": self._maturity,
                "episode_count": episode_count,
                "next_unlock": _next_unlock(episode_count),
            }
        except Exception:
            return {"running": self._running, "maturity": self._maturity, "error": "stats unavailable"}

    def get_predictions(self) -> list[dict[str, object]]:
        try:
            today = date.today().isoformat()
            with _connect(self.db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT topic, confidence, source FROM predictions
                    WHERE predicted_date = ?
                    ORDER BY confidence DESC
                    """,
                    (today,),
                ).fetchall()
            return [{"topic": r["topic"], "confidence": r["confidence"], "source": r["source"]}
                    for r in rows]
        except Exception:
            return []

    def get_self_model(self) -> dict[str, object]:
        """Return the most recent self-assessment snapshot."""
        try:
            with _connect(self.db_path) as conn:
                row = conn.execute(
                    "SELECT report, snapshot_ms FROM self_model ORDER BY snapshot_ms DESC LIMIT 1"
                ).fetchone()
                if not row:
                    return {
                        "note": "No self-model snapshot yet. First snapshot runs 4 minutes after startup, then weekly.",
                        "maturity": self._maturity,
                        "episode_count": self._episode_count(),
                    }
                return {
                    "snapshot_ms": row["snapshot_ms"],
                    **json.loads(row["report"]),
                }
        except Exception:
            return {"error": "self_model unavailable"}

    def get_audit_log(self, limit: int = 20) -> list[dict[str, object]]:
        """Return recent audit log entries (all self-updates ever made)."""
        try:
            from engine.self_updater import SelfUpdater  # type: ignore[import]
            updater = SelfUpdater(self.db_path, self._maturity, self._episode_count())
            return updater.get_audit_log(limit)
        except Exception:
            return []

    def get_config(self) -> dict[str, object]:
        """Return current mutable config with bounds and descriptions."""
        try:
            from engine.self_updater import load_config, MUTABLE_PARAMS  # type: ignore[import]
            current = load_config(self.db_path)
            return {
                key: {
                    "value": current.get(key),
                    "min": bounds[0],
                    "max": bounds[1],
                    "description": bounds[2],
                }
                for key, bounds in MUTABLE_PARAMS.items()
            }
        except Exception:
            return {}

    def get_hot_topics(self, limit: int = 10) -> list[dict[str, object]]:
        try:
            with _connect(self.db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT topic, weight, mention_count
                    FROM interest_map
                    ORDER BY weight DESC LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            return [{"topic": r["topic"], "weight": r["weight"], "count": r["mention_count"]}
                    for r in rows]
        except Exception:
            return []

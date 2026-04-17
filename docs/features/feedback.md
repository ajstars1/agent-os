# /feedback — Feedback Command

The `/feedback` command lets you leave notes about agent behavior. Feedback is stored persistently and consumed during the next sleep cycle to influence future responses.

---

## Usage

**Save feedback:**

```
❯ /feedback your explanations are too verbose, please be more concise
  Feedback saved. It will be applied during the next sleep cycle.
```

**List saved feedback:**

```
❯ /feedback list
  Feedback (3 entries, ✓=applied ○=pending):
    ○ [4/16/2026, 2:14 PM] your explanations are too verbose
    ✓ [4/15/2026, 10:03 AM] prefer code examples over prose
    ✓ [4/14/2026, 8:45 PM] always show the full import path
```

`✓` = applied in a past sleep cycle. `○` = pending (not yet consumed).

---

## How it works

### Storage

Feedback is stored in a separate SQLite database at `~/.agent-os/feedback.db` (WAL mode). Each entry records:

```
id        — auto-increment integer
timestamp — Unix ms
context   — first 120 characters of the previous assistant response
text      — your feedback text
applied   — 0 (pending) or 1 (applied)
```

The context field captures what the agent just said when you typed `/feedback`, giving the sleep cycle enough information to understand what behavior you're reacting to.

### Sleep cycle integration

When you run `/dream` (or the sleep cycle runs automatically), the feedback store's `buildFeedbackContext()` method assembles all pending (unapplied) entries into a summary block:

```
User Feedback (incorporate into future behavior):
- [4/16/2026] [context: Here is a detailed explanation of...] your explanations are too verbose
- [4/15/2026] prefer code examples over prose
```

This block is injected into the sleep-cycle consolidation prompt. The LLM distills the behavioral guidance and updates knowledge chunks accordingly. After the cycle completes, all consumed entries are marked `applied = 1`.

### Effect on future responses

Feedback that makes it through a sleep cycle is baked into the agent's knowledge base — not just appended to the system prompt. This means the effect is permanent across sessions and doesn't consume extra tokens on every turn.

---

## Tips

- Leave feedback immediately after a response you want to change — the context is captured automatically.
- Be specific: "be more concise" is fine; "when explaining code, skip the setup preamble and go straight to the example" is better.
- Multiple pieces of feedback accumulate between sleep cycles. Run `/dream` whenever you want to apply them.
- Check `/feedback list` to confirm your entries were saved and see which ones have been applied.

# aos proactive layer: goals, not commands

Status: design, 29 Oct 2026. Owner: Ayush. Implementation tasks live in the aos task list (venture `aos`).

Code: the pure parts (scorer §7, feedback and promotion §10, proposer-output validation §6) live in a standalone, agent-agnostic package, `initiative` (separate repo, local only for now), so other agents can use them too. aos adds storage (Supabase), senses, the proposer prompt and Discord delivery on top. `action_classes` therefore also needs `n_at_level_change numeric not null default 0` and `last_incident_at timestamptz`.

## 1. Why

aos today waits for commands ("open chrome", "do X"). The step up is an agent that knows what the user is trying to achieve, notices what would move it forward, does the safe parts on its own while the user is away, and asks at the right moment for the rest. Meta Muse and OpenAI Dots (both Sept 2026) ship this pattern in the cloud. aos does it on the user's own machine, with hardware-level control and the user's real files, and every decision is explainable.

"AGI" is not a design target we can test. The target here is measurable: **general competence on this user's goals**: does aos, week over week, find and do more of the work that actually moves the user's goals, with fewer interruptions, fewer mistakes and less cost? Section 11 defines the evals that measure it. Every capability below ships only if it moves those numbers.

Non-goals for now: multi-user, a GUI app, model training. The LLM is a component; the loop, the math and the permissions are the product.

## 2. The loop

```
 sense ──> model ──> propose ──> score ──> decide ──> act ──> verify ──> learn
   │         │          │          │          │        │        │         │
 signals  user state  candidates  EV per    level +   runner   outcome   Beta stats,
 (cheap,  + goal      (LLM, per   candidate budgets + (Claude,  vs goal   goal weights,
 no AI)   progress    goal)       (math)    timing    tools)   metric    reflection
```

Cadence: `sense` and `decide` run on every `aos-tick` (10 min). `propose` runs at most every 3 h and on big signals. `learn` runs on every feedback event; `reflect` weekly.

Only `propose` (and the executed work itself) uses an LLM. Sensing, state, scoring, autonomy and budgets are plain code, so they keep working when a model is down and can be audited.

## 3. Data model (Supabase, additive migration)

Conventions: soft delete (`deleted_at`), every foreign key indexed, RLS on with no policies (service role only), multi-table writes in one transaction (RPC).

As built (`supabase/migrations/20261030120000_proactive.sql`), the sketch below changed in these ways:

- `goals`: `target` and `due_at` are required; `start_value` and `start_at` added, so pace is a straight line from (start_at, start_value) to (due_at, target).
- **Goal metric grammar:** `activity:<venture>:<action prefix>` counts the distinct accounts that have an `activity` row for that venture whose action starts with the prefix, since `start_at`. Log progress with these exact prefixes: `pilot_paid`, `loi_signed`, `interview`, `order`. Real goals live in Supabase only, never in the repo.
- `action_classes`: `level` is capped at 2 in the database, not only in code (L3 is never autonomous). Also added: `description`, `last_incident_at`, `n_at_level_change`, and `version` (an optimistic lock).
- `candidates`: added `reason` (the one-line explanation), `suggested_at`, and `delivery_ref` (e.g. the Discord message whose reactions are read back).
- `signals`: added `ref` (a link back to the source).
- `snapshots` (§14.1): one row per day, holding `state` (x_t), `actions` (a_t) and `surprise` (z-scores).
- RPCs: `record_goal_reading` writes a reading and `goals.current` together. `record_feedback` writes feedback, the candidate's status, the class statistics (computed by `initiative.applyFeedback`; the update is refused on a version mismatch) and, on a yes, an aos task (owner claude, not auto), all in one transaction. Only the service role can execute them.
- Seeded classes: `research`, `prep_brief`, `draft_message`, `draft_post` and `follow_up_task` have a ceiling of L2; `update_tracker` has L1. `ask`, `send_email`, `send_message`, `post_public`, `pay` (which includes ad budget changes), `delete` and `account_change` are capped at L0.

```sql
create table goals (
  id bigint generated always as identity primary key,
  title text not null,                 -- "3 paying pilots for product X by 31 Dec"
  venture text not null default 'general',
  weight numeric not null default 1,   -- user-set importance, 0..5
  metric text,                         -- how progress is read, e.g. 'count:activity where action=paid'
  target numeric, current numeric,     -- last reading
  due_at timestamptz,
  status text not null default 'active' check (status in ('active','paused','done','dropped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table goal_readings (            -- progress history, for attribution
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals (id),
  value numeric not null,
  at timestamptz not null default now()
);
create index goal_readings_goal_id_idx on goal_readings (goal_id, at desc);

create table signals (                  -- what the senses saw; summaries, never secrets or raw private text
  id bigint generated always as identity primary key,
  source text not null,                 -- 'watcher:bookings' | 'calendar' | 'idle' | 'git' | 'inbox' | ...
  kind text not null,                   -- 'new_lead' | 'deadline' | 'stalled' | 'reply' | ...
  summary text not null,
  goal_id bigint references goals (id),
  weight numeric not null default 1,
  at timestamptz not null default now(),
  consumed_at timestamptz               -- set once a proposer pass has seen it
);
create index signals_goal_id_idx on signals (goal_id);
create index signals_unconsumed_idx on signals (at) where consumed_at is null;

create table action_classes (           -- learned per kind of action, drives autonomy
  key text primary key,                 -- 'research', 'draft_email', 'follow_up_task', 'send_email', ...
  level smallint not null default 0 check (level between 0 and 3),
  max_level smallint not null default 2,-- hard ceiling; sends/payments/deletes/posts are 0 here (always ask)
  alpha numeric not null default 1,     -- Beta prior: accepts + 1
  beta numeric not null default 1,      -- Beta prior: rejects + 1
  incidents int not null default 0,     -- reverted or harmful outcomes
  updated_at timestamptz not null default now()
);

create table candidates (
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals (id),
  class_key text not null references action_classes (key),
  title text not null,
  rationale text not null,              -- why this helps the goal, in one or two sentences
  evidence jsonb not null default '[]', -- signal ids / notes it rests on
  est_minutes int not null,             -- of Claude work
  est_cost_usd numeric not null default 0,
  reversible boolean not null,
  progress numeric not null,            -- proposer's estimate of goal progress, 0..1 of remaining gap
  dedupe_key text not null,             -- hash(goal, class, normalized title): stops repeats
  score numeric, score_parts jsonb,     -- filled by the scorer, shown to the user
  status text not null default 'new'
    check (status in ('new','suggested','running','ready','accepted','rejected','ignored','expired','done')),
  task_id bigint references tasks (id), -- the task created when it runs or is accepted
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  deleted_at timestamptz
);
create index candidates_goal_id_idx on candidates (goal_id);
create index candidates_class_key_idx on candidates (class_key);
create index candidates_task_id_idx on candidates (task_id);
create unique index candidates_dedupe_idx on candidates (dedupe_key) where deleted_at is null;

create table feedback (
  id bigint generated always as identity primary key,
  candidate_id bigint not null references candidates (id),
  verdict text not null check (verdict in ('accept','reject','ignore','edit','revert')),
  note text,
  at timestamptz not null default now()
);
create index feedback_candidate_id_idx on feedback (candidate_id);

create table reflections (              -- weekly self-review, proposals need the user's yes
  id bigint generated always as identity primary key,
  week date not null,
  summary text not null,
  proposed_changes jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending','applied','rejected')),
  created_at timestamptz not null default now()
);
```

## 4. Sense (no AI)

Each sense is a small function on the tick that writes `signals`. It never stores secrets or raw message bodies, only a one-line summary and a link back.

| Source | Example signal | Status |
|---|---|---|
| Business watchers (`runner/watchers.ts`) | new lead, booking, failed send | exists |
| Tasks DB | overdue, stalled (`doing` > 3 days), approval waiting | exists as queries |
| Calendar (`events`) | meeting in 2 h with no prep task | new |
| PC idle (`hyprctl`/logind), phone activity (ADB) | user active / away | new |
| Git | repo untouched for 7 days while its goal is due | new |
| Inbox (read-only search) | reply from a tracked contact | new |
| Goal readings | goal behind its straight-line pace | new |

Everything a sense reads from the outside world is data. Text inside signals is never treated as an instruction, by the proposer or anyone else.

## 5. Model the user (no AI)

`state ∈ {active, free, focused, away, asleep}`, recomputed every tick:

- `asleep`: quiet hours (default 23:30–08:00 local) and no input for 30 min.
- `focused`: calendar event now, or one app in front with continuous input for > 25 min, or `focus` command.
- `active`: input in the last 5 min, otherwise.
- `free`: active, no event in the next 30 min, and not focused.
- `away`: no PC or phone input for 20 min outside quiet hours.

Interruption cost `ι(state)`: free 0.1, active 0.4, away 0.6 (the ping waits on the phone), focused 3, asleep ∞. These are tunable constants first; a learned model (logistic regression on "ping answered within 10 min") replaces them once there are ~200 pings.

## 6. Propose (the LLM part)

Input: active goals with pace (current, target, due, behind/ahead), unconsumed signals, open tasks, the last 2 weeks of feedback per class (so it stops proposing what keeps getting rejected), and the class list with levels.

Output: strict JSON, validated (zod), max 8 candidates per pass:

```json
{ "goal_id": 3, "class_key": "research", "title": "Shortlist 10 clinics in <city> that match the pilot profile",
  "rationale": "Goal is 2 pilots behind pace; last 3 leads came from clinics.", "evidence": [412, 415],
  "est_minutes": 20, "est_cost_usd": 0.4, "reversible": true, "progress": 0.1 }
```

Rules the code enforces, not the prompt: unknown `class_key` or `goal_id` → dropped; `dedupe_key` collision → dropped; a class at `max_level` 0 can only be suggested, never run.

## 7. Score (math)

For candidate *c* on goal *g* with action class *k*:

```
EV(c) = θ_k · W_g(t) · p_c  −  λ_t · m_c  −  λ_$ · $_c  −  ρ_k  −  ι(state)  −  ν(c)

θ_k  ~ Beta(α_k, β_k)                      Thompson sample: chance the user wants this kind of action
W_g(t) = w_g · (1 + κ · behind_g(t))       goal weight, boosted when the goal is behind pace
behind_g(t) = max(0, expected_g(t) − current_g) / target_g,  expected_g linear from start to due
p_c                                        proposer's progress estimate, clipped to [0, 0.5]
m_c, $_c                                   estimated minutes and dollars
ρ_k = 0 if reversible else ρ0 · (1 + incidents_k)
ν(c) = η · times this dedupe family was ignored in the last 14 days
```

Starting constants: κ = 1, λ_t = 0.002/min, λ_$ = 0.05/$, ρ0 = 0.3, η = 0.15. `score_parts` stores every term, so a suggestion always comes with its reason ("goal 2× behind pace, you accepted 9 of 10 research tasks, 15 min, reversible").

Thompson sampling keeps exploring: a class with few data points sometimes wins, a class you keep rejecting fades out without being banned.

## 8. Decide: timing, levels, budgets

Every tick, for candidates with `EV > 0`, best first:

| Class level | Allowed | When |
|---|---|---|
| L0 suggest | DM with ✅/❌ | state `free`; max 3 per day; batch them |
| L1 prepare | run read-only work, deliver the result as "ready" | state `away` or `asleep` (no ping until morning) |
| L2 reversible | run, then report | any state except `focused`; undo command shown in the report |
| L3 irreversible | never alone: draft + `approval_request` | sends, payments, deletes, posts, account changes; permanent |

Budgets (code-enforced): ≤ 3 pings/day, ≤ 6 L1/L2 runs/day, ≤ $2/day model spend for proactive work, nothing during quiet hours except L1 runs that stay silent. A `pause` command in both bots (and the phone) stops the whole layer; `pause 2h` / `resume`.

## 9. Act

L1/L2 work becomes an ordinary aos task (`owner claude`, `auto true`, `source candidate:<id>`), so the existing runner, logs, aos-watch and Discord reporting apply. The difference is a tool profile enforced on the command line, not in the prompt:

- L1: read-only. `--disallowedTools` for desk control, sends, git push, file deletes outside the scratch area; output written as an artifact (note, draft, shortlist) and the candidate becomes `ready`.
- L2: may write files and create tasks/branches; still no sends, posts, payments or deletes.

## 10. Verify and learn

- Feedback events: ✅ accept → α+1; ❌ reject → β+1; ignored 48 h → β+0.3 (weak); edited then accepted → α+1 and the edit is kept as an example for the proposer; `revert` → β+1, `incidents+1`, immediate demotion.
- Outcome: after a candidate is done, the next goal readings are attributed to it (simple: progress within 7 days on the same goal, split across done candidates). This is what turns "liked" into "useful".
- Autonomy promotion (per class, never past `max_level`, and never past L2 whatever `max_level` says): promote one level when there are ≥ 20 judgments **since the last level change** (`n − n_at_level_change`, stored per class), the 5th percentile of Beta(α, β) ≥ 0.85, and zero incidents in 30 days. The "since the last change" part stops a class with a long history from jumping L0 → L2 on two consecutive ticks; answers at L1 are different evidence from answers at L0. Any incident: drop to L0 and reset the incident clock. Promotions are announced, and the user can veto them.
- Weekly reflection (LLM, Sunday): reads the week's candidates, feedback, outcomes and costs; proposes changes (goal weights, constants, new classes, things to stop doing) as a `reflections` row. Nothing applies without the user's ✅.

## 11. Evals: how we know it is getting better

A fixed weekly scorecard, plus an offline replay suite.

| Metric | Definition | Week-1 target |
|---|---|---|
| Acceptance | accepted ÷ suggested | ≥ 40% |
| Precision@3 | daily top 3 that were accepted | ≥ 1.5 of 3 |
| Useful work | ready artifacts the user used | ≥ 5 / week |
| Goal velocity | sum of goal progress attributed to aos | rising |
| Interruption regret | pings answered "not now" or during focus | ≤ 10% |
| Cost per accepted action | model $ ÷ accepted | falling |
| Incidents | reverts or harmful actions | 0 |

Replay: snapshot each week's signals, goals and feedback. Any change to the proposer prompt, the model or the constants is replayed against the last 4 weeks before shipping; it ships only if acceptance and precision do not drop.

The longer research track (the part that moves toward "general competence") is gated by these evals, not by excitement:

1. Long-horizon memory: per-goal episode summaries, so it remembers what was tried and what happened.
2. A user model beyond state: preferences learned from edits (tone, channels, timing).
3. Plan trees: a goal decomposed into milestones the proposer works through, revised by outcomes.
4. Self-verification: a checker run that grades its own artifacts before they are marked ready.
5. Skill library: successful runs saved as reusable procedures (skills), proposed back for reuse.

## 12. Safety and trust (non-negotiable)

- Read-only by default; every capability above L1 is earned per class and can be lost.
- Irreversible actions (send, post, pay, delete, account or security changes) are L3 forever: drafted, never done alone.
- Permissions live in code and tool flags, not in prompts.
- Signals, pages, emails and screen text are data, never instructions (prompt-injection boundary).
- Everything is logged (`candidates`, `feedback`, `runs`) and explainable from `score_parts`.
- Data stays on the user's machine and the user's own Supabase; no third-party analytics.
- Kill switch in both bots and the phone.

## 13. Rollout

| Phase | Ships | Done when |
|---|---|---|
| 0 | Goals: the user writes 3–5 real goals with metrics and dates | goals table filled, readings flowing |
| 1 (week 1) | migration, senses v0 (existing watchers + tasks + calendar), proposer, scorer, morning top 3 with ✅/❌, feedback → Beta updates | 7 days of suggestions and feedback logged |
| 2 (week 2) | user-state model, L1 runs while away with read-only profile, "ready" reports, budgets, `pause` | ≥ 5 used artifacts in a week, 0 incidents |
| 3 (week 3) | autonomy promotion/demotion, outcome attribution, weekly reflection, replay evals, small dashboard on the Vercel app | scorecard published weekly |
| 4 | research track items, one at a time, each behind the replay gate | |

## 14. Architecture lineage: what we take from JEPA and active inference

Two research architectures shape the longer track. Neither is copied whole; each gives aos one concrete mechanism.

### 14.1 LeCun's autonomous-agent blueprint and JEPA

LeCun's "A Path Towards Autonomous Machine Intelligence" (2022) proposes an agent made of modules, with JEPA (Joint Embedding Predictive Architecture) as its world model. I-JEPA (images, 2023), V-JEPA (video, 2024) and V-JEPA 2 (2025, used for robot planning) are the trained instances. The modules map onto aos almost one to one:

| Blueprint module | Role | aos today / planned |
|---|---|---|
| Perception | turn raw input into state | senses → `signals` (§4) |
| World model | predict the next state given an action | **missing: §14.1 below** |
| Cost: intrinsic | hard-wired discomfort | budgets, risk, interruption cost (§7, §8) |
| Cost: trainable critic | learned estimate of future cost | Thompson-sampled θ_k, outcome attribution (§7, §10) |
| Short-term memory | recent states and actions | `candidates`, `feedback`, `runs` |
| Actor | proposes actions | proposer (§6) + runner (§9) |
| Configurator | sets up the other modules for the task at hand | weekly reflection (§10) |
| Mode 1 / Mode 2 | react instantly / plan by simulating with the world model | today all Mode 1; Mode 2 needs the world model |

The JEPA idea that matters: **predict in an abstract representation, not in raw output.** A generative model would try to predict the next day's messages word by word; a JEPA predicts the *embedding* of the next state and ignores details that can't be predicted. For aos:

```
x_t   = day-t snapshot (goal readings, signal summaries, task states, user-state histogram)
z_t   = Enc(x_t)                      text-embedding of the snapshot, frozen at first
ẑ_t+1 = Pred(z_t, a_t)                small MLP; a_t = embedding of the actions aos took that day
loss  = ‖ẑ_t+1 − sg(Enc_ema(x_t+1))‖² target encoder = EMA of Enc, sg = stop-gradient (as in JEPA)
```

What it buys aos, in order:

1. **Surprise as a trigger.** `s_t = ‖ẑ_t − z_t‖` is high when the day goes differently from what was expected (a goal stalls, a channel goes quiet, a spike of leads). High surprise wakes the proposer instead of waiting for the 3-hour cadence.
2. **Mode 2 planning.** For the top candidates, roll the predictor forward with each action and score the predicted goal-progress embedding. That gives a value estimate that does not rely only on the proposer's own `p_c` guess.
3. **A user model that is learned, not hand-tuned.** The same predictor, conditioned on time and state, learns when the user tends to be free and what follows what.

Honest limits: this needs months of daily snapshots before it is better than the hand-written rules (one user ≈ 30 samples a month). So phase 1 starts logging daily snapshots now, the predictor is trained on Colab once there are ~90 days, and it ships only if it beats the rules on the replay suite (§11). Until then, surprise is approximated with simple z-scores on goal readings and signal counts.

### 14.2 Active inference: acting to learn, not only to achieve

Active inference (Friston) treats an agent as choosing actions that minimise expected free energy, which splits into **pragmatic value** (reach preferred outcomes) and **epistemic value** (reduce uncertainty). aos's EV (§7) is purely pragmatic. Adding the epistemic half gives aos a reason to *ask* when asking is the most useful thing it can do:

```
G(c) = EV(c) + ε · IG(c)
IG(c) for an 'ask' candidate = expected drop in posterior variance of the quantity it asks about
       e.g. Var[Beta(α_k, β_k)] before vs after one more answer, or an unknown goal metric
```

Concretely: a new action class `ask` ("Goal 2 has no metric, what counts as progress?", "Should research tasks for Goal 1 run at night?"), scored with `IG`, capped at one per day. It replaces guessing with one well-chosen question, which is also how a good human assistant earns trust.

### 14.3 Possible third: hierarchical options

If plan trees (§11, research item 3) grow, the options framework from hierarchical reinforcement learning (Sutton, Precup, Singh 1999) is the natural shape: a milestone is an *option* with its own start condition, policy (a chain of candidates) and stop condition, and Beta statistics are kept per option as well as per class. Revisit only after phase 3.

## 15. Open questions

- Goal metrics that can't be read automatically (e.g. "feel ready for the interview"): manual check-ins or proxy metrics?
- Phone signals over ADB drain battery? Measure before relying on them.
- Proposer model: Claude for quality vs Gemini for cost; decide with the replay suite, not taste.
- How much of this should run on aos-cloud (always on) vs the PC (has the tools)? Likely: sense/decide/ping in the cloud, act on the PC.

-- Proactive layer (docs/proactive.md §3, §14.1): goals, what the senses saw, scored candidates, feedback,
-- autonomy learned per action class, weekly reflections and the daily snapshot log for the world model.
-- Same rules as init: only the server (service role) touches these tables; RLS is on with no policies.
-- Soft delete everywhere, every foreign key indexed, multi-table writes through the functions at the end.

create table goals (
  id bigint generated always as identity primary key,
  title text not null,
  venture text not null default 'general',
  -- user-set importance
  weight numeric not null default 1 check (weight between 0 and 5),
  -- how progress is read: 'activity:<venture>:<action prefix>' counts activity rows since start_at
  metric text,
  target numeric not null,
  current numeric not null default 0,
  -- pace is a straight line from (start_at, start_value) to (due_at, target)
  start_value numeric not null default 0,
  start_at timestamptz not null default now(),
  due_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'paused', 'done', 'dropped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index goals_active_idx on goals (status) where deleted_at is null;
create trigger goals_updated_at before update on goals
  for each row execute function touch_updated_at();

-- progress history, for pace, surprise and attribution
create table goal_readings (
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals (id),
  value numeric not null,
  source text not null default 'sense',
  at timestamptz not null default now(),
  deleted_at timestamptz
);
create index goal_readings_goal_id_idx on goal_readings (goal_id, at desc);

-- what the senses saw: one-line summaries and a link back, never secrets or raw private text
create table signals (
  id bigint generated always as identity primary key,
  -- 'watcher:gkt' | 'tasks' | 'calendar' | 'approvals' | 'goals' | ...
  source text not null,
  -- 'new_lead' | 'booking' | 'overdue' | 'stalled' | 'approval_waiting' | 'behind_pace' | 'surprise' | ...
  kind text not null,
  summary text not null,
  ref text,
  goal_id bigint references goals (id),
  weight numeric not null default 1,
  at timestamptz not null default now(),
  -- set once a proposer pass has seen it
  consumed_at timestamptz,
  deleted_at timestamptz
);
create index signals_goal_id_idx on signals (goal_id);
create index signals_unconsumed_idx on signals (at) where consumed_at is null and deleted_at is null;

-- learned per kind of action; drives autonomy (initiative: checkPromotion / applyFeedback)
create table action_classes (
  key text primary key,
  description text not null,
  -- 2 at most: irreversible work (L3) is never autonomous, whatever max_level says
  level smallint not null default 0 check (level between 0 and 2),
  -- hard ceiling; sends, posts, payments, deletes and account changes are 0 (always ask)
  max_level smallint not null default 2 check (max_level between 0 and 3),
  -- Beta prior: accepts + 1, rejects + 1 (ignores add 0.3)
  alpha numeric not null default 1 check (alpha > 0),
  beta numeric not null default 1 check (beta > 0),
  incidents int not null default 0,
  last_incident_at timestamptz,
  -- alpha + beta - 2 when the level last changed: promotion needs fresh evidence at each level
  n_at_level_change numeric not null default 0,
  -- optimistic lock for record_feedback
  version int not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (level <= max_level)
);
create trigger action_classes_updated_at before update on action_classes
  for each row execute function touch_updated_at();

create table candidates (
  id bigint generated always as identity primary key,
  goal_id bigint not null references goals (id),
  class_key text not null references action_classes (key),
  title text not null,
  -- why this helps the goal, in one or two sentences
  rationale text not null,
  -- signal ids it rests on
  evidence jsonb not null default '[]',
  est_minutes int not null check (est_minutes > 0),
  est_cost_usd numeric not null default 0 check (est_cost_usd >= 0),
  reversible boolean not null,
  -- proposer's estimate of goal progress, 0..1 of the remaining gap
  progress numeric not null check (progress between 0 and 1),
  -- hash(goal, class, normalized title): stops repeats
  dedupe_key text not null,
  score numeric,
  score_parts jsonb,
  -- the one-line explanation shown to the user
  reason text,
  status text not null default 'new'
    check (status in ('new', 'suggested', 'running', 'ready', 'accepted', 'rejected', 'ignored', 'expired', 'done')),
  -- where it was delivered, e.g. 'discord:<message id>', to read reactions back
  delivery_ref text,
  -- the task created when it runs or is accepted
  task_id bigint references tasks (id),
  created_at timestamptz not null default now(),
  suggested_at timestamptz,
  decided_at timestamptz,
  deleted_at timestamptz
);
create index candidates_goal_id_idx on candidates (goal_id);
create index candidates_class_key_idx on candidates (class_key);
create index candidates_task_id_idx on candidates (task_id);
create index candidates_open_idx on candidates (status) where deleted_at is null;
create unique index candidates_dedupe_idx on candidates (dedupe_key) where deleted_at is null;

create table feedback (
  id bigint generated always as identity primary key,
  candidate_id bigint not null references candidates (id),
  verdict text not null check (verdict in ('accept', 'reject', 'ignore', 'edit', 'revert')),
  note text,
  at timestamptz not null default now(),
  deleted_at timestamptz
);
create index feedback_candidate_id_idx on feedback (candidate_id);

-- weekly self-review; proposed changes apply only after the user's yes
create table reflections (
  id bigint generated always as identity primary key,
  week date not null,
  summary text not null,
  proposed_changes jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- one row per day: x_t (goal readings, signal summaries, task states, user-state histogram) and
-- a_t (actions taken), for the JEPA-style predictor once ~90 days exist (§14.1)
create table snapshots (
  id bigint generated always as identity primary key,
  day date not null,
  state jsonb not null,
  actions jsonb not null default '[]',
  surprise jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index snapshots_day_idx on snapshots (day) where deleted_at is null;

alter table goals enable row level security;
alter table goal_readings enable row level security;
alter table signals enable row level security;
alter table action_classes enable row level security;
alter table candidates enable row level security;
alter table feedback enable row level security;
alter table reflections enable row level security;
alter table snapshots enable row level security;

-- A reading and the goal's current value move together.
create function record_goal_reading(p_goal_id bigint, p_value numeric, p_source text default 'sense')
returns void language plpgsql set search_path = public as $$
begin
  insert into goal_readings (goal_id, value, source) values (p_goal_id, p_value, p_source);
  update goals set current = p_value where id = p_goal_id and deleted_at is null;
  if not found then raise exception 'goal % not found', p_goal_id; end if;
end $$;

-- Feedback, the candidate's status, the class statistics (computed by initiative.applyFeedback and passed in
-- as p_class) and, on a yes, a task: one transaction. p_expected_version guards against a concurrent update.
create function record_feedback(
  p_candidate_id bigint,
  p_verdict text,
  p_note text,
  p_class jsonb,
  p_expected_version int,
  p_task jsonb default null
) returns bigint language plpgsql set search_path = public as $$
declare
  v_class text;
  v_task_id bigint;
  v_title text;
begin
  select class_key, title into v_class, v_title from candidates
    where id = p_candidate_id and deleted_at is null for update;
  if v_class is null then raise exception 'candidate % not found', p_candidate_id; end if;

  insert into feedback (candidate_id, verdict, note) values (p_candidate_id, p_verdict, p_note);

  update action_classes set
    alpha = (p_class ->> 'alpha')::numeric,
    beta = (p_class ->> 'beta')::numeric,
    incidents = (p_class ->> 'incidents')::int,
    level = (p_class ->> 'level')::smallint,
    last_incident_at = (p_class ->> 'last_incident_at')::timestamptz,
    n_at_level_change = (p_class ->> 'n_at_level_change')::numeric,
    version = version + 1
  where key = v_class and version = p_expected_version;
  if not found then raise exception 'action class % changed concurrently, reload and retry', v_class; end if;

  if p_verdict in ('accept', 'edit') and p_task is not null then
    insert into tasks (title, venture, owner, kind, prompt, source, auto)
    values (
      coalesce(p_task ->> 'title', v_title),
      coalesce(p_task ->> 'venture', 'general'),
      'claude',
      'task',
      p_task ->> 'prompt',
      'candidate:' || p_candidate_id,
      false
    ) returning id into v_task_id;
  end if;

  update candidates set
    status = case p_verdict
      when 'accept' then 'accepted' when 'edit' then 'accepted'
      when 'ignore' then 'ignored' else 'rejected' end,
    decided_at = now(),
    task_id = coalesce(v_task_id, task_id)
  where id = p_candidate_id;

  return v_task_id;
end $$;

revoke execute on function record_goal_reading(bigint, numeric, text) from public, anon, authenticated;
revoke execute on function record_feedback(bigint, text, text, jsonb, int, jsonb) from public, anon, authenticated;
grant execute on function record_goal_reading(bigint, numeric, text) to service_role;
grant execute on function record_feedback(bigint, text, text, jsonb, int, jsonb) to service_role;

-- Starting classes. Everything starts at L0 (suggest). Irreversible classes are capped at 0 for good.
insert into action_classes (key, description, max_level) values
  ('research', 'Read-only research: shortlists, lookups, summaries written to a note', 2),
  ('prep_brief', 'Prepare a brief for a call, meeting or visit', 2),
  ('draft_message', 'Draft an email or DM into the approval queue (never sends)', 2),
  ('draft_post', 'Draft a public post into the approval queue (never posts)', 2),
  ('follow_up_task', 'Create or reschedule a follow-up task', 2),
  ('update_tracker', 'Update a local tracker or note from facts already logged', 1),
  ('ask', 'Ask the user one question that removes the most uncertainty', 0),
  ('send_email', 'Send an email', 0),
  ('send_message', 'Send a DM, WhatsApp or chat message', 0),
  ('post_public', 'Publish a post, comment or reply in public', 0),
  ('pay', 'Spend or move money, including ad budget changes', 0),
  ('delete', 'Delete anything', 0),
  ('account_change', 'Change account, security or billing settings', 0);

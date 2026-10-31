-- aos-control: tasks, calendar, Claude runs, approvals and outreach activity.
-- Only the server (service role) touches these tables; RLS is on with no policies.

create type task_status as enum ('todo', 'doing', 'waiting_approval', 'done', 'skipped');

create table tasks (
  id bigint generated always as identity primary key,
  title text not null,
  venture text not null default 'general',
  owner text not null default 'ayush'
    check (owner in ('ayush', 'claude', 'shiven', 'mayank', 'family')),
  kind text not null default 'task'
    check (kind in ('task', 'send', 'post', 'check', 'meeting')),
  status task_status not null default 'todo',
  due_at timestamptz,
  -- 'daily' | 'weekdays' | 'weekly:MO,TH' | 'every:3d'
  recur text,
  -- what Claude should do when it runs this task
  prompt text,
  cwd text,
  -- where the task came from, e.g. notes/0unveiled-sprint-first-pilot.md §8
  source text,
  notes text,
  -- the local runner may start it unattended (owner must be claude)
  auto boolean not null default false,
  last_pinged_at timestamptz,
  parent_id bigint references tasks (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index tasks_open_due_idx on tasks (status, due_at) where deleted_at is null;
create index tasks_parent_id_idx on tasks (parent_id);

create table runs (
  id bigint generated always as identity primary key,
  task_id bigint references tasks (id),
  trigger text not null default 'timer',
  status text not null default 'running'
    check (status in ('running', 'ok', 'error', 'timeout')),
  summary text,
  session_id text,
  cost_usd numeric,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index runs_task_id_idx on runs (task_id);

create table approvals (
  id bigint generated always as identity primary key,
  task_id bigint references tasks (id),
  channel text not null,
  recipient text,
  draft text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  result text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  deleted_at timestamptz
);
create index approvals_task_id_idx on approvals (task_id);
create index approvals_status_idx on approvals (status) where deleted_at is null;

create table events (
  id bigint generated always as identity primary key,
  title text not null,
  venture text not null default 'general',
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index events_starts_at_idx on events (starts_at) where deleted_at is null;

-- CRM-style log of every outreach touch
create table activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  venture text not null,
  channel text not null,
  account text not null,
  action text not null,
  result text,
  task_id bigint references tasks (id)
);
create index activity_task_id_idx on activity (task_id);
create index activity_venture_at_idx on activity (venture, at desc);

create function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger tasks_updated_at before update on tasks
  for each row execute function touch_updated_at();

alter table tasks enable row level security;
alter table runs enable row level security;
alter table approvals enable row level security;
alter table events enable row level security;
alter table activity enable row level security;

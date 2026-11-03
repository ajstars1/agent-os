-- aos v2 Phase 0: per-recipient touch counter for the send gate (lib/send-gate.ts). One row per handle
-- (LinkedIn profile or thread, email, Reddit user, name) of each approval that went out; the gate blocks a
-- third distinct approval to the same person. Same rules as init: service role only,
-- RLS on with no policies, soft delete.
create table touches (
  id bigint generated always as identity primary key,
  recipient_key text not null,
  channel text not null,
  approval_id bigint references approvals (id),
  task_id bigint references tasks (id),
  at timestamptz not null default now(),
  deleted_at timestamptz
);
create index touches_recipient_key_idx on touches (recipient_key) where deleted_at is null;
create index touches_task_id_idx on touches (task_id);
create index touches_approval_id_idx on touches (approval_id);
alter table touches add constraint touches_approval_key_uniq unique (approval_id, recipient_key);

alter table touches enable row level security;

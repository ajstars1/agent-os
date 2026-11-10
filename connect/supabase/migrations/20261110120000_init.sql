-- aos connect: one database for many users.
--
-- Every signed-in user holds a real Supabase token, and so does every AI app they connect. Either can call the
-- database API directly, without going through our server. So the rules live HERE, not in the app:
--   * row level security: a user reads and writes only rows where user_id is their own id;
--   * check constraints and quotas: sizes and row counts are capped in the database;
--   * the approval guard: a token that belongs to a connected AI app can never approve a draft.
-- Nothing is ever hard-deleted by a user: there is no delete policy, only deleted_at.

create type task_status as enum ('todo', 'doing', 'waiting_approval', 'done', 'skipped');

create function touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------------

create table profiles (
  user_id uuid primary key default auth.uid() references auth.users (id),
  display_name text check (char_length(display_name) <= 80),
  -- IANA name, e.g. Asia/Kolkata; "today" in the agenda is this zone's day
  timezone text not null default 'Asia/Kolkata' check (char_length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger profiles_updated_at before update on profiles for each row execute function touch_updated_at();

-- A goal is a number and a date: "10 orders by 15 Nov".
create table goals (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  title text not null check (char_length(title) between 3 and 300),
  area text not null default 'general' check (area ~ '^[a-z0-9_-]{1,40}$'),
  unit text check (char_length(unit) <= 40),
  target numeric not null check (target > 0),
  current numeric not null default 0,
  due_at timestamptz,
  status text not null default 'active' check (status in ('active', 'met', 'dropped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id)
);
create index goals_user_idx on goals (user_id) where deleted_at is null;
create trigger goals_updated_at before update on goals for each row execute function touch_updated_at();

create table tasks (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  title text not null check (char_length(title) between 3 and 300),
  area text not null default 'general' check (area ~ '^[a-z0-9_-]{1,40}$'),
  -- who does it: the person, or their AI assistant
  owner text not null default 'me' check (owner in ('me', 'assistant')),
  status task_status not null default 'todo',
  due_at timestamptz,
  -- 'daily' | 'weekdays' | 'weekly:MO,TH' | 'every:3d'
  recur text check (recur ~ '^(daily|weekdays|every:[0-9]{1,3}d|weekly:(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA)){0,6})$'),
  notes text check (char_length(notes) <= 8000),
  goal_id bigint,
  -- first task of a recurring series
  parent_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, id),
  -- composite keys: a row can only point at a goal or task of the SAME user (plain foreign keys skip RLS)
  foreign key (user_id, goal_id) references goals (user_id, id),
  foreign key (user_id, parent_id) references tasks (user_id, id),
  check (recur is null or due_at is not null)
);
create index tasks_user_open_due_idx on tasks (user_id, status, due_at) where deleted_at is null;
create index tasks_goal_idx on tasks (user_id, goal_id);
create index tasks_parent_idx on tasks (user_id, parent_id);
create trigger tasks_updated_at before update on tasks for each row execute function touch_updated_at();

-- A draft of something that leaves the building (email, message, post). The AI writes it; only the person approves it.
create table approvals (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  task_id bigint,
  channel text not null check (channel ~ '^[a-z0-9_-]{1,60}$'),
  recipient text check (char_length(recipient) <= 200),
  draft text not null check (char_length(draft) between 1 and 5000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'sent', 'failed')),
  result text check (char_length(result) <= 1000),
  -- earliest time the approved text may go out
  send_after timestamptz,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, id),
  foreign key (user_id, task_id) references tasks (user_id, id)
);
create index approvals_user_status_idx on approvals (user_id, status) where deleted_at is null;
create index approvals_task_idx on approvals (user_id, task_id);

-- Log of what happened: every send, reply, order, meeting.
create table activity (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  at timestamptz not null default now(),
  area text not null default 'general' check (area ~ '^[a-z0-9_-]{1,40}$'),
  channel text not null check (char_length(channel) between 1 and 60),
  account text not null check (char_length(account) between 1 and 200),
  action text not null check (char_length(action) between 1 and 500),
  result text check (char_length(result) <= 1000),
  task_id bigint,
  deleted_at timestamptz,
  foreign key (user_id, task_id) references tasks (user_id, id)
);
create index activity_user_at_idx on activity (user_id, at desc);
create index activity_task_idx on activity (user_id, task_id);

-- Each time a goal's number is read, so progress has a history.
create table goal_readings (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  goal_id bigint not null,
  value numeric not null,
  note text check (char_length(note) <= 500),
  at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (user_id, goal_id) references goals (user_id, id)
);
create index goal_readings_goal_idx on goal_readings (user_id, goal_id, at desc);

create table events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id),
  title text not null check (char_length(title) between 2 and 300),
  area text not null default 'general' check (area ~ '^[a-z0-9_-]{1,40}$'),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text check (char_length(location) <= 300),
  notes text check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ends_at is null or ends_at >= starts_at)
);
create index events_user_starts_idx on events (user_id, starts_at) where deleted_at is null;

-- Request counter for the rate limit. Users cannot read or write it; only hit_rate() below can.
create table rate_hits (
  user_id uuid not null references auth.users (id),
  bucket text not null check (char_length(bucket) between 1 and 40),
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (user_id, bucket, window_start)
);

-- ---------------------------------------------------------------------------------------------------------------
-- row level security: own rows only, no hard delete
-- ---------------------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'goals', 'tasks', 'approvals', 'activity', 'goal_readings', 'events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('revoke delete, truncate, references, trigger on %I from authenticated', t);
    execute format('grant select, insert, update on %I to authenticated', t);
    execute format(
      'create policy %I on %I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
    execute format(
      'create policy %I on %I for insert to authenticated with check (user_id = (select auth.uid()))', t || '_insert_own', t);
    execute format(
      'create policy %I on %I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
  end loop;
end $$;

alter table rate_hits enable row level security;
revoke all on rate_hits from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- quotas: one user cannot fill the database
-- ---------------------------------------------------------------------------------------------------------------

create function enforce_quota() returns trigger language plpgsql set search_path = '' as $$
declare
  max_rows integer := tg_argv[0]::integer;
  n integer;
begin
  -- runs as the user, so RLS already limits the count to their rows
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into n using new.user_id;
  if n >= max_rows then
    raise exception 'Limit reached: at most % rows in %', max_rows, tg_table_name using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger goals_quota before insert on goals for each row execute function enforce_quota('200');
create trigger tasks_quota before insert on tasks for each row execute function enforce_quota('5000');
create trigger approvals_quota before insert on approvals for each row execute function enforce_quota('5000');
create trigger activity_quota before insert on activity for each row execute function enforce_quota('20000');
create trigger goal_readings_quota before insert on goal_readings for each row execute function enforce_quota('20000');
create trigger events_quota before insert on events for each row execute function enforce_quota('5000');

-- ---------------------------------------------------------------------------------------------------------------
-- the approval guard
-- ---------------------------------------------------------------------------------------------------------------

-- A token issued to a connected app (Claude, ChatGPT, any MCP client) carries a client_id claim. A token from the
-- person's own sign-in on our site does not. Only the second kind may approve or reject, so an assistant can
-- never approve its own draft, even by calling the database directly.
create function guard_approval() returns trigger language plpgsql set search_path = '' as $$
declare
  from_app boolean := (auth.jwt() ->> 'client_id') is not null;
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.decided_at := null;
    new.result := null;
    return new;
  end if;

  if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
    raise exception 'An approval cannot change owner';
  end if;

  if (new.draft is distinct from old.draft
      or new.recipient is distinct from old.recipient
      or new.channel is distinct from old.channel
      or new.send_after is distinct from old.send_after)
     and old.status <> 'pending' then
    raise exception 'Only a pending draft can be edited (approval % is %)', old.id, old.status;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('approved', 'rejected') then
      if from_app then
        raise exception 'Only the person can approve or reject, in the aos app. An assistant cannot.';
      end if;
      if old.status <> 'pending' then
        raise exception 'Approval % is already %', old.id, old.status;
      end if;
      new.decided_at := now();
    elsif new.status in ('sent', 'failed') then
      if old.status <> 'approved' then
        raise exception 'Only an approved draft can be marked sent (approval % is %)', old.id, old.status;
      end if;
    else
      raise exception 'An approval cannot go back to pending';
    end if;
  elsif new.decided_at is distinct from old.decided_at then
    new.decided_at := old.decided_at;
  end if;
  return new;
end $$;

create trigger approvals_guard before insert or update on approvals for each row execute function guard_approval();

-- ---------------------------------------------------------------------------------------------------------------
-- multi-table writes, each in one transaction (all run as the calling user, so RLS applies)
-- ---------------------------------------------------------------------------------------------------------------

-- Close a task; a recurring one gets its next occurrence (the server computes p_next_due in the user's time zone).
create function complete_task(p_id bigint, p_status task_status, p_note text default null, p_next_due timestamptz default null)
returns setof tasks language plpgsql security invoker set search_path = '' as $$
declare
  closed public.tasks;
  nxt public.tasks;
begin
  if p_status not in ('done', 'skipped') then
    raise exception 'status must be done or skipped';
  end if;
  update public.tasks
     set status = p_status,
         notes = case when coalesce(p_note, '') = '' then notes else left(concat_ws(E'\n', notes, p_note), 8000) end
   where id = p_id and deleted_at is null and status not in ('done', 'skipped')
  returning * into closed;
  if not found then
    raise exception 'Task % not found or already closed', p_id;
  end if;
  return next closed;
  if closed.recur is not null and p_next_due is not null then
    insert into public.tasks (title, area, owner, due_at, recur, goal_id, parent_id)
    values (closed.title, closed.area, closed.owner, p_next_due, closed.recur, closed.goal_id, coalesce(closed.parent_id, closed.id))
    returning * into nxt;
    return next nxt;
  end if;
end $$;

-- Queue a draft and park its task until the person decides.
create function request_approval(p_channel text, p_draft text, p_recipient text default null, p_task_id bigint default null,
                                 p_send_after timestamptz default null)
returns approvals language plpgsql security invoker set search_path = '' as $$
declare
  ap public.approvals;
begin
  insert into public.approvals (channel, draft, recipient, task_id, send_after)
  values (p_channel, p_draft, p_recipient, p_task_id, p_send_after)
  returning * into ap;
  if p_task_id is not null then
    update public.tasks set status = 'waiting_approval'
     where id = p_task_id and deleted_at is null and status in ('todo', 'doing');
  end if;
  return ap;
end $$;

-- The person's decision. The guard trigger rejects this call when it comes from a connected app.
create function decide_approval(p_id bigint, p_decision text, p_edited_draft text default null)
returns approvals language plpgsql security invoker set search_path = '' as $$
declare
  ap public.approvals;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;
  if coalesce(p_edited_draft, '') <> '' then
    update public.approvals set draft = p_edited_draft where id = p_id and deleted_at is null and status = 'pending';
  end if;
  update public.approvals set status = p_decision
   where id = p_id and deleted_at is null and status = 'pending'
  returning * into ap;
  if not found then
    raise exception 'Approval % not found or already decided', p_id;
  end if;
  if p_decision = 'rejected' and ap.task_id is not null then
    update public.tasks set status = 'todo' where id = ap.task_id and status = 'waiting_approval';
  end if;
  return ap;
end $$;

-- After the assistant sent an approved draft: record the outcome, log it, and close the task when nothing is left.
create function mark_approval_sent(p_id bigint, p_result text, p_failed boolean default false)
returns approvals language plpgsql security invoker set search_path = '' as $$
declare
  ap public.approvals;
  task_area text;
  left_open integer;
begin
  update public.approvals
     set status = case when p_failed then 'failed' else 'sent' end, result = left(p_result, 1000)
   where id = p_id and deleted_at is null
  returning * into ap;
  if not found then
    raise exception 'Approval % not found', p_id;
  end if;
  select area into task_area from public.tasks where id = ap.task_id;
  insert into public.activity (area, channel, account, action, result, task_id)
  values (coalesce(task_area, 'general'), ap.channel, coalesce(nullif(ap.recipient, ''), 'unknown'),
          case when p_failed then 'send failed (approval ' || ap.id || ')' else 'sent (approval ' || ap.id || ')' end,
          left(p_result, 1000), ap.task_id);
  if not p_failed and ap.task_id is not null then
    select count(*) into left_open from public.approvals
     where task_id = ap.task_id and deleted_at is null and status in ('pending', 'approved');
    if left_open = 0 then
      update public.tasks set status = 'done' where id = ap.task_id and status = 'waiting_approval';
    end if;
  end if;
  return ap;
end $$;

-- Record a goal's new number and keep the history.
create function record_goal_reading(p_goal_id bigint, p_value numeric, p_note text default null)
returns goals language plpgsql security invoker set search_path = '' as $$
declare
  g public.goals;
begin
  update public.goals
     set current = p_value,
         status = case when status = 'active' and p_value >= target then 'met' else status end
   where id = p_goal_id and deleted_at is null
  returning * into g;
  if not found then
    raise exception 'Goal % not found', p_goal_id;
  end if;
  insert into public.goal_readings (goal_id, value, note) values (p_goal_id, p_value, p_note);
  return g;
end $$;

-- Rate limit: counts one request for the caller in a fixed window and says whether it is still within the limit.
-- SECURITY DEFINER because users have no access to rate_hits at all; the caller's id comes from their token.
create function hit_rate(p_bucket text, p_limit integer, p_window_s integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  win timestamptz;
  n integer;
begin
  if uid is null then
    return false;
  end if;
  if p_window_s < 1 or p_limit < 1 then
    raise exception 'bad rate limit';
  end if;
  win := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s);
  insert into public.rate_hits (user_id, bucket, window_start, hits)
  values (uid, left(p_bucket, 40), win, 1)
  on conflict (user_id, bucket, window_start) do update set hits = public.rate_hits.hits + 1
  returning hits into n;
  return n <= p_limit;
end $$;

revoke all on function hit_rate(text, integer, integer) from public, anon;
grant execute on function hit_rate(text, integer, integer) to authenticated;
revoke all on function complete_task(bigint, task_status, text, timestamptz) from public, anon;
revoke all on function request_approval(text, text, text, bigint, timestamptz) from public, anon;
revoke all on function decide_approval(bigint, text, text) from public, anon;
revoke all on function mark_approval_sent(bigint, text, boolean) from public, anon;
revoke all on function record_goal_reading(bigint, numeric, text) from public, anon;
grant execute on function complete_task(bigint, task_status, text, timestamptz) to authenticated;
grant execute on function request_approval(text, text, text, bigint, timestamptz) to authenticated;
grant execute on function decide_approval(bigint, text, text) to authenticated;
grant execute on function mark_approval_sent(bigint, text, boolean) to authenticated;
grant execute on function record_goal_reading(bigint, numeric, text) to authenticated;

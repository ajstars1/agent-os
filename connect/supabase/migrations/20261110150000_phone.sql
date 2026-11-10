-- The phone channel (Telegram first). A person links their chat from /app; the bot then pings each new draft with
-- Approve / Reject buttons and answers /today and /drafts.
--
-- Who may do what:
--   * Only the person, signed in on our site, can create a link code. A connected app's token cannot, so an
--     assistant can never link a chat of its own and approve through it.
--   * The bot's webhook calls the channel_* functions with the server's secret key. Those functions are the only
--     door: each one finds the user from the linked chat and touches that user's rows only.

-- ---------------------------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------------------------

create table channel_links (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  channel text not null check (channel in ('telegram')),
  external_id text not null check (external_id ~ '^-?[0-9]{1,30}$'),
  label text check (char_length(label) <= 100),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index channel_links_one_per_user on channel_links (user_id, channel) where deleted_at is null;
create unique index channel_links_one_per_chat on channel_links (channel, external_id) where deleted_at is null;
create index channel_links_user_idx on channel_links (user_id);

-- One-time codes for linking. Only the hash is stored.
create table link_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id),
  channel text not null check (channel in ('telegram')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index link_codes_user_idx on link_codes (user_id, created_at desc);

alter table channel_links enable row level security;
alter table link_codes enable row level security;
revoke all on channel_links from anon, authenticated;
revoke all on link_codes from anon, authenticated;

-- The person can see their link and unlink it (soft delete). Nothing else. The chat id is readable so the server can
-- ping the person's own chat after a draft; it is not a secret (only our bot token can write to it).
grant select (id, channel, external_id, label, created_at, deleted_at, user_id) on channel_links to authenticated;
grant update (deleted_at) on channel_links to authenticated;
create policy channel_links_select_own on channel_links for select to authenticated
  using (user_id = (select auth.uid()));
create policy channel_links_unlink_own on channel_links for update to authenticated
  using (user_id = (select auth.uid()) and deleted_at is null)
  with check (user_id = (select auth.uid()) and deleted_at is not null);

-- ---------------------------------------------------------------------------------------------------------------
-- the person: make a link code
-- ---------------------------------------------------------------------------------------------------------------

create function create_link_code(p_channel text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  code text;
  recent integer;
begin
  if uid is null or (auth.jwt() ->> 'role') is distinct from 'authenticated' then
    raise exception 'Sign in first';
  end if;
  if (auth.jwt() ->> 'client_id') is not null then
    raise exception 'Only the person can link a phone, in the aos app. An assistant cannot.';
  end if;
  if p_channel is distinct from 'telegram' then
    raise exception 'Unknown channel %', p_channel;
  end if;
  select count(*) into recent from public.link_codes where user_id = uid and created_at > now() - interval '1 hour';
  if recent >= 10 then
    raise exception 'Too many link attempts. Try again in an hour.';
  end if;
  code := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.link_codes (code_hash, user_id, channel, expires_at)
  values (encode(sha256(convert_to(code, 'UTF8')), 'hex'), uid, p_channel, now() + interval '15 minutes');
  return code;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- the bot (server secret key only)
-- ---------------------------------------------------------------------------------------------------------------

-- The user behind a linked chat, or null. Also counts the request: at most 60 a minute per user.
create function channel_user(p_channel text, p_external_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
  win timestamptz := date_trunc('minute', now());
  n integer;
begin
  select user_id into uid from public.channel_links
   where channel = p_channel and external_id = p_external_id and deleted_at is null;
  if uid is null then
    return null;
  end if;
  insert into public.rate_hits (user_id, bucket, window_start, hits)
  values (uid, 'channel:' || p_channel, win, 1)
  on conflict (user_id, bucket, window_start) do update set hits = public.rate_hits.hits + 1
  returning hits into n;
  if n > 60 then
    raise exception 'Too many messages. Wait a minute.';
  end if;
  return uid;
end $$;

-- Link a chat with a one-time code from /app. Returns false for an unknown, used or expired code.
create function channel_claim(p_channel text, p_code text, p_external_id text, p_label text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  lc public.link_codes;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.link_codes set used_at = now()
   where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
     and channel = p_channel and used_at is null and expires_at > now()
  returning * into lc;
  if not found then
    return false;
  end if;
  -- one chat per person and one person per chat: the newest link wins
  update public.channel_links set deleted_at = now()
   where channel = p_channel and deleted_at is null and (user_id = lc.user_id or external_id = p_external_id);
  insert into public.channel_links (user_id, channel, external_id, label)
  values (lc.user_id, p_channel, p_external_id, left(p_label, 100));
  return true;
end $$;

-- Everything the bot needs to answer /today and /drafts, for the linked user only.
create function channel_snapshot(p_channel text, p_external_id text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.channel_user(p_channel, p_external_id);
begin
  if uid is null then
    return null;
  end if;
  return jsonb_build_object(
    'timezone', (select timezone from public.profiles where user_id = uid and deleted_at is null),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(t) - 'user_id' - 'deleted_at' order by t.due_at nulls last)
        from (select * from public.tasks
               where user_id = uid and deleted_at is null and status in ('todo', 'doing', 'waiting_approval')
               order by due_at nulls last limit 300) t), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(to_jsonb(a) - 'user_id' - 'deleted_at' order by a.id)
        from (select * from public.approvals
               where user_id = uid and deleted_at is null and status = 'pending' order by id limit 50) a), '[]'::jsonb),
    'goals', coalesce((
      select jsonb_agg(to_jsonb(g) - 'user_id' - 'deleted_at' order by g.due_at nulls last)
        from public.goals g where g.user_id = uid and g.deleted_at is null and g.status = 'active'), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e) - 'user_id' - 'deleted_at' order by e.starts_at)
        from public.events e
       where e.user_id = uid and e.deleted_at is null and e.starts_at >= p_from and e.starts_at < p_to), '[]'::jsonb)
  );
end $$;

-- The person's yes or no from their linked chat. Same rules as decide_approval, scoped to the linked user.
create function channel_decide(p_channel text, p_external_id text, p_id bigint, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.channel_user(p_channel, p_external_id);
  ap public.approvals;
begin
  if uid is null then
    raise exception 'This chat is not linked to aos';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;
  update public.approvals set status = p_decision
   where id = p_id and user_id = uid and deleted_at is null and status = 'pending'
  returning * into ap;
  if not found then
    raise exception 'Draft % not found or already decided', p_id;
  end if;
  if p_decision = 'rejected' and ap.task_id is not null then
    update public.tasks set status = 'todo' where user_id = uid and id = ap.task_id and status = 'waiting_approval';
  end if;
  return to_jsonb(ap) - 'user_id' - 'deleted_at';
end $$;

revoke all on function create_link_code(text) from public, anon;
grant execute on function create_link_code(text) to authenticated;
revoke all on function channel_user(text, text) from public, anon, authenticated, service_role;
revoke all on function channel_claim(text, text, text, text) from public, anon, authenticated;
revoke all on function channel_snapshot(text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function channel_decide(text, text, bigint, text) from public, anon, authenticated;
grant execute on function channel_claim(text, text, text, text) to service_role;
grant execute on function channel_snapshot(text, text, timestamptz, timestamptz) to service_role;
grant execute on function channel_decide(text, text, bigint, text) to service_role;

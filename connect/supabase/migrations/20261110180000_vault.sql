-- The vault and the first sealed action: aos sends an approved email itself, with the person's own mail login.
--
-- The model never sees the login. The person types it on the aos site; the server encrypts it with a key that is
-- not in the database and stores only the ciphertext here. No role can read the ciphertext except the server's
-- secret key, and only through send_claim(), at the moment an approved email goes out.

-- ---------------------------------------------------------------------------------------------------------------
-- approvals: a subject line, a send claim, and no edits by an app after asking
-- ---------------------------------------------------------------------------------------------------------------

alter table approvals add column subject text check (subject is null or (char_length(subject) between 1 and 300 and subject !~ '[\r\n]'));
-- Set by the server while it is sending, and kept after a send. Guards against sending twice.
alter table approvals add column send_claimed_at timestamptz;

create or replace function guard_approval() returns trigger language plpgsql set search_path = '' as $$
declare
  from_app boolean := (auth.jwt() ->> 'client_id') is not null;
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.decided_at := null;
    new.result := null;
    new.send_claimed_at := null;
    return new;
  end if;

  if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
    raise exception 'An approval cannot change owner';
  end if;

  content_changed := new.draft is distinct from old.draft
      or new.subject is distinct from old.subject
      or new.recipient is distinct from old.recipient
      or new.channel is distinct from old.channel
      or new.send_after is distinct from old.send_after;

  if content_changed and old.status <> 'pending' then
    raise exception 'Only a pending draft can be edited (approval % is %)', old.id, old.status;
  end if;
  -- Otherwise an app could swap the text between the moment the person reads it and the moment they press yes.
  if content_changed and from_app then
    raise exception 'An assistant cannot change a draft after asking. Ask again with the new text.';
  end if;

  if new.send_claimed_at is distinct from old.send_claimed_at and current_user in ('authenticated', 'anon') then
    raise exception 'Only the aos server can claim a send';
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

drop function request_approval(text, text, text, bigint, timestamptz);
create function request_approval(p_channel text, p_draft text, p_recipient text default null, p_task_id bigint default null,
                                 p_send_after timestamptz default null, p_subject text default null)
returns approvals language plpgsql security invoker set search_path = '' as $$
declare
  ap public.approvals;
begin
  insert into public.approvals (channel, draft, recipient, task_id, send_after, subject)
  values (p_channel, p_draft, p_recipient, p_task_id, p_send_after, nullif(p_subject, ''))
  returning * into ap;
  if p_task_id is not null then
    update public.tasks set status = 'waiting_approval'
     where id = p_task_id and deleted_at is null and status in ('todo', 'doing');
  end if;
  return ap;
end $$;
revoke all on function request_approval(text, text, text, bigint, timestamptz, text) from public, anon;
grant execute on function request_approval(text, text, text, bigint, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- the vault
-- ---------------------------------------------------------------------------------------------------------------

create table secrets (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  kind text not null check (kind in ('smtp')),
  -- not secret: which provider, which address, the name shown to recipients
  meta jsonb not null default '{}'::jsonb check (char_length(meta::text) <= 2000),
  -- AES-256-GCM, sealed by the server; empty once the person removed it
  ciphertext text not null check (
    ciphertext = '' or (char_length(ciphertext) <= 4000 and ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index secrets_one_per_kind on secrets (user_id, kind) where deleted_at is null;
create index secrets_user_idx on secrets (user_id);
create trigger secrets_updated_at before update on secrets for each row execute function touch_updated_at();

alter table secrets enable row level security;
revoke all on secrets from anon, authenticated;
-- The person, on the site, can see that a connection exists and what it is. Never the ciphertext, and a connected
-- app sees nothing at all here (it asks connection_status() instead).
grant select (id, kind, meta, created_at, updated_at, deleted_at, user_id) on secrets to authenticated;
create policy secrets_select_own on secrets for select to authenticated
  using (user_id = (select auth.uid()) and ((select auth.jwt()) ->> 'client_id') is null);

-- Raises unless the caller is the person on the site.
create function require_person() returns uuid language plpgsql stable set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or (auth.jwt() ->> 'role') is distinct from 'authenticated' then
    raise exception 'Sign in first';
  end if;
  if (auth.jwt() ->> 'client_id') is not null then
    raise exception 'Only the person can change connections, in the aos app. An assistant cannot.';
  end if;
  return uid;
end $$;

-- Save or replace a connection. The server has already checked the login and sealed it.
create function put_secret(p_kind text, p_meta jsonb, p_ciphertext text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_person();
begin
  if p_ciphertext is null or p_ciphertext = '' then
    raise exception 'Nothing to save';
  end if;
  update public.secrets set meta = p_meta, ciphertext = p_ciphertext
   where user_id = uid and kind = p_kind and deleted_at is null;
  if not found then
    insert into public.secrets (user_id, kind, meta, ciphertext) values (uid, p_kind, p_meta, p_ciphertext);
  end if;
end $$;

-- Remove a connection: the row stays (soft delete), the sealed login is erased.
create function remove_secret(p_kind text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_person();
begin
  update public.secrets set deleted_at = now(), ciphertext = ''
   where user_id = uid and kind = p_kind and deleted_at is null;
  return found;
end $$;

-- What an assistant may know: whether aos can send email for this person, and a hint of the address.
create function connection_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  m jsonb;
  addr text;
begin
  if uid is null then
    return jsonb_build_object('email', jsonb_build_object('connected', false));
  end if;
  select meta into m from public.secrets where user_id = uid and kind = 'smtp' and deleted_at is null;
  if m is null then
    return jsonb_build_object('email', jsonb_build_object('connected', false));
  end if;
  addr := coalesce(m ->> 'username', '');
  return jsonb_build_object('email', jsonb_build_object(
    'connected', true,
    'address_hint', case when position('@' in addr) > 1 then left(addr, 1) || '***' || substr(addr, position('@' in addr)) else '***' end));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- sending (server secret key only)
-- ---------------------------------------------------------------------------------------------------------------

-- Take an approved email for sending. Returns the draft and the sealed login, or raises "Cannot send draft N: why".
-- At most one sender gets it; a claim that was never finished frees itself after 5 minutes.
create function send_claim(p_user uuid, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ap public.approvals;
  sec public.secrets;
  today integer;
begin
  select * into ap from public.approvals where id = p_id and user_id = p_user and deleted_at is null for update;
  if not found then
    raise exception 'Cannot send draft %: not found', p_id;
  end if;
  if ap.status <> 'approved' then
    raise exception 'Cannot send draft %: it is %, not approved', p_id, ap.status;
  end if;
  if ap.channel <> 'email' then
    raise exception 'Cannot send draft %: it is not an email', p_id;
  end if;
  if ap.send_after is not null and ap.send_after > now() then
    raise exception 'Cannot send draft %: it is scheduled for later', p_id;
  end if;
  if ap.send_claimed_at is not null and ap.send_claimed_at > now() - interval '5 minutes' then
    raise exception 'Cannot send draft %: it is already being sent', p_id;
  end if;
  select * into sec from public.secrets where user_id = p_user and kind = 'smtp' and deleted_at is null;
  if not found then
    raise exception 'Cannot send draft %: no email connection', p_id;
  end if;
  select count(*) into today from public.approvals
   where user_id = p_user and status in ('sent', 'failed') and send_claimed_at > now() - interval '24 hours';
  if today >= 50 then
    raise exception 'Cannot send draft %: the limit of 50 emails a day is reached', p_id;
  end if;
  update public.approvals set send_claimed_at = now() where id = p_id returning * into ap;
  return jsonb_build_object(
    'user_id', p_user,
    'approval', to_jsonb(ap) - 'user_id' - 'deleted_at',
    'meta', sec.meta,
    'ciphertext', sec.ciphertext);
end $$;

-- The same, for a yes that came from the person's linked chat.
create function channel_send_claim(p_channel text, p_external_id text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  select user_id into uid from public.channel_links
   where channel = p_channel and external_id = p_external_id and deleted_at is null;
  if uid is null then
    raise exception 'This chat is not linked to aos';
  end if;
  return public.send_claim(uid, p_id);
end $$;

-- Record how a claimed send ended.
--   sent   : it went out
--   failed : it may or may not have gone out; never retried automatically
--   retry  : it certainly did not go out; the draft stays approved and can be sent again
create function send_finish(p_user uuid, p_id bigint, p_outcome text, p_result text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ap public.approvals;
  task_area text;
  left_open integer;
begin
  if p_outcome not in ('sent', 'failed', 'retry') then
    raise exception 'outcome must be sent, failed or retry';
  end if;
  if p_outcome = 'retry' then
    update public.approvals set send_claimed_at = null, result = left(p_result, 1000)
     where id = p_id and user_id = p_user and deleted_at is null and status = 'approved' and send_claimed_at is not null
    returning * into ap;
  else
    update public.approvals set status = p_outcome, result = left(p_result, 1000)
     where id = p_id and user_id = p_user and deleted_at is null and status = 'approved' and send_claimed_at is not null
    returning * into ap;
  end if;
  if not found then
    raise exception 'Draft % is not being sent', p_id;
  end if;
  if p_outcome <> 'retry' then
    select area into task_area from public.tasks where user_id = p_user and id = ap.task_id;
    insert into public.activity (user_id, area, channel, account, action, result, task_id)
    values (p_user, coalesce(task_area, 'general'), ap.channel, coalesce(nullif(ap.recipient, ''), 'unknown'),
            case when p_outcome = 'sent' then 'sent by aos (approval ' || ap.id || ')' else 'send failed (approval ' || ap.id || ')' end,
            left(p_result, 1000), ap.task_id);
  end if;
  if p_outcome = 'sent' and ap.task_id is not null then
    select count(*) into left_open from public.approvals
     where user_id = p_user and task_id = ap.task_id and deleted_at is null and status in ('pending', 'approved');
    if left_open = 0 then
      update public.tasks set status = 'done' where user_id = p_user and id = ap.task_id and status = 'waiting_approval';
    end if;
  end if;
  return to_jsonb(ap) - 'user_id' - 'deleted_at';
end $$;

revoke all on function require_person() from public, anon;
revoke all on function put_secret(text, jsonb, text) from public, anon;
revoke all on function remove_secret(text) from public, anon;
revoke all on function connection_status() from public, anon;
grant execute on function require_person() to authenticated;
grant execute on function put_secret(text, jsonb, text) to authenticated;
grant execute on function remove_secret(text) to authenticated;
grant execute on function connection_status() to authenticated;

revoke all on function send_claim(uuid, bigint) from public, anon, authenticated;
revoke all on function channel_send_claim(text, text, bigint) from public, anon, authenticated;
revoke all on function send_finish(uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function send_claim(uuid, bigint) to service_role;
grant execute on function channel_send_claim(text, text, bigint) to service_role;
grant execute on function send_finish(uuid, bigint, text, text) to service_role;

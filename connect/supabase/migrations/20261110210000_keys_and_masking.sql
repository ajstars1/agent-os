-- Named API keys with sealed requests, and masking of contact details.
--
-- API keys: the person saves a key on the aos site with the one host it may go to. An assistant asks aos to make a
-- request with that key by name; it never sees the key. Reads run at once. A request that changes something is
-- stored as an approval and runs only after the person's yes.
--
-- Masking: an email address or phone number that arrives from a connected service is shown to the assistant as a
-- stable stand-in such as [EMAIL_12]. When the assistant uses the stand-in (a recipient, a request), the server
-- puts the real value back. The map lives here and is closed to connected apps.

-- ---------------------------------------------------------------------------------------------------------------
-- the vault: several named entries per kind
-- ---------------------------------------------------------------------------------------------------------------

alter table secrets add column name text not null default 'default' check (name ~ '^[a-z0-9_-]{1,40}$');
alter table secrets drop constraint secrets_kind_check;
alter table secrets add constraint secrets_kind_check check (kind in ('smtp', 'api'));
drop index secrets_one_per_kind;
create unique index secrets_one_per_name on secrets (user_id, kind, name) where deleted_at is null;
grant select (name) on secrets to authenticated;

drop function put_secret(text, jsonb, text);
create function put_secret(p_kind text, p_meta jsonb, p_ciphertext text, p_name text default 'default')
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_person();
  have integer;
begin
  if p_ciphertext is null or p_ciphertext = '' then
    raise exception 'Nothing to save';
  end if;
  if p_kind = 'smtp' and p_name <> 'default' then
    raise exception 'One mailbox per person';
  end if;
  if p_kind = 'api' then
    -- a public DNS name only: no IP address, no single-label or internal name
    if coalesce(p_meta ->> 'host', '') !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'
       or char_length(p_meta ->> 'host') > 253
       or (p_meta ->> 'host') ~ '\.(local|localhost|internal|lan|home|corp|test|invalid|example)$' then
      raise exception 'The host must be a public address such as api.example.com';
    end if;
    if coalesce(p_meta ->> 'scheme', '') not in ('bearer', 'basic', 'header') then
      raise exception 'Unknown way to send the key';
    end if;
    if p_meta ->> 'scheme' = 'header' and coalesce(p_meta ->> 'header', '') !~ '^[A-Za-z][A-Za-z0-9-]{0,63}$' then
      raise exception 'The header name is not valid';
    end if;
    if coalesce(p_meta ->> 'writes', '') not in ('never', 'ask') then
      raise exception 'writes must be never or ask';
    end if;
  end if;
  update public.secrets set meta = p_meta, ciphertext = p_ciphertext
   where user_id = uid and kind = p_kind and name = p_name and deleted_at is null;
  if not found then
    select count(*) into have from public.secrets where user_id = uid and kind = p_kind and deleted_at is null;
    if have >= 20 then
      raise exception 'Limit reached: at most 20 saved keys';
    end if;
    insert into public.secrets (user_id, kind, name, meta, ciphertext) values (uid, p_kind, p_name, p_meta, p_ciphertext);
  end if;
end $$;

drop function remove_secret(text);
create function remove_secret(p_kind text, p_name text default 'default')
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.require_person();
begin
  update public.secrets set deleted_at = now(), ciphertext = ''
   where user_id = uid and kind = p_kind and name = p_name and deleted_at is null;
  return found;
end $$;

-- What an assistant may know: which connections exist. Never a key, never a full address.
create or replace function connection_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  m jsonb;
  addr text;
  email jsonb := jsonb_build_object('connected', false);
  keys jsonb;
begin
  if uid is null then
    return jsonb_build_object('email', email, 'api_keys', '[]'::jsonb);
  end if;
  select meta into m from public.secrets where user_id = uid and kind = 'smtp' and deleted_at is null;
  if m is not null then
    addr := coalesce(m ->> 'username', '');
    email := jsonb_build_object(
      'connected', true,
      'address_hint', case when position('@' in addr) > 1 then left(addr, 1) || '***' || substr(addr, position('@' in addr)) else '***' end);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', name, 'host', meta ->> 'host',
           'changes', case when meta ->> 'writes' = 'ask' then 'after the person says yes' else 'not allowed' end) order by name), '[]'::jsonb)
    into keys from public.secrets where user_id = uid and kind = 'api' and deleted_at is null;
  return jsonb_build_object('email', email, 'api_keys', keys);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- approvals: an API request that waits for the person's yes
-- ---------------------------------------------------------------------------------------------------------------

-- The request aos will make, exactly: {key, method, path, body, content_type}. The draft text shown to the person is
-- written from this by request_action() below, so what they read is what runs.
alter table approvals add column action jsonb check (action is null or char_length(action::text) <= 8000);

create or replace function guard_approval() returns trigger language plpgsql set search_path = '' as $$
declare
  from_app boolean := (auth.jwt() ->> 'client_id') is not null;
  direct boolean := current_user in ('authenticated', 'anon');
  content_changed boolean;
begin
  if tg_op = 'INSERT' then
    -- an API request can only come in through request_action(), never as a hand-written row
    if direct and (new.action is not null or new.channel = 'api') then
      raise exception 'An API request must be asked with api_request';
    end if;
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
      or new.send_after is distinct from old.send_after
      or new.action is distinct from old.action;

  if content_changed and old.status <> 'pending' then
    raise exception 'Only a pending draft can be edited (approval % is %)', old.id, old.status;
  end if;
  -- Otherwise an app could swap the text between the moment the person reads it and the moment they press yes.
  if content_changed and from_app then
    raise exception 'An assistant cannot change a draft after asking. Ask again with the new text.';
  end if;
  if content_changed and direct and (old.action is not null or new.action is not null or new.channel = 'api') then
    raise exception 'An API request cannot be edited. Reject it and ask again.';
  end if;

  if new.send_claimed_at is distinct from old.send_claimed_at and direct then
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
      if direct and old.action is not null then
        raise exception 'Only aos can run an API request';
      end if;
    else
      raise exception 'An approval cannot go back to pending';
    end if;
  elsif new.decided_at is distinct from old.decided_at then
    new.decided_at := old.decided_at;
  end if;
  return new;
end $$;

-- Ask for a request that changes something. Runs as the caller (person or connected app); the row it writes shows
-- the person the exact request, with the real host taken from their saved key.
create function request_action(p_key text, p_method text, p_path text, p_body text default null, p_content_type text default null)
returns approvals language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  m jsonb;
  ap public.approvals;
  ctype text := coalesce(nullif(p_content_type, ''), 'application/json');
  shown text;
begin
  if uid is null or (auth.jwt() ->> 'role') is distinct from 'authenticated' then
    raise exception 'Sign in first';
  end if;
  select meta into m from public.secrets where user_id = uid and kind = 'api' and name = p_key and deleted_at is null;
  if m is null then
    raise exception 'No API key named "%". The person adds keys on their aos page.', left(p_key, 40);
  end if;
  if m ->> 'writes' <> 'ask' then
    raise exception 'The key "%" is read only. The person can allow changes on their aos page.', p_key;
  end if;
  if p_method not in ('POST', 'PUT', 'PATCH', 'DELETE') then
    raise exception 'method must be POST, PUT, PATCH or DELETE';
  end if;
  if p_path is null or p_path !~ '^/[\x21-\x7e]*$' or char_length(p_path) > 1000 then
    raise exception 'path must start with / and contain no spaces';
  end if;
  if char_length(coalesce(p_body, '')) > 4000 then
    raise exception 'body is too long (4000 characters at most)';
  end if;
  if ctype not in ('application/json', 'application/x-www-form-urlencoded') then
    raise exception 'content_type must be application/json or application/x-www-form-urlencoded';
  end if;
  shown := p_method || ' https://' || (m ->> 'host') || p_path
        || E'\n(with your saved key "' || p_key || '")'
        || case when coalesce(p_body, '') = '' then '' else E'\n\n' || p_body end;
  insert into public.approvals (user_id, channel, recipient, draft, action)
  values (uid, 'api', left(p_method || ' ' || (m ->> 'host') || p_path, 200), shown,
          jsonb_build_object('key', p_key, 'method', p_method, 'path', p_path, 'body', nullif(p_body, ''), 'content_type', ctype))
  returning * into ap;
  return ap;
end $$;

-- Take an approved email or API request for running. One sender gets it; see the vault migration.
create or replace function send_claim(p_user uuid, p_id bigint)
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
  if ap.channel = 'email' then
    select * into sec from public.secrets where user_id = p_user and kind = 'smtp' and deleted_at is null;
    if not found then
      raise exception 'Cannot send draft %: no email connection', p_id;
    end if;
  elsif ap.channel = 'api' and ap.action is not null then
    select * into sec from public.secrets
     where user_id = p_user and kind = 'api' and name = ap.action ->> 'key' and deleted_at is null;
    if not found then
      raise exception 'Cannot send draft %: its saved key was removed', p_id;
    end if;
    if sec.meta ->> 'writes' <> 'ask' then
      raise exception 'Cannot send draft %: its saved key is now read only', p_id;
    end if;
  else
    raise exception 'Cannot send draft %: it is not an email', p_id;
  end if;
  if ap.send_after is not null and ap.send_after > now() then
    raise exception 'Cannot send draft %: it is scheduled for later', p_id;
  end if;
  if ap.send_claimed_at is not null and ap.send_claimed_at > now() - interval '5 minutes' then
    raise exception 'Cannot send draft %: it is already being sent', p_id;
  end if;
  select count(*) into today from public.approvals
   where user_id = p_user and channel = ap.channel and status in ('sent', 'failed') and send_claimed_at > now() - interval '24 hours';
  if ap.channel = 'email' and today >= 50 then
    raise exception 'Cannot send draft %: the limit of 50 emails a day is reached', p_id;
  end if;
  if ap.channel = 'api' and today >= 200 then
    raise exception 'Cannot send draft %: the limit of 200 approved requests a day is reached', p_id;
  end if;
  update public.approvals set send_claimed_at = now() where id = p_id returning * into ap;
  return jsonb_build_object(
    'user_id', p_user,
    'approval', to_jsonb(ap) - 'user_id' - 'deleted_at',
    'meta', sec.meta,
    'ciphertext', sec.ciphertext);
end $$;

-- A saved key for one read request. Server secret key only. At most 30 a minute per person.
create function api_key_read(p_user uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sec public.secrets;
  n integer;
begin
  insert into public.rate_hits (user_id, bucket, window_start, hits)
  values (p_user, 'api', date_trunc('minute', now()), 1)
  on conflict (user_id, bucket, window_start) do update set hits = public.rate_hits.hits + 1
  returning hits into n;
  if n > 30 then
    raise exception 'Too many API requests. Wait a minute.';
  end if;
  select * into sec from public.secrets where user_id = p_user and kind = 'api' and name = p_name and deleted_at is null;
  if not found then
    raise exception 'No API key named "%". The person adds keys on their aos page.', left(p_name, 40);
  end if;
  return jsonb_build_object('meta', sec.meta, 'ciphertext', sec.ciphertext);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- masking
-- ---------------------------------------------------------------------------------------------------------------

-- off: nothing is masked.  api: contact details from connected services are masked (default).
-- all: contact details in the person's own tasks, drafts and log are masked too.
alter table profiles add column mask_level text not null default 'api' check (mask_level in ('off', 'api', 'all'));

create function guard_profile() returns trigger language plpgsql set search_path = '' as $$
begin
  if (auth.jwt() ->> 'client_id') is not null then
    if tg_op = 'INSERT' then
      new.mask_level := 'api';
    elsif new.mask_level is distinct from old.mask_level then
      raise exception 'Only the person can change privacy settings, in the aos app. An assistant cannot.';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_guard before insert or update on profiles for each row execute function guard_profile();

-- The stand-ins. [EMAIL_3] is (kind email, n 3) for one person; it means the same address in every conversation.
create table handles (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id),
  kind text not null check (kind in ('email', 'phone')),
  n integer not null check (n > 0),
  value text not null check (char_length(value) between 3 and 254),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, kind, n),
  unique (user_id, kind, value)
);
alter table handles enable row level security;
revoke all on handles from anon, authenticated;
-- The person can look a stand-in up on the site. A connected app cannot read this table at all.
grant select on handles to authenticated;
create policy handles_select_own on handles for select to authenticated
  using (user_id = (select auth.uid()) and ((select auth.jwt()) ->> 'client_id') is null);

-- Stand-ins for the given values. p_source 'api' = the values came from a connected service; 'own' = from the
-- person's own aos data. New stand-ins are made for 'api' values, and for everything when the person chose "all";
-- otherwise only values that already have one are returned, so a masked value stays masked wherever it shows up.
create function handles_mask(p_user uuid, p_emails text[], p_phones text[], p_source text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  level text;
  have integer;
  e jsonb;
  p jsonb;
begin
  select mask_level into level from public.profiles where user_id = p_user and deleted_at is null;
  level := coalesce(level, 'api');
  if level = 'off' then
    return jsonb_build_object('level', 'off', 'email', '{}'::jsonb, 'phone', '{}'::jsonb);
  end if;
  if level = 'all' or p_source = 'api' then
    perform pg_advisory_xact_lock(hashtextextended(p_user::text, 7));
    select count(*) into have from public.handles where user_id = p_user;
    if have < 20000 then
      insert into public.handles (user_id, kind, n, value)
      select p_user, 'email',
             coalesce((select max(n) from public.handles where user_id = p_user and kind = 'email'), 0) + row_number() over (order by s.v), s.v
        from (select distinct v from unnest(p_emails) v where char_length(v) between 3 and 254 limit 2000) s
       where not exists (select 1 from public.handles h where h.user_id = p_user and h.kind = 'email' and h.value = s.v);
      insert into public.handles (user_id, kind, n, value)
      select p_user, 'phone',
             coalesce((select max(n) from public.handles where user_id = p_user and kind = 'phone'), 0) + row_number() over (order by s.v), s.v
        from (select distinct v from unnest(p_phones) v where char_length(v) between 3 and 254 limit 2000) s
       where not exists (select 1 from public.handles h where h.user_id = p_user and h.kind = 'phone' and h.value = s.v);
    end if;
  end if;
  select coalesce(jsonb_object_agg(value, n), '{}'::jsonb) into e
    from public.handles where user_id = p_user and kind = 'email' and value = any (p_emails);
  select coalesce(jsonb_object_agg(value, n), '{}'::jsonb) into p
    from public.handles where user_id = p_user and kind = 'phone' and value = any (p_phones);
  return jsonb_build_object('level', level, 'email', e, 'phone', p);
end $$;

-- The real values behind stand-ins, for the server to put back just before it stores or sends something.
create function handles_resolve(p_user uuid, p_emails integer[], p_phones integer[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'email', coalesce((select jsonb_object_agg(n::text, value) from public.handles
                        where user_id = p_user and kind = 'email' and n = any (p_emails)), '{}'::jsonb),
    'phone', coalesce((select jsonb_object_agg(n::text, value) from public.handles
                        where user_id = p_user and kind = 'phone' and n = any (p_phones)), '{}'::jsonb));
end $$;

revoke all on function guard_profile() from public, anon;
revoke all on function put_secret(text, jsonb, text, text) from public, anon;
revoke all on function remove_secret(text, text) from public, anon;
revoke all on function request_action(text, text, text, text, text) from public, anon;
grant execute on function put_secret(text, jsonb, text, text) to authenticated;
grant execute on function remove_secret(text, text) to authenticated;
grant execute on function request_action(text, text, text, text, text) to authenticated;

revoke all on function api_key_read(uuid, text) from public, anon, authenticated;
revoke all on function handles_mask(uuid, text[], text[], text) from public, anon, authenticated;
revoke all on function handles_resolve(uuid, integer[], integer[]) from public, anon, authenticated;
grant execute on function api_key_read(uuid, text) to service_role;
grant execute on function handles_mask(uuid, text[], text[], text) to service_role;
grant execute on function handles_resolve(uuid, integer[], integer[]) to service_role;

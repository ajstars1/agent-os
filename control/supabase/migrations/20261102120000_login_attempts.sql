-- Dashboard login brake (app/login/actions.ts): max N failed attempts per IP per window, shared by every
-- server instance. IPs are stored as an HMAC, never in clear. Same rules as init: service role only, RLS on
-- with no policies, soft delete.

create table login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  -- pending: passcode being checked (counts as a failure, so parallel bursts are capped too)
  -- fail / ok: result; locked: refused without checking (does not count, so the lock slides, not grows)
  outcome text not null default 'pending' check (outcome in ('pending', 'fail', 'ok', 'locked')),
  -- set on earlier failures when the IP signs in successfully
  cleared boolean not null default false,
  at timestamptz not null default now(),
  deleted_at timestamptz
);
create index login_attempts_ip_at_idx on login_attempts (ip_hash, at desc) where deleted_at is null;

alter table login_attempts enable row level security;

-- Counts recent failures and records this attempt under a per-IP lock: one round trip, no race.
create function login_attempt_begin(p_ip_hash text, p_window_s int, p_max int)
returns table (attempt_id bigint, locked boolean) language plpgsql set search_path = public as $$
declare
  v_fails int;
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('login:' || p_ip_hash));
  select count(*) into v_fails from login_attempts
    where ip_hash = p_ip_hash
      and outcome in ('pending', 'fail')
      and not cleared
      and deleted_at is null
      and at > now() - make_interval(secs => p_window_s);
  if v_fails >= p_max then
    insert into login_attempts (ip_hash, outcome) values (p_ip_hash, 'locked') returning id into v_id;
    return query select v_id, true;
  else
    insert into login_attempts (ip_hash) values (p_ip_hash) returning id into v_id;
    return query select v_id, false;
  end if;
end $$;

-- Records the result; a success clears that IP's earlier failures.
create function login_attempt_finish(p_attempt_id bigint, p_ok boolean)
returns void language plpgsql set search_path = public as $$
declare
  v_ip text;
begin
  update login_attempts set outcome = case when p_ok then 'ok' else 'fail' end
    where id = p_attempt_id and outcome = 'pending'
    returning ip_hash into v_ip;
  if v_ip is null then raise exception 'login attempt % not pending', p_attempt_id; end if;
  if p_ok then
    update login_attempts set cleared = true
      where ip_hash = v_ip and outcome in ('pending', 'fail') and not cleared and id <> p_attempt_id;
  end if;
end $$;

revoke execute on function login_attempt_begin(text, int, int) from public, anon, authenticated;
revoke execute on function login_attempt_finish(bigint, boolean) from public, anon, authenticated;
grant execute on function login_attempt_begin(text, int, int) to service_role;
grant execute on function login_attempt_finish(bigint, boolean) to service_role;

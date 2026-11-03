-- aos v2 Phase 0: a run skipped by the health preflight (no spawn, no tokens) is recorded as 'skipped'.
alter table runs drop constraint if exists runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('running', 'ok', 'error', 'timeout', 'unverified', 'blocked', 'skipped'));

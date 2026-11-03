-- aos v2 Phase 0: a run that exits 0 without task_done or an AOS_RESULT line is 'unverified', not 'ok';
-- a run that ended blocked (login, CAPTCHA, missing input) is 'blocked'.
alter table runs drop constraint if exists runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('running', 'ok', 'error', 'timeout', 'unverified', 'blocked'));

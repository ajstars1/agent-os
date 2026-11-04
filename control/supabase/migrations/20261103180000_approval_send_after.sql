-- Scheduled sends: an approval can carry the earliest time it may go out (a post slot, an email day).
-- Approving it creates the SEND task due at send_after instead of now, and the runner re-checks it right
-- before a send, so an approved draft never goes out early. Null means "send as soon as approved".
alter table approvals add column send_after timestamptz;
create index approvals_send_after_idx on approvals (send_after) where send_after is not null;

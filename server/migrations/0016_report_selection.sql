-- A report schedule's log selection (shared/src/logselect.ts): a default
-- rule and rules per host, stack or container; null: errors and warnings
-- since the last report, of everything.
ALTER TABLE report_schedules ADD COLUMN selection TEXT;

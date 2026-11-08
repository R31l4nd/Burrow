-- When a schedule's run was claimed (its minute came): a run claimed but
-- never made, because Burrow stopped while it waited or ran, is made after
-- the restart instead of being lost.
ALTER TABLE report_schedules ADD COLUMN claimed_at INTEGER;

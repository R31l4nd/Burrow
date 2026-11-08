-- A report schedule's own choices: to which channels (null: every channel
-- for reports), only when something needs a look, with or without the AI's
-- explanations, and from how many errors or warnings a container needs one.
ALTER TABLE report_schedules ADD COLUMN channel_ids TEXT;
ALTER TABLE report_schedules ADD COLUMN only_attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_schedules ADD COLUMN ai INTEGER NOT NULL DEFAULT 1;
ALTER TABLE report_schedules ADD COLUMN errors_attention INTEGER NOT NULL DEFAULT 10;
ALTER TABLE report_schedules ADD COLUMN warnings_attention INTEGER NOT NULL DEFAULT 100;

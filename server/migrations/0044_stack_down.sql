-- A stack brought down from Burrow has no containers left to read it from
-- (review 2026-10-24: it could not be brought up again from Burrow). Its
-- folder and compose files are kept when it goes down, and down_at says
-- since when; cleared once it has containers again.
ALTER TABLE stacks ADD COLUMN working_dir TEXT;
ALTER TABLE stacks ADD COLUMN config_files TEXT;
ALTER TABLE stacks ADD COLUMN down_at INTEGER;

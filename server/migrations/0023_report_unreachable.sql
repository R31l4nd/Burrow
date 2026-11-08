-- Hosts a report could not read: named in it (and it is then a problem),
-- never left out (the report said all was fine).
ALTER TABLE reports ADD COLUMN unreachable TEXT;

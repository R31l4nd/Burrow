-- A question about a file (report 76bcda) is kept as an analysis of its own
-- kind: the logs analyses (the Reports page, a container's list) leave it out,
-- and a question asked further on it gets the file's prompt.
ALTER TABLE analyses ADD COLUMN kind TEXT NOT NULL DEFAULT 'logs';

-- Questions asked further on an analysis (report 0a86b2): each one is an
-- analysis of its own under the one it asks about (parent_id), with the
-- question as sent (masked). The first analysis keeps what was sent to the
-- model (prompt, masked), so a question goes with the logs and the answers
-- before it. Analyses from before this keep no prompt and cannot be asked.
ALTER TABLE analyses ADD COLUMN prompt TEXT;
ALTER TABLE analyses ADD COLUMN parent_id INTEGER REFERENCES analyses(id) ON DELETE CASCADE;
ALTER TABLE analyses ADD COLUMN ask TEXT;
CREATE INDEX analyses_parent ON analyses (parent_id);

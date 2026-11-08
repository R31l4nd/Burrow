-- What the model used for a report's explanations (report 18efc8: shown on
-- the report as it is on an analysis). Null: no model, or none counted.
ALTER TABLE reports ADD COLUMN tokens_in INTEGER;
ALTER TABLE reports ADD COLUMN tokens_out INTEGER;

-- What the models used (tokens as the provider counted them), per call:
-- for the usage and estimated cost in Settings -> AI, and per analysis.
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);
CREATE INDEX ai_usage_at ON ai_usage(at);
ALTER TABLE analyses ADD COLUMN tokens_in INTEGER;
ALTER TABLE analyses ADD COLUMN tokens_out INTEGER;

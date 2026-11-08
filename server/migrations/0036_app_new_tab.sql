-- An app opened in a tab of its own on purpose, even when it may be framed
-- (report c2fde7).
ALTER TABLE apps ADD COLUMN new_tab INTEGER NOT NULL DEFAULT 0;

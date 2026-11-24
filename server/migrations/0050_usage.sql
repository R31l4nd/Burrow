-- How often each page and dialog was opened, per day, by name only
-- (Settings -> Usage): which parts of Burrow are used and which are not.
CREATE TABLE usage_counts (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);

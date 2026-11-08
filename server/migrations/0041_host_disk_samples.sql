-- Each whole disk's I/O counters with every host sample (report d4a9c0:
-- which disk is busy, and when). The counters as /proc/diskstats has them
-- and the host's uptime, so the rates over each five minutes are worked
-- out when read (a reboot in between is seen: the uptime went back).
-- Kept as long as the other samples (a month).
CREATE TABLE host_disk_samples (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  disk TEXT NOT NULL,
  uptime REAL NOT NULL,
  rd_ios INTEGER NOT NULL,
  rd_sectors INTEGER NOT NULL,
  wr_ios INTEGER NOT NULL,
  wr_sectors INTEGER NOT NULL,
  io_ms INTEGER NOT NULL
);
CREATE INDEX host_disk_samples_host_at ON host_disk_samples (host_id, at);

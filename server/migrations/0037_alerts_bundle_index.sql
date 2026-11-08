-- Each alert looks for one of the last ten minutes to add to, by host,
-- container and time: without an index that read the whole table (90 days
-- of alerts) for every matching log line; 2.8 ms at 50,000 alerts, 0.006 ms
-- with it (#149).
CREATE INDEX alerts_bundle ON alerts (host_id, container, updated_at);

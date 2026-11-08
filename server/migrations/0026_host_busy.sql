-- Host health also covers a busy host: the CPU high over a whole sample
-- interval, or memory nearly full in two samples in a row. Only the
-- built-in rule as shipped; one someone changed stays as it is.
UPDATE alert_rules SET events = '["disk_full","smart","hot","busy"]'
WHERE builtin = 1 AND name = 'Host health' AND events = '["disk_full","smart","hot"]';

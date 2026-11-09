-- A host that stops answering: told once when two samples of its statistics
-- in a row fail (five minutes apart), and once when it answers again. A rule
-- of its own, built in and on, so a host that is off on purpose (woken with
-- Wake-on-LAN when needed) can be left out by switching just this one off.
INSERT INTO alert_rules (name, kind, events, enabled, builtin, created_at)
VALUES ('Host unreachable', 'event', '["unreachable"]', 1, 1, 0);

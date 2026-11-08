-- Which of the phone's keys a host carries (AUDIT2 MON-04): a key the phone
-- reports again after a host could not take it is put on there then. Null:
-- installed before this was kept; put on again once, which changes nothing.
ALTER TABLE device_hosts ADD COLUMN installed_key TEXT;

-- Phase 5: the Android app's direct SSH route. A paired phone has its own
-- SSH key (made in its Keystore); the hosts it may reach directly carry that
-- public key in authorized_keys, installed and removed by Burrow.
ALTER TABLE devices ADD COLUMN ssh_public_key TEXT;
CREATE TABLE device_hosts (
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, host_id)
);

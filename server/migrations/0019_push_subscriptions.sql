-- Devices that get Burrow's own push messages: a browser (Web Push) or the
-- Android app (UnifiedPush). Where to send (the push service's address) and
-- the device's public key and secret to encrypt for (RFC 8291).
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE UNIQUE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);

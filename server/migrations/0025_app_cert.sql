-- When an app's TLS certificate runs out, and which warning was sent for it.
ALTER TABLE apps ADD COLUMN cert_expires_at INTEGER;
ALTER TABLE apps ADD COLUMN cert_checked_at INTEGER;
ALTER TABLE apps ADD COLUMN cert_warned TEXT;

-- A newer version under another tag (nginx:1.25 -> 1.27), found by the update check.
ALTER TABLE image_checks ADD COLUMN newer_tag TEXT;

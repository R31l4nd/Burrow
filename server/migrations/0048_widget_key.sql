-- The widget's own key per paired phone: it reads the widget's counts and
-- nothing else, from the background, without the fingerprint the sign-in
-- key needs for every signature.
ALTER TABLE devices ADD COLUMN widget_key TEXT;

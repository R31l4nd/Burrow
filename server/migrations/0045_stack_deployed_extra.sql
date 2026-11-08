-- With the compose file as last deployed from its review, the stack's other
-- compose files and its .env as they were then (a JSON object, path ->
-- content): a deploy that does not run well puts all of them back for the
-- moment of up, not only the one file (review 2026-10-24).
ALTER TABLE stacks ADD COLUMN deployed_extra TEXT;

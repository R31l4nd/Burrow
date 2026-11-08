-- More folders in one workspace (same host), besides its root: a JSON array of paths.
ALTER TABLE workspaces ADD COLUMN folders TEXT;

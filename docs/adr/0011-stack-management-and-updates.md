# 11. Stack management and image updates

Date: 2026-09-27 - Status: accepted

## Context

For 0.9.0: change containers and stacks from Burrow (exec shell, compose edit,
diff, deploy), see which images are outdated and, opt-in, update stacks
automatically with a rollback when the new image misbehaves.

## Decision

- **Writes go over SSH with the docker CLI**, like reads (ADR 9), behind a
  fresh step-up and the audit log. Burrow never gets the Docker socket.
- **Compose operations run detached on the host** and write a log file that
  Burrow follows. A phone losing its connection, or Burrow recreating its
  own container, does not stop an operation halfway.
- **Update checks from Burrow with HEAD requests** to the registries
 : no pull, not counted by Docker Hub's rate limit, one
  request per tag across hosts, stop per registry on HTTP 429. Anonymous
  only: private images show as unknown and can be excluded.
- **Rollback by re-tagging**: before an update Burrow records each updated
  container's image id; on trouble it tags those ids with the image names
  again and runs `docker compose up -d --pull never` for those services.
  Watched for a minute (restarts, exits, health; a starting healthcheck gets
  three more minutes). It restores images, not data: a migration the new
  version ran on its volume stays (docs/USAGE.md says so).
- **One maintenance window**, opt-in per stack. Burrow's own
  stack is excluded from automatic updates (found through
  `/proc/self/mountinfo`), since the watcher would stop with it.
- **Reporting inside the app** until 0.11.0: history per stack, a count on
  the Containers tab, audit lines.
- **Release notes**: GitHub releases of the image's
  `org.opencontainers.image.source`, after `org.opencontainers.image.version`;
  shown as text, cached for an hour.

## Consequences

- Burrow's view of a registry must match the host's; `REGISTRY_ENDPOINTS`
  maps a name (such as the host's `localhost:5000`) to an address Burrow can
  reach.
- Two hosts pointing at the same Docker each report its updates.
- An operation started before a Burrow restart continues on the host, but
  its output in the app ends there.

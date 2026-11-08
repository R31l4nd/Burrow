# 9. Containers and logs over SSH, with the docker CLI's JSON

Date: 2026-09-27 - Status: accepted

## Context

For 0.7.0: a Dozzle-like view of every host's containers and logs, including
one stack spread over several hosts in one timeline, with live CPU and
memory. Burrow already reaches every host over SSH.

## Decision

- **The docker CLI over SSH**, for every host including the one Burrow runs
  on (added as an ordinary host). No Docker API port, no agent, and 0.9.0
  (managing containers) works the same way.
- **One command per poll per host**: `docker inspect` of all containers with
  a template that prints whole objects (`.State`, `.Config.Labels`) as JSON,
  then one `docker stats --no-stream` sample. Whole objects because Docker 29
  fails on a missing field (`.State.Health` without a healthcheck) where older
  versions have structs; JSON of the whole object works on both. (Amended
  in 2.1.0: the stats sample comes every third poll, every 15 s; a page gets
  a host's whole snapshot once, then only what changed.)
- **Polled only while someone looks**: a host is polled every 5 s while a
  page watches it and stops 30 s after the last one leaves. An hour of CPU
  and memory is kept per container (five minutes at first) so a new page
  shows filled sparklines.
- **Logs are streamed, merged in the page**: `docker logs -t` per container,
  lines with Docker's nanosecond timestamps, stdout and stderr apart.
  (Amended: at first one SSH connection per 8 containers; now one SSH
  channel per host carries all its sources, up to 100, through a small
  script that prefixes each line with its source, log files and journals
  among them.) The page inserts each line by timestamp, so any mix of containers
  and hosts is one timeline. Levels are recognised in the page (JSON
  `level`/`severity`, pino numbers, `level=`, tags like `ERROR` or `[warn]`).

## Consequences

- Stats need about two seconds per sample on the host; five seconds is the
  shortest useful interval.
- Access to a host's docker CLI is root on that host; the pages are
  admin-only until roles come (0.12.0).
- Tests read real Docker output: the integration and e2e suites run a test
  sshd with the real CLI next to the stand-in hosts. It reaches the test
  machine's Docker through a filter that shows the tests their own
  containers only and lets them act on those alone (docs/DEV.md).

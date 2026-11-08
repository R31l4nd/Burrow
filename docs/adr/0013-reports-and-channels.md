# 13. Scheduled reports and notification channels

Date: 2026-09-27 - Status: accepted

## Context

For 0.11.0: a periodic report on all containers (what went wrong, what to do,
what changed since last time), and one way to reach the owner - push,
e-mail, Discord, or anything with a webhook - for reports, alerts and image
updates alike.

## Decision

- **Channels** are rows with a kind, the kinds of message they get (alerts,
  reports, image updates) and a language; their secrets
  (ntfy token, SMTP password, Discord webhook address, webhook signing
  secret) are sealed and never sent back. One `Notifier` sends a notice
  (title, body, a page of Burrow, priority, optional Dutch text and data)
  to every channel that wants it; a failing channel is logged and does not
  stop the others. E-mail through nodemailer; webhooks are signed with
  HMAC-SHA256 when a secret is set. The 0.10.0 ntfy setting became a
  channel for alerts.
- **The status is Burrow's, not the model's**: per container over the
  period - crashes, OOM kills and unhealthy spells from the alerts, the
  state and health now, restarts since the previous report, error and
  warning lines in the last 5000 log lines - decide ok, attention or
  problem. The kinds of error (grouped templates) are compared with the
  previous report: new, recurring, resolved.
- **The model only explains** the containers that need a look (user's
  choice), at most twenty, problems first, with masked and grouped logs;
  without a model the report is complete, just without explanations.
- **Schedules**: weekly (day and time), daily or a cron expression, in the
  schedule's time zone, checked every minute and run once per due minute.
  A weekly report for everything exists from the start, off until switched
  on.

## Consequences

- A report reads each container's logs over SSH: with many containers a
  run takes a minute or so; one report runs at a time.
- Counts come from at most the last 5000 lines per container; the report
  says when it read only part.

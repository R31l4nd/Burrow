# 12. Log alerts and AI log analysis

Date: 2026-09-27 - Status: accepted

## Context

For 0.10.0: know when a container crashes without watching, get that on the
phone, and ask a language model what went wrong - without sending secrets
out of the house.

## Decision

- **Alerts come from Docker itself**: one `docker events` stream per Docker
  host (over the pooled SSH connection), for exits, OOM kills, health and
  kills. An exit right after a `kill` is someone stopping the container, not
  a crash; three exits in five minutes are a restart loop. A built-in rule
  covers every container; it can be switched off or
  narrowed, not deleted.
- **Log rules follow only what they need**: only the running containers a
  pattern or rate rule covers are followed. (Amended: at first one
  `docker logs -f` each, at most eight per host; now one stream per host
  for its containers, log files and journals, up to 60 containers and 20
  files, and the Alerts page says how many a rule sees.)
- **Bundled and mutable**: a rule firing again for the same container within
  ten minutes adds to the count of the open alert and pushes nothing new.
  Containers can be muted for a while or until unmuted.
- **Push through ntfy**: Burrow posts to a topic on ntfy.sh
  or an own server; the ntfy app shows it. A tap opens the logs of that
  moment - through a `burrow://open?to=/logs...` link in the Android app, or
  the page in a browser - and a second action opens the analysis, which
  asks before it sends anything (amended: links never act by themselves).
  The detail is the container's last lines, masked.
- **Analysis on demand**, streamed as text in four fixed sections, through
  the provider chosen in Settings (your own Ollama recommended; none until
  one is set), or Claude as a
  "deeper analysis" when a key is set. Before anything is sent, lines are
  grouped into templates with counts (Drain-like), errors first, cut to a
  budget, and secrets (passwords, tokens, keys, JWTs, e-mail addresses,
  credentials in URLs) are masked; IP addresses too unless the admin says
  the model's server runs on their own network (amended in 2.2.0: before,
  judged from the server's name). The container's state goes along.

## Consequences

- An alert raised while Burrow is down is missed; the next crash is seen.
- On ntfy.sh anyone who knows the topic can read it: Burrow proposes a long
  random topic and supports access tokens and own servers.
- Analysis quality depends on the model; the answer says which model wrote
  it and asks to check before acting.

# Architecture decision records

Each record says what was decided, why, and what it costs. They were written
when the decision was made and are amended in place when it changes (the
amendment says so).

A version named in a record is the release the decision came with
(CHANGELOG.md has each).

| Record | Decision |
| --- | --- |
| [0001](0001-typescript-node-single-container.md) | TypeScript on Node in a single container |
| [0002](0002-authentication.md) | Built-in, mandatory authentication |
| [0003](0003-trust-on-first-use.md) | Trust on first use for host keys |
| [0004](0004-server-owned-terminals.md) | Server-owned terminals, tmux on a private server |
| [0005](0005-llm-providers.md) | LLM providers: local first, Claude optional |
| [0006](0006-files-and-language-servers.md) | Files over SFTP, language servers in the container |
| [0007](0007-android-app.md) | The Android app: a WebView shell with its own sign-in key |
| [0008](0008-direct-route.md) | The direct route: the phone's own SSH, with Burrow's terminal UI |
| [0009](0009-containers-and-logs.md) | Containers and logs over SSH, with the docker CLI's JSON |
| [0010](0010-workspaces.md) | Workspaces: the host's own tools, the editor we have |
| [0011](0011-stack-management-and-updates.md) | Stack management and image updates |
| [0012](0012-alerts-and-analysis.md) | Log alerts and AI log analysis |
| [0013](0013-reports-and-channels.md) | Scheduled reports and notification channels |
| [0014](0014-users-sso-host-stats.md) | More users, single sign-on, host statistics |
| [0015](0015-operator-file-access.md) | Which files an operator may open |

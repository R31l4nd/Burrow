import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Mirrors migrations/*.sql. The SQL files are the source of truth for the
// database; this file only gives the queries their types.

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username').notNull(),
  role: text('role', { enum: ['admin', 'operator'] }).notNull(),
  passwordHash: text('password_hash'),
  totpSecretEnc: text('totp_secret_enc'),
  totpConfirmed: integer('totp_confirmed', { mode: 'boolean' }).notNull(),
  totpLastStep: integer('totp_last_step'),
  incomplete: integer('incomplete', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
  oidcSub: text('oidc_sub'),
  oidcIss: text('oidc_iss'),
  email: text('email'),
});

export const passkeys = sqliteTable('passkeys', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  credentialId: text('credential_id').notNull(),
  publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
  counter: integer('counter').notNull(),
  transports: text('transports'),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
});

export const recoveryCodes = sqliteTable('recovery_codes', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
  usedAt: integer('used_at'),
});

export const sessions = sqliteTable('sessions', {
  idHash: text('id_hash').primaryKey(),
  publicId: text('public_id').notNull(),
  userId: integer('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  stepUpAt: integer('step_up_at'),
  userAgent: text('user_agent'),
  ip: text('ip'),
  deviceId: integer('device_id'),
});

export const authThrottle = sqliteTable('auth_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  firstAt: integer('first_at').notNull(),
  blockedUntil: integer('blocked_until'),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey(),
  at: integer('at').notNull(),
  userId: integer('user_id'),
  username: text('username'),
  ip: text('ip'),
  action: text('action').notNull(),
  target: text('target'),
  details: text('details'),
});

export const sshKeys = sqliteTable('ssh_keys', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  publicKey: text('public_key').notNull(),
  fingerprint: text('fingerprint').notNull(),
  privateKeyEnc: text('private_key_enc').notNull(),
  passphraseEnc: text('passphrase_enc'),
  createdAt: integer('created_at').notNull(),
});

export const hostGroups = sqliteTable('host_groups', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  parentId: integer('parent_id'),
  defaults: text('defaults').notNull(),
  sort: integer('sort').notNull(),
});

export const hosts = sqliteTable('hosts', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  groupId: integer('group_id'),
  port: integer('port'),
  username: text('username'),
  authMethod: text('auth_method', { enum: ['key', 'password'] }),
  keyId: integer('key_id'),
  passwordEnc: text('password_enc'),
  startupCommand: text('startup_command'),
  tmux: text('tmux', { enum: ['auto', 'always', 'never'] }),
  term: text('term'),
  encoding: text('encoding'),
  color: text('color'),
  icon: text('icon'),
  favorite: integer('favorite', { mode: 'boolean' }).notNull(),
  sort: integer('sort').notNull(),
  lastUsedAt: integer('last_used_at'),
  facts: text('facts'),
  wakeMac: text('wake_mac'),
  wakeVia: text('wake_via'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const hostTags = sqliteTable(
  'host_tags',
  {
    hostId: integer('host_id').notNull(),
    tag: text('tag').notNull(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.tag] })],
);

export const knownHosts = sqliteTable('known_hosts', {
  id: integer('id').primaryKey(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  keyType: text('key_type').notNull(),
  keyB64: text('key_b64').notNull(),
  fingerprint: text('fingerprint').notNull(),
  addedAt: integer('added_at').notNull(),
});

export const terminalSessions = sqliteTable('terminal_sessions', {
  id: text('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  userId: integer('user_id').notNull(),
  mode: text('mode', { enum: ['tmux', 'memory'] }).notNull(),
  tmuxName: text('tmux_name'),
  title: text('title'),
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  sharedWith: text('shared_with').notNull().default('[]'),
  recording: integer('recording', { mode: 'boolean' }).notNull().default(false),
});

export const recordings = sqliteTable('recordings', {
  id: integer('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  hostName: text('host_name').notNull(),
  title: text('title'),
  userId: integer('user_id'),
  file: text('file').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  bytes: integer('bytes').notNull().default(0),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
});

export const snippets = sqliteTable('snippets', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  command: text('command').notNull(),
  description: text('description'),
  hostId: integer('host_id'),
  groupId: integer('group_id'),
  sort: integer('sort').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const commandHistory = sqliteTable('command_history', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  hash: text('hash').notNull(),
  commandEnc: text('command_enc').notNull(),
  count: integer('count').notNull(),
  firstAt: integer('first_at').notNull(),
  lastAt: integer('last_at').notNull(),
});

export const commandPairs = sqliteTable('command_pairs', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  prevHash: text('prev_hash').notNull(),
  nextHash: text('next_hash').notNull(),
  count: integer('count').notNull(),
  lastAt: integer('last_at').notNull(),
});

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  kind: text('kind', { enum: ['webpush', 'unifiedpush'] }).notNull(),
  label: text('label').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  lang: text('lang', { enum: ['en', 'nl'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  lastOkAt: integer('last_ok_at'),
  /** The Android app's widget gets its data by push on this device. */
  widget: integer('widget', { mode: 'boolean' }).notNull().default(false),
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const fileBookmarks = sqliteTable('file_bookmarks', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey(),
  userId: integer('user_id').notNull(),
  name: text('name').notNull(),
  publicKey: text('public_key').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  // The phone's own SSH key for the direct route (OpenSSH line), if any.
  sshPublicKey: text('ssh_public_key'),
  // The widget's own key (SPKI): reads the widget's counts only, without a fingerprint.
  widgetKey: text('widget_key'),
});

export const deviceHosts = sqliteTable(
  'device_hosts',
  {
    deviceId: integer('device_id').notNull(),
    hostId: integer('host_id').notNull(),
    installedAt: integer('installed_at').notNull(),
    installedKey: text('installed_key'),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.hostId] })],
);

export const apps = sqliteTable('apps', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  grp: text('grp'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull(),
  sort: integer('sort').notNull(),
  embeddable: text('embeddable', { enum: ['yes', 'no', 'unknown'] }).notNull(),
  icon: blob('icon', { mode: 'buffer' }),
  iconType: text('icon_type'),
  hostId: integer('host_id'),
  container: text('container'),
  createdAt: integer('created_at').notNull(),
  monitor: integer('monitor', { mode: 'boolean' }).notNull().default(true),
  up: integer('up', { mode: 'boolean' }),
  checkedAt: integer('checked_at'),
  latencyMs: integer('latency_ms'),
  downSince: integer('down_since'),
  certExpiresAt: integer('cert_expires_at'),
  certCheckedAt: integer('cert_checked_at'),
  certWarned: text('cert_warned'),
  newTab: integer('new_tab', { mode: 'boolean' }).notNull().default(false),
});

export const appChecks = sqliteTable('app_checks', {
  appId: integer('app_id').notNull(),
  at: integer('at').notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  ms: integer('ms'),
});

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  root: text('root').notNull(),
  name: text('name').notNull(),
  gitName: text('git_name'),
  gitEmail: text('git_email'),
  createdAt: integer('created_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
  /** JSON array of more folders on the same host, besides root. */
  folders: text('folders'),
});

export const stacks = sqliteTable(
  'stacks',
  {
    hostId: integer('host_id').notNull(),
    project: text('project').notNull(),
    autoUpdate: integer('auto_update', { mode: 'boolean' }).notNull().default(false),
    deployedFile: text('deployed_file'),
    deployedContent: text('deployed_content'),
    deployedAt: integer('deployed_at'),
    // The other compose files and the .env as deployed then: JSON, path -> content.
    deployedExtra: text('deployed_extra'),
    // Brought down from Burrow: where its files are (JSON list), and since when.
    workingDir: text('working_dir'),
    configFiles: text('config_files'),
    downAt: integer('down_at'),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.project] })],
);

export const imageChecks = sqliteTable(
  'image_checks',
  {
    hostId: integer('host_id').notNull(),
    image: text('image').notNull(),
    status: text('status', { enum: ['current', 'update', 'pinned', 'local', 'unknown'] }).notNull(),
    localDigest: text('local_digest'),
    remoteDigest: text('remote_digest'),
    error: text('error'),
    source: text('source'),
    version: text('version'),
    newerTag: text('newer_tag'),
    checkedAt: integer('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.image] })],
);

export const stackUpdates = sqliteTable('stack_updates', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  project: text('project').notNull(),
  auto: integer('auto', { mode: 'boolean' }).notNull(),
  result: text('result', { enum: ['updated', 'rolled_back', 'failed', 'unchanged'] }).notNull(),
  images: text('images').notNull(),
  detail: text('detail'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at').notNull(),
});

export const alertRules = sqliteTable('alert_rules', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['event', 'pattern', 'rate'] }).notNull(),
  hostId: integer('host_id'),
  container: text('container'),
  project: text('project'),
  events: text('events').notNull(),
  pattern: text('pattern'),
  threshold: integer('threshold'),
  windowMinutes: integer('window_minutes'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at').notNull(),
});

export const alerts = sqliteTable('alerts', {
  id: integer('id').primaryKey(),
  ruleId: integer('rule_id'),
  ruleName: text('rule_name').notNull(),
  hostId: integer('host_id').notNull(),
  container: text('container').notNull(),
  title: text('title').notNull(),
  detail: text('detail'),
  at: text('at').notNull(),
  count: integer('count').notNull(),
  read: integer('read', { mode: 'boolean' }).notNull(),
  pushed: text('pushed', { enum: ['yes', 'no', 'failed', 'muted'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// The folders an operator may open on a host (A3-SRV-01): JSON arrays of absolute folders.
export const fileAccess = sqliteTable(
  'file_access',
  {
    userId: integer('user_id').notNull(),
    hostId: integer('host_id').notNull(),
    allow: text('allow').notNull().default('[]'),
    deny: text('deny').notNull().default('[]'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hostId] })],
);

// Read up to read_at, per person (A3-SRV-11); alerts.read is no longer used.
export const alertReads = sqliteTable('alert_reads', {
  userId: integer('user_id').primaryKey(),
  readAt: integer('read_at').notNull(),
});

export const alertCounts = sqliteTable(
  'alert_counts',
  {
    alertId: integer('alert_id').notNull(),
    minute: integer('minute').notNull(),
    n: integer('n').notNull(),
  },
  (t) => [primaryKey({ columns: [t.alertId, t.minute] })],
);

export const alertMutes = sqliteTable(
  'alert_mutes',
  {
    hostId: integer('host_id').notNull(),
    container: text('container').notNull(),
    until: integer('until'),
  },
  (t) => [primaryKey({ columns: [t.hostId, t.container] })],
);

export const channels = sqliteTable('channels', {
  id: integer('id').primaryKey(),
  kind: text('kind', { enum: ['ntfy', 'email', 'discord', 'webhook', 'push'] }).notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  topics: text('topics').notNull(),
  lang: text('lang', { enum: ['en', 'nl'] }).notNull(),
  config: text('config').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const reportSchedules = sqliteTable('report_schedules', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  kind: text('kind', { enum: ['weekly', 'daily', 'cron'] }).notNull(),
  day: integer('day').notNull(),
  time: text('time').notNull(),
  cron: text('cron'),
  timeZone: text('time_zone').notNull(),
  hostIds: text('host_ids'),
  containers: text('containers'),
  channelIds: text('channel_ids'),
  selection: text('selection'),
  onlyAttention: integer('only_attention', { mode: 'boolean' }).notNull().default(false),
  ai: integer('ai', { mode: 'boolean' }).notNull().default(true),
  errorsAttention: integer('errors_attention').notNull().default(10),
  warningsAttention: integer('warnings_attention').notNull().default(100),
  lastRunAt: integer('last_run_at'),
  lastRunKey: text('last_run_key'),
  claimedAt: integer('claimed_at'),
  createdAt: integer('created_at').notNull(),
});

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey(),
  scheduleId: integer('schedule_id'),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  periodFrom: integer('period_from').notNull(),
  periodTo: integer('period_to').notNull(),
  status: text('status', { enum: ['ok', 'attention', 'problem'] }).notNull(),
  counts: text('counts').notNull(),
  summary: text('summary').notNull(),
  containers: text('containers').notNull(),
  model: text('model'),
  unreachable: text('unreachable'),
  updates: text('updates'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
});

export const invites = sqliteTable('invites', {
  id: integer('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator'] }).notNull(),
  createdBy: integer('created_by'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  usedBy: integer('used_by'),
});

export const hostSamples = sqliteTable('host_samples', {
  hostId: integer('host_id').notNull(),
  at: integer('at').notNull(),
  cpu: real('cpu').notNull(),
  memPercent: real('mem_percent').notNull(),
  load1: real('load1').notNull(),
  diskPercent: real('disk_percent').notNull(),
  maxCelsius: real('max_celsius'),
});

export const hostDiskSamples = sqliteTable('host_disk_samples', {
  hostId: integer('host_id').notNull(),
  at: integer('at').notNull(),
  disk: text('disk').notNull(),
  uptime: real('uptime').notNull(),
  rdIos: integer('rd_ios').notNull(),
  rdSectors: integer('rd_sectors').notNull(),
  wrIos: integer('wr_ios').notNull(),
  wrSectors: integer('wr_sectors').notNull(),
  ioMs: integer('io_ms').notNull(),
});

export const logEvents = sqliteTable('log_events', {
  kind: text('kind').primaryKey(),
  level: integer('level').notNull(),
  count: integer('count').notNull(),
  firstAt: integer('first_at').notNull(),
  lastAt: integer('last_at').notNull(),
  example: text('example').notNull(),
});

export const containerSamples = sqliteTable('container_samples', {
  hostId: integer('host_id').notNull(),
  name: text('name').notNull(),
  at: integer('at').notNull(),
  cpu: real('cpu').notNull(),
  memBytes: integer('mem_bytes').notNull(),
});

export const hostSmart = sqliteTable('host_smart', {
  hostId: integer('host_id').primaryKey(),
  checkedAt: integer('checked_at').notNull(),
  report: text('report').notNull(),
});

export const commandSchedules = sqliteTable('command_schedules', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  command: text('command').notNull(),
  hostIds: text('host_ids').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  kind: text('kind', { enum: ['weekly', 'daily', 'cron'] }).notNull(),
  day: integer('day').notNull(),
  time: text('time').notNull(),
  cron: text('cron'),
  timeZone: text('time_zone').notNull(),
  timeoutMinutes: integer('timeout_minutes').notNull(),
  lastRunAt: integer('last_run_at'),
  lastRunKey: text('last_run_key'),
  createdBy: integer('created_by'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const commandRuns = sqliteTable('command_runs', {
  id: integer('id').primaryKey(),
  scheduleId: integer('schedule_id').notNull(),
  hostId: integer('host_id').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  code: integer('code'),
  timedOut: integer('timed_out', { mode: 'boolean' }).notNull().default(false),
  output: text('output').notNull().default(''),
  cut: integer('cut', { mode: 'boolean' }).notNull().default(false),
  error: text('error'),
});

export const hostPackages = sqliteTable('host_packages', {
  hostId: integer('host_id').primaryKey(),
  checkedAt: integer('checked_at').notNull(),
  report: text('report').notNull(),
});

export const hostSmartHistory = sqliteTable('host_smart_history', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  checkedAt: integer('checked_at').notNull(),
  report: text('report').notNull(),
});

export const analyses = sqliteTable('analyses', {
  id: integer('id').primaryKey(),
  userId: integer('user_id'),
  targets: text('targets').notNull(),
  lines: integer('lines').notNull(),
  provider: text('provider').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  text: text('text').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  finishedAt: integer('finished_at'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  /** What went to the model (masked), for questions asked further; null on a question and on analyses from before. */
  prompt: text('prompt'),
  /** A question asked further: the analysis it asks about. */
  parentId: integer('parent_id'),
  /** The question, as sent (masked): asked further, or about a file. */
  ask: text('ask'),
  /** Of logs, or a question about a file (report 76bcda). */
  kind: text('kind', { enum: ['logs', 'file'] }).notNull().default('logs'),
});

export const aiUsage = sqliteTable('ai_usage', {
  id: integer('id').primaryKey(),
  at: integer('at').notNull(),
  kind: text('kind', { enum: ['analysis', 'report', 'command', 'filter'] }).notNull(),
  provider: text('provider').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
});

export const logFiles = sqliteTable('log_files', {
  id: integer('id').primaryKey(),
  hostId: integer('host_id').notNull(),
  /** '' for a file on the host itself. */
  container: text('container').notNull(),
  path: text('path').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const uploads = sqliteTable('uploads', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  hostId: integer('host_id').notNull(),
  dir: text('dir').notNull(),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  tmp: text('tmp').notNull(),
  overwrite: integer('overwrite', { mode: 'boolean' }).notNull(),
  touched: integer('touched').notNull(),
});

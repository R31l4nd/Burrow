// What the Android app's widget shows (2.11.0): counts only, nothing a
// locked phone should not show (no host names, no alert words).

export interface WidgetSummary {
  /** When Burrow made it. */
  at: string;
  hosts: { total: number; up: number; down: number };
  /** Alerts this person has not seen yet. */
  alerts: number;
  /** Hosts with package updates waiting, and how many security updates in all. */
  updates: { hosts: number; security: number };
  /** Each host on a line of its own (2.13.0, report 05a818): down first, then not known yet, then up; by name. */
  list: WidgetHost[];
}

export interface WidgetHost {
  id: number;
  name: string;
  state: 'up' | 'down' | 'unknown';
  /** Package updates waiting, and how many of them are security updates. */
  updates: number;
  security: number;
}

/** The same numbers: nothing to send again. */
export const sameWidget = (a: WidgetSummary | null, b: WidgetSummary): boolean =>
  !!a &&
  a.hosts.total === b.hosts.total &&
  a.hosts.up === b.hosts.up &&
  a.hosts.down === b.hosts.down &&
  a.alerts === b.alerts &&
  a.updates.hosts === b.updates.hosts &&
  a.updates.security === b.updates.security &&
  JSON.stringify(a.list) === JSON.stringify(b.list);

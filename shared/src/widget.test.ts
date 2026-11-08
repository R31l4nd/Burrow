import { describe, expect, it } from 'vitest';
import { sameWidget, type WidgetSummary } from './widget.js';

const w = (over: Partial<WidgetSummary> = {}): WidgetSummary => ({ at: '2026-11-01T12:00:00.000Z', hosts: { total: 3, up: 2, down: 1 }, alerts: 1, updates: { hosts: 1, security: 2 }, list: [{ id: 1, name: 'nas', state: 'down', updates: 0, security: 0 }], ...over });

describe("the widget's numbers", () => {
  it('the same numbers at another time are the same: nothing to send again', () => {
    expect(sameWidget(w(), w({ at: '2026-11-01T12:05:00.000Z' }))).toBe(true);
    expect(sameWidget(null, w())).toBe(false);
    expect(sameWidget(w(), w({ alerts: 2 }))).toBe(false);
    expect(sameWidget(w(), w({ hosts: { total: 3, up: 3, down: 0 } }))).toBe(false);
    expect(sameWidget(w(), w({ updates: { hosts: 1, security: 0 } }))).toBe(false);
    // A host's line changed (its name, its state): sent again.
    expect(sameWidget(w(), w({ list: [{ id: 1, name: 'nas', state: 'up', updates: 0, security: 0 }] }))).toBe(false);
    expect(sameWidget(w(), w({ list: [{ id: 1, name: 'nas2', state: 'down', updates: 0, security: 0 }] }))).toBe(false);
  });
});

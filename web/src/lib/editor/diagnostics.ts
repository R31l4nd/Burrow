import { LSPPlugin, serverDiagnostics, type LSPClientExtension } from '@codemirror/lsp-client';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { StateEffect, type ChangeDesc } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Diagnostic as BurrowDiagnostic } from '@burrow/shared';

// Diagnostics from several sources in one editor: the language server
// (published whenever it likes), hadolint and `docker compose config`
// (asked by Burrow). @codemirror/lint keeps one set per editor, so the
// sources are kept apart here and combined on every change.

const bySource = new WeakMap<EditorView, Map<string, Diagnostic[]>>();

function publish(view: EditorView): void {
  const all = [...(bySource.get(view)?.values() ?? [])].flat();
  view.dispatch(setDiagnostics(view.state, all));
}

/**
 * Each source's diagnostics moved along with every edit, as CodeMirror does
 * with the ones it shows: kept where they were, another source's update
 * put them back at old places (AUDIT2 TERM-12).
 */
export function mapThrough(list: Diagnostic[], changes: ChangeDesc): Diagnostic[] {
  return list.map((d) => {
    const from = changes.mapPos(d.from, 1);
    return { ...d, from, to: Math.max(from, changes.mapPos(d.to, -1)) };
  });
}

const followEdits = EditorView.updateListener.of((u) => {
  const m = bySource.get(u.view);
  if (!m || !u.docChanged) return;
  for (const [k, list] of m) m.set(k, mapThrough(list, u.changes));
});

export function setSource(view: EditorView, source: string, diags: Diagnostic[]): void {
  let m = bySource.get(view);
  if (!m) {
    bySource.set(view, (m = new Map()));
    view.dispatch({ effects: StateEffect.appendConfig.of(followEdits) });
  }
  m.set(source, diags);
  publish(view);
}

/** Burrow's line/column diagnostics (1-based) as CodeMirror ranges. */
export function fromBurrow(view: EditorView, list: BurrowDiagnostic[]): Diagnostic[] {
  const doc = view.state.doc;
  return list.map((d) => {
    const line = doc.line(Math.min(Math.max(1, d.line), doc.lines));
    const from = Math.min(line.to, line.from + Math.max(0, d.column - 1));
    return {
      from,
      to: from === line.to ? from : line.to,
      severity: d.severity,
      source: d.source,
      message: d.code ? `${d.code}: ${d.message}` : d.message,
    };
  });
}

const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'] as const;

/** Like the package's serverDiagnostics(), but merged with the other sources. */
export function mergedServerDiagnostics(): LSPClientExtension {
  // Keep the package's editor extension: it sends edits to the server as you
  // type, so diagnostics follow without waiting for a save.
  const base = serverDiagnostics();
  return {
    ...base,
    notificationHandlers: {
      'textDocument/publishDiagnostics': (client, params: { uri: string; version?: number; diagnostics: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string; code?: string | number }[] }) => {
        const file = client.workspace.getFile(params.uri);
        if (!file || (params.version != null && params.version !== file.version)) return false;
        const view = file.getView();
        const plugin = view && LSPPlugin.get(view);
        if (!view || !plugin) return false;
        setSource(
          view,
          'lsp',
          params.diagnostics.map((item) => ({
            from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
            to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
            severity: SEVERITY[item.severity ?? 1] === 'hint' ? 'info' : (SEVERITY[item.severity ?? 1] as 'error' | 'warning' | 'info'),
            ...(item.source ? { source: item.source } : {}),
            message: item.code !== undefined && item.source === 'shellcheck' ? `SC${item.code}: ${item.message}` : item.message,
          })),
        );
        return true;
      },
    },
  };
}

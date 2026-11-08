<script lang="ts" module>
  export interface Source {
    hostId: number;
    /** Empty for a log file on the host. */
    container: string;
    /** A log file instead of the container's own output. */
    file?: string | null;
    label: string;
  }
</script>

<script lang="ts">
  import { lineKey } from '../lib/logkey.js';
  import { dialLimit } from '../lib/dial.js';
  import { tick, untrack } from 'svelte';
  import { detectLevel, foldStacks, insertionIndex, LOG_LEVELS, parseJsonLine, sortKey, splitFileLine, targetKey, targetLabel, type LogFilterSuggestion, type LogLevel, type LogServerMessage } from '@burrow/shared';
  import { ansiToHtml, softBreaks, stripAnsi } from '../lib/ansi.js';
  import { repeatedHead } from '../lib/logprefix.js';
  import { scrollCue } from '../lib/scrollcue.js';
  import { SOURCE_COLORS } from '../lib/docker.svelte.js';
  import { locale, t } from '../lib/i18n/index.svelte.js';
  import { copyText, toast } from '../lib/ui.svelte.js';
  import Icon from './Icon.svelte';
  import AnalyzeDialog from './AnalyzeDialog.svelte';
  import { errorMessage, get, post } from '../lib/api.js';
  import { android } from '../lib/android.js';
  import { capLines } from '../lib/logcap.js';
  import { sourceProblem } from '../lib/logproblem.js';

  // Logs of one or more containers, from one or more hosts, merged into one
  // timeline by Docker's timestamps. Follows live; scrolling up pauses.
  // Filters like Dozzle: level, stdout/stderr, source, search (text or
  // regex), time range. Lines can be pinned, linked to and downloaded.

  let {
    sources,
    at = null,
    atLine = null,
    onoptions,
    analyze = false,
    text,
  }: {
    sources: Source[];
    /** A permalink: open around this timestamp, with that line marked. */
    at?: string | null;
    /** Which line at that time: its source and a short hash of its text (lines can share a timestamp). */
    atLine?: { i: number; h: string } | null;
    /**
     * A page with more to offer (a container's actions) gets an Options
     * button here instead of Download; it gets the download to offer too.
     */
    onoptions?: (download: () => void, analyse: (() => void) | null) => void;
    /** Open the analysis at once (from an alert's "Analyse"). */
    analyze?: boolean;
    /**
     * A file's text read here (a log file of the phone, PhoneFiles): its lines
     * as they are, nothing followed, and nothing of it sent anywhere (no
     * analysis, no question to a model).
     */
    text?: string;
  } = $props();
  const local = untrack(() => text !== undefined);

  // "Analyse" when a model is set up; opened at once from an alert.
  let aiOptions = $state<{ available: boolean; deep: boolean } | null>(null);
  let analyzeOpen = $state(false);
  if (!local)
    get<{ available: boolean; deep: boolean }>('/api/ai/analyze/options').then(
      (o) => (aiOptions = o),
      () => {},
    );
  // Opened at once from an alert's "Analyse": once. Closed, it stays closed while lines come in (AUDIT2 UI-04).
  let autoOpened = false;
  $effect(() => {
    if (analyze && !autoOpened && aiOptions?.available && lines.length)
      untrack(() => {
        autoOpened = true;
        analyzeOpen = true;
      });
  });
  const forModel = (ls: { i: number; ts: string; plain: string }[]) => ls.slice(-5000).map((l) => ({ i: l.i, ts: l.ts, text: l.plain }));

  interface Line {
    id: number;
    key: string;
    ts: string;
    i: number;
    s: 'o' | 'e';
    text: string;
    plain: string;
    level: LogLevel | null;
    json: Record<string, unknown> | null;
    undated?: true;
  }

  // At most this many lines of each source (decision 3: a loud one took the
  // whole 5000 of a merged view, the quiet ones' lines were dropped), and
  // never more than MAX_TOTAL in all, so the page stays usable.
  const MAX_LINES = 5000;
  const MAX_TOTAL = 50_000;
  // One more than is kept of a source: the server sends at most this many of each, and one
  // over says there were more than are kept, so the view can say so (decision 3).
  const TAIL = String(MAX_LINES + 1);
  const SHOWN = 2000;
  type Range = 'tail' | 'start' | '15m' | '1h' | '24h' | 'at';

  let range = $state<Range>(untrack(() => (at ? 'at' : 'tail')));
  let lines = $state.raw<Line[]>([]);
  // The oldest lines of a time range beyond what is kept: said, else "since start" of many
  // containers read as only the last minutes (report c8d284).
  let dropped = $state(0);
  let keys: string[] = [];
  let nextId = 1;
  let status = $state<Record<number, string>>({});
  let following = $state(true);
  let unseen = $state(0);
  let query = $state('');
  let regex = $state(false);
  let levels = $state<Set<LogLevel | 'none'>>(new Set([...LOG_LEVELS, 'none']));
  let stream = $state<'all' | 'o' | 'e'>('all');
  let hidden = $state<Set<number>>(new Set());
  // On a phone the filters fold away behind one button (the log gets the
  // room); the button counts the filters that are on.
  // More sources than this: their chips behind one, opened on demand.
  const MANY_SOURCES = 10;
  let sourcesOpen = $state(false);
  let filtersOpen = $state(false);
  const activeFilters = $derived(
    Number(levels.size < LOG_LEVELS.length + 1) + Number(stream !== 'all') + Number(range !== 'tail' && range !== 'at') + Number(hidden.size > 0),
  );
  let pinned = $state<Set<number>>(new Set());
  let showPinned = $state(false);
  let expanded = $state<Set<number>>(new Set());
  let selected = $state<number | null>(null);
  let sideBySide = $state(false);
  let colsEl: HTMLDivElement | undefined = $state();
  const logs = () => [...(colsEl?.querySelectorAll<HTMLElement>('.log') ?? [])];
  let marked = $state<string | null>(untrack(() => at));

  const color = (i: number) => SOURCE_COLORS[i % SOURCE_COLORS.length]!;

  // A question in words, turned by the model into these same filters (N6):
  // only the question and the source names go out. What it set is said
  // under the filters, can be changed there, and Undo puts back what was.
  let asking = $state('');
  let askBusy = $state(false);
  // Opened by its button: a line of its own only when wanted (the log keeps the room).
  let askOpen = $state(false);
  // The range and this button beside the search on a wide screen (with the
  // filters they pushed chips to a second row, and the log lost it); with the
  // filters on a phone, folded away behind their button.
  const wideQuery = typeof window === 'undefined' ? null : window.matchMedia('(min-width: 720px)');
  let wide = $state(wideQuery?.matches ?? true);
  $effect(() => {
    if (!wideQuery) return;
    const on = () => (wide = wideQuery.matches);
    wideQuery.addEventListener('change', on);
    return () => wideQuery.removeEventListener('change', on);
  });
  let noteOpen = $state(false);
  let asked = $state<{ explanation: string; before: { query: string; regex: boolean; levels: Set<LogLevel | 'none'>; stream: 'all' | 'o' | 'e'; range: Range; hidden: Set<number> } } | null>(null);
  async function ask(e: SubmitEvent) {
    e.preventDefault();
    if (!asking.trim()) return;
    askBusy = true;
    try {
      const f = await post<LogFilterSuggestion>('/api/ai/logfilter', { prompt: asking, sources: sources.map((s) => s.label), locale: locale() });
      const before = { query, regex, levels, stream, range, hidden };
      query = f.query;
      regex = f.regex;
      levels = new Set(f.levels.length ? f.levels : [...LOG_LEVELS, 'none']);
      stream = f.stream;
      range = f.range;
      hidden = f.sources.length ? new Set(sources.map((_, i) => i).filter((i) => !f.sources.includes(i))) : new Set();
      asked = { explanation: f.explanation || t('logs.askApplied'), before };
      filtersOpen = true;
      askOpen = false;
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      askBusy = false;
    }
  }
  function undoAsk() {
    if (!asked) return;
    ({ query, regex, levels, stream, range, hidden } = asked.before);
    asked = null;
  }

  // Connected again after a gap: from where each source's lines stopped, not the last 500
  // again (more than 500 meanwhile were lost without a word, AUDIT2 UI-09).
  let resumeFrom: string | null = null;
  const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:\d\d)$/;
  function resumePoint(): string | null {
    const last = new Map<number, string>();
    for (const l of lines) last.set(l.i, l.ts);
    if (last.size < sources.length) return null;
    const all = [...last.values()];
    if (!all.every((ts) => TS.test(ts))) return null;
    return all.sort()[0]!;
  }

  function url(): string {
    const q = new URLSearchParams({ t: sources.map((s) => targetKey(s)).join(',') });
    if (resumeFrom && (range === 'tail' || range === '15m' || range === '1h' || range === '24h')) {
      q.set('since', resumeFrom);
      q.set('tail', TAIL);
    } else if (range === 'at' && at) {
      const d = Date.parse(at);
      q.set('since', new Date(d - 120_000).toISOString());
      q.set('until', new Date(d + 120_000).toISOString());
      q.set('tail', TAIL);
      q.set('follow', '0');
    } else if (range === 'start') {
      // Each source since its own last start, looked up on its host: a view of 40 merged
      // containers has no one start time, and the range could not be chosen there (report c8d284).
      q.set('since', 'start');
      q.set('tail', TAIL);
    } else if (range === '15m' || range === '1h' || range === '24h') {
      q.set('since', range === '24h' ? '24h' : range);
      q.set('tail', TAIL);
    } else {
      q.set('tail', '500');
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/docker/logs/ws?${q.toString()}`;
  }

  function add(batch: Line[]) {
    const next = lines.slice();
    for (const l of batch) {
      const at = insertionIndex(keys, l.key);
      keys.splice(at, 0, l.key);
      next.splice(at, 0, l);
    }
    dropped += capLines(next, keys, MAX_LINES, MAX_TOTAL);
    lines = next;
    if (!following) unseen += batch.length;
  }

  // The connection gone (Burrow restarted, the network, the phone asleep):
  // the lines stayed as they were, looking live (audit WC-10). Now it says so
  // and connects again; what came meanwhile is added, nothing twice.
  let lost = $state(false);
  // Refused by the server (not allowed, signed out, not a log source): said in the log for as
  // long as it is open, never "No lines yet." with the reason in a toast that goes (A3-WEB-01).
  let refused = $state<string | null>(null);
  // The server's word for the whole view (not one source's), kept on the page.
  let general = $state<string | null>(null);
  const RETRY_MS = [1000, 2000, 4000, 8000, 15_000];
  // Try again, from the failed state: the whole read again.
  let tries = $state(0);
  $effect(() => {
    void range;
    void tries;
    lines = [];
    keys = [];
    dropped = 0;
    status = {};
    unseen = 0;
    following = range !== 'at';
    lost = false;
    refused = null;
    general = null;
    resumeFrom = null;
    if (local) {
      // The file's last lines, in its own order; it has ended.
      const all = untrack(() => text ?? '').split('\n');
      if (all.at(-1) === '') all.pop();
      const keep = all.slice(-MAX_LINES);
      keys = keep.map((_, n) => String(n).padStart(8, '0'));
      // Its time from the line where it says one (as a host's log file, server/src/docker/logs.ts), else the one before.
      let last = new Date().toISOString();
      lines = keep.map((raw, n) => {
        const split = splitFileLine(raw);
        last = split.ts ?? last;
        const json = parseJsonLine(split.text);
        return { id: nextId++, key: keys[n]!, ts: last, i: 0, s: 'o' as const, text: split.text, plain: stripAnsi(split.text), level: detectLevel(split.text, json), json };
      });
      status = { 0: 'ended' };
      return;
    }
    // How often each line is held, for the overlap after connecting again: a line sent again
    // is dropped as often as it was held, a line that really came twice stays twice (AUDIT2
    // UI-07); counted again from what is held when it grows, as lines beyond 5000 go (UI-08).
    let held = new Map<string, number>();
    let prior: Map<string, number> | null = null;
    const keyOf = lineKey;
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      const s = new WebSocket(untrack(url));
      ws = s;
      dialLimit(s);
      s.onopen = () => {
        attempt = 0;
        lost = false;
      };
      s.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as LogServerMessage;
        if (m.t === 'lines') {
          const fresh = m.lines.filter((l) => {
            const k = keyOf(l);
            const left = prior?.get(k) ?? 0;
            if (left > 0) {
              prior!.set(k, left - 1);
              return false;
            }
            held.set(k, (held.get(k) ?? 0) + 1);
            return true;
          });
          if (held.size > MAX_LINES * 2) {
            held = new Map();
            for (const l of lines) held.set(keyOf(l), (held.get(keyOf(l)) ?? 0) + 1);
          }
          add(
            fresh.map((l) => {
              const json = parseJsonLine(l.text);
              return { id: nextId++, key: sortKey(l.ts), ts: l.ts, i: l.i, s: l.s, text: l.text, plain: stripAnsi(l.text), level: detectLevel(l.text, json), json, ...(l.undated ? { undated: true as const } : {}) };
            }),
          );
        } else if (m.t === 'end') {
          // An error said before the end stays said: the end of a failed read is no quiet end (AUDIT2 UI-10).
          const was = status[m.i];
          status = { ...status, [m.i]: was === 'output' ? 'output' : was && was !== 'ended' ? was : 'ended' };
        }
        else if (m.t === 'output') status = { ...status, [m.i]: 'output' };
        else if (m.t === 'error') {
          if (m.i < 0) general = m.message;
          else status = { ...status, [m.i]: m.message };
        }
      };
      s.onclose = (e) => {
        // Ours, or refused (a bad request, signed out): not again. Too slow (4008, the server let it go): again, from where it was.
        if (stopped || ws !== s) return;
        if (e.code >= 4000 && e.code !== 4008) {
          refused = e.code === 4401 ? t('logs.refusedSignedOut') : e.code === 4403 ? t('logs.refusedNotAllowed') : (untrack(() => general) ?? t('logs.refused', { reason: e.reason || String(e.code) }));
          general = null;
          return;
        }
        if (untrack(() => range) === 'at') return;
        lost = true;
        resumeFrom = resumePoint();
        prior = new Map(held);
        timer = setTimeout(open, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      };
    };
    // Back in sight or online: now, not after the wait.
    const now = () => {
      if (stopped || !lost || document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      open();
    };
    document.addEventListener('visibilitychange', now);
    window.addEventListener('online', now);
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', now);
      window.removeEventListener('online', now);
      ws?.close();
    };
  });

  const matcher = $derived.by(() => {
    const q = query.trim();
    if (!q) return null;
    if (regex) {
      try {
        const re = new RegExp(q, 'i');
        return (s: string) => re.test(s);
      } catch {
        return 'invalid' as const;
      }
    }
    const lower = q.toLowerCase();
    return (s: string) => s.toLowerCase().includes(lower);
  });

  const filtered = $derived(
    lines.filter(
      (l) =>
        !hidden.has(l.i) &&
        (stream === 'all' || l.s === stream) &&
        levels.has(l.level ?? 'none') &&
        (matcher === null || matcher === 'invalid' || matcher(l.plain)),
    ),
  );
  const shown = $derived(filtered.length > SHOWN ? filtered.slice(-SHOWN) : filtered);
  // Something to say in the bar under the filters (else it takes no row).
  // One source that ended: said here, as there is no source chip to say it (AUDIT2 UI-10).
  const singleEnded = $derived(sources.length === 1 && status[0] === 'ended' && range !== 'at');
  const droppedShown = $derived(range !== 'tail' && dropped > 0);
  const barNeeded = $derived(filtered.length !== lines.length || droppedShown || lost || !!general || Object.values(status).some((m) => m !== 'ended') || pinned.size > 0);
  // An empty log says why: nothing in the range, all hidden by the filters, or every read failed.
  const failedAll = $derived(sources.length > 0 && sources.every((_, i) => status[i] !== undefined && status[i] !== 'ended' && status[i] !== 'output'));
  function showAll() {
    query = '';
    regex = false;
    levels = new Set([...LOG_LEVELS, 'none']);
    stream = 'all';
    hidden = new Set();
  }
  const allColumns = $derived(sideBySide ? sources.map((_, i) => shown.filter((l) => l.i === i)) : [shown]);
  // A stack trace folded under its first line ("+12 lines"), opened by a tap.
  let openStacks = $state<Set<number>>(new Set());
  const folds = $derived.by(() => {
    const more = new Map<number, number>();
    const headOf = new Map<number, number>();
    for (const col of allColumns) {
      const f = foldStacks(col.map((l) => ({ source: l.i, text: l.plain })));
      for (const [i, n] of f.more) more.set(col[i]!.id, n);
      for (const [i, h] of f.headOf) headOf.set(col[i]!.id, col[h]!.id);
    }
    return { more, headOf };
  });
  const columns = $derived(allColumns.map((col) => col.filter((l) => !folds.headOf.has(l.id) || openStacks.has(folds.headOf.get(l.id)!))));
  const pinnedLines = $derived(lines.filter((l) => pinned.has(l.id)));

  // Follow: stay at the bottom while new lines come in.
  $effect(() => {
    void shown;
    if (!following || !colsEl) return;
    void tick().then(() => logs().forEach((b) => (b.scrollTop = b.scrollHeight)));
  });

  // A permalink: once its line is there, bring it into view.
  $effect(() => {
    if (!marked || !colsEl) return;
    if (!lines.some(isMarked)) return;
    void tick().then(() => colsEl?.querySelector('.line.marked')?.scrollIntoView({ block: 'center' }));
  });

  function onScroll(e: Event) {
    const box = e.currentTarget as HTMLElement;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (atBottom && !following && range !== 'at') {
      following = true;
      unseen = 0;
    } else if (!atBottom && following) following = false;
  }

  function jumpToEnd() {
    following = true;
    unseen = 0;
    logs().forEach((b) => (b.scrollTop = b.scrollHeight));
  }

  function toggle<T>(set: Set<T>, v: T): Set<T> {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  }

  /** A short, stable fingerprint of a line's text (for links to it). */
  function lineHash(s: string): string {
    let h = 5381;
    for (let k = 0; k < s.length; k++) h = ((h << 5) + h + s.charCodeAt(k)) | 0;
    return (h >>> 0).toString(36);
  }

  const isMarked = (l: Line) => marked !== null && l.key === sortKey(marked) && (!atLine || (l.i === atLine.i && lineHash(l.plain) === atLine.h));

  const time = (ts: string) => {
    const d = new Date(ts);
    return `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };

  function summary(l: Line): string {
    const j = l.json;
    const m = j && (j.msg ?? j.message ?? j.MESSAGE ?? j.log);
    return typeof m === 'string' ? m : l.text;
  }

  // The keyboard picks a line too: arrows up and down in a log that has the focus, its Pin,
  // Link and Copy then reached with Tab; Escape lets go (AUDIT2 UI-27: only a click did).
  function keyPick(e: KeyboardEvent, col: Line[]) {
    if (e.target !== e.currentTarget || !col.length) return;
    if (e.key === 'Escape' && selected !== null) {
      selected = null;
      e.preventDefault();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const at = col.findIndex((l) => l.id === selected);
    const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : col.length - 1) : Math.max(0, Math.min(col.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    selected = col[next]!.id;
    e.preventDefault();
    queueMicrotask(() => (e.currentTarget as HTMLElement | null)?.querySelector('.line.sel')?.scrollIntoView({ block: 'nearest' }));
  }

  function permalink(l: Line): string {
    const q = new URLSearchParams({ t: sources.map((s) => targetKey(s)).join(','), at: l.ts, ai: String(l.i), ah: lineHash(l.plain) });
    return `${location.origin}${location.pathname}#/logs?${q.toString()}`;
  }

  function download() {
    const text = filtered.map((l) => `${l.ts} ${sources[l.i]?.label ?? ''} ${l.s === 'e' ? 'stderr' : 'stdout'} ${l.plain}`).join('\n');
    const name = `logs-${sources.map((s) => targetLabel(s).replace(/[^\w.-]+/g, '_')).join('+').slice(0, 60)}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`;
    if (android) {
      void android.saveText(name, text + '\n').then(
        () => toast(t('logs.savedPhone')),
        (err: unknown) => toast(errorMessage(err), 'error'),
      );
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const levelLabel = (l: LogLevel | 'none') => (l === 'none' ? t('logs.noLevel') : t(`logs.level.${l}`));
</script>

{#snippet rangeSelect()}
  <select class="range" bind:value={range} aria-label={t('logs.range')}>
    {#if at}<option value="at">{t('logs.rangeAt')}</option>{/if}
    <option value="tail">{t('logs.rangeTail')}</option>
    <option value="start">{t('logs.rangeStart')}</option>
    <option value="15m">{t('logs.range15m')}</option>
    <option value="1h">{t('logs.range1h')}</option>
    <option value="24h">{t('logs.range24h')}</option>
  </select>
{/snippet}

{#snippet askToggle()}
  <button class="icon-btn" aria-expanded={askOpen} aria-label={t('logs.ask')} title={t('logs.ask')} onclick={() => (askOpen = !askOpen)} data-testid="log-ask-open"><Icon name="chat" /></button>
{/snippet}

{#snippet row(l: Line)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="line lvl-{l.level ?? 'none'}"
    class:err={l.s === 'e'}
    class:marked={isMarked(l)}
    class:sel={selected === l.id}
    class:cont={folds.headOf.has(l.id)}
    data-testid="log-line"
    data-ts={l.key}
    data-src={l.i}
    onclick={() => (selected = selected === l.id ? null : l.id)}
  >
    <time title={l.ts}>{time(l.ts)}</time>
    {#if sources.length > 1 && !sideBySide}<span class="src" style:color={color(l.i)} title={sources[l.i]?.label}>{sources[l.i]?.label}</span>{/if}
    {#if l.level}<span class="lvl">{l.level}</span>{/if}
    {#if pinned.has(l.id)}<span class="pin" role="img" aria-label={t('logs.pinned')}><Icon name="pin" size={12} /></span>{/if}
    <span class="msg">
      {#if l.json && !expanded.has(l.id)}
        {summary(l)}
        <button class="json" data-testid="log-json" onclick={(e) => (e.stopPropagation(), (expanded = toggle(expanded, l.id)))}>{'{...}'}</button>
      {:else if l.json}
        <button class="json" data-testid="log-json-close" onclick={(e) => (e.stopPropagation(), (expanded = toggle(expanded, l.id)))}>{'{ }'}</button>
        <pre>{JSON.stringify(l.json, null, 2)}</pre>
      {:else}
        {@const dup = repeatedHead(l.text, l.level)}
        <!-- The app's own time and level, said already in front: dimmed (web/src/lib/logprefix.ts). -->
        {#if dup}<span class="dup" data-testid="log-dup">{l.text.slice(0, dup)}</span>{/if}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- ansiToHtml escapes the text first -->
        {@html softBreaks(ansiToHtml(dup ? l.text.slice(dup) : l.text))}
      {/if}
      {#if folds.more.has(l.id)}
        <button class="json" data-testid="log-stack" aria-expanded={openStacks.has(l.id)} onclick={(e) => (e.stopPropagation(), (openStacks = toggle(openStacks, l.id)))}
          >{openStacks.has(l.id) ? t('logs.stackLess') : t('logs.stackMore', { n: folds.more.get(l.id)! })}</button
        >
      {/if}
    </span>
    {#if selected === l.id}
      <span class="actions">
        <button class="btn small" aria-label={pinned.has(l.id) ? t('logs.unpin') : t('logs.pin')} title={pinned.has(l.id) ? t('logs.unpin') : t('logs.pin')} onclick={(e) => (e.stopPropagation(), (pinned = toggle(pinned, l.id)))}
          ><Icon name="pin" size={16} /><span class="word" aria-hidden="true">{pinned.has(l.id) ? t('logs.unpin') : t('logs.pin')}</span></button
        >
        {#if !local}<button class="btn small" aria-label={t('logs.link')} title={t('logs.link')} onclick={async (e) => (e.stopPropagation(), (await copyText(permalink(l))) && toast(t('logs.linkCopied')))}
            ><Icon name="link" size={16} /><span class="word" aria-hidden="true">{t('logs.linkShort')}</span></button
          >{/if}
        <button class="btn small" aria-label={t('common.copy')} title={t('common.copy')} onclick={async (e) => (e.stopPropagation(), (await copyText(l.plain)) && toast(t('common.copied')))}
          ><Icon name="copy" size={16} /><span class="word" aria-hidden="true">{t('common.copy')}</span></button
        >
      </span>
    {/if}
  </div>
{/snippet}

<div class="logview">
  <div class="tools">
    <div class="lsearch" class:bad={matcher === 'invalid'}>
      <Icon name="search" />
      <input type="search" bind:value={query} placeholder={t('logs.search')} aria-label={t('logs.search')} autocapitalize="none" spellcheck="false" />
      <button class="rx" class:on={regex} aria-pressed={regex} title={t('logs.regex')} aria-label={t('logs.regex')} onclick={() => (regex = !regex)}>.*</button>
    </div>
    {#if wide && !local}{@render rangeSelect()}{/if}
    {#if sources.length > 1}
      <!-- Beside the search, not on a line of its own (report eeff05). -->
      <button class="icon-btn wide-only" aria-pressed={sideBySide} aria-label={sideBySide ? t('logs.merged') : t('logs.sideBySide')} title={sideBySide ? t('logs.merged') : t('logs.sideBySide')} onclick={() => (sideBySide = !sideBySide)} data-testid="log-side-by-side"><Icon name="layers" /></button>
    {/if}
    {#if aiOptions?.available && wide}{@render askToggle()}{/if}
    <button class="icon-btn filter-toggle" aria-expanded={filtersOpen} aria-label={t('logs.filters')} title={t('logs.filters')} onclick={() => (filtersOpen = !filtersOpen)} data-testid="log-filters"
      ><Icon name="filter" />{#if activeFilters}<span class="count">{activeFilters}</span>{/if}</button
    >
    {#if onoptions}
      <!-- A page with a menu of its own gets Analyse and Download in it. -->
      <button class="icon-btn" aria-label={t('common.options')} title={t('common.options')} onclick={() => onoptions(download, aiOptions ? () => (analyzeOpen = true) : null)} data-testid="log-options"><Icon name="more" /></button>
    {:else}
      {#if aiOptions}
        <button class="icon-btn" aria-label={t('analyze.button')} title={t('analyze.button')} onclick={() => (analyzeOpen = true)} data-testid="analyze-open"><Icon name="sparkle" /></button>
      {/if}
      <button class="icon-btn" aria-label={t('logs.download')} title={t('logs.download')} onclick={download}><Icon name="download" /></button>
    {/if}
  </div>

  {#if aiOptions?.available && askOpen}
    <form class="ask" onsubmit={ask}>
      <input type="text" bind:value={asking} placeholder={t('logs.askPlaceholder')} aria-label={t('logs.ask')} maxlength="500" data-testid="log-ask" />
      <button class="btn small" disabled={askBusy || !asking.trim()} data-testid="log-ask-go"><Icon name="sparkle" size={16} /> {askBusy ? t('logs.asking') : t('logs.askGo')}</button>
    </form>
  {/if}
  <div class="filters" class:open={filtersOpen} role="group" aria-label={t('logs.filters')}>
    {#if aiOptions?.available && !wide}
      <!-- With the filters on a phone: beside the search it kept the search too little room. -->
      {@render askToggle()}
    {/if}
    {#if !wide && !local}{@render rangeSelect()}{/if}
    <div class="chips" use:scrollCue>
      {#each [...LOG_LEVELS, 'none'] as const as l (l)}
        <button class="chip lvl-{l}" class:off={!levels.has(l)} aria-pressed={levels.has(l)} onclick={() => (levels = toggle(levels, l))}>{levelLabel(l)}</button>
      {/each}
      <span class="sep"></span>
      {#each [['all', t('logs.streamAll')], ['o', 'stdout'], ['e', 'stderr']] as const as [v, label] (v)}
        <button class="chip pick" class:on={stream === v} aria-pressed={stream === v} onclick={() => (stream = v)}>{label}</button>
      {/each}
      {#if sources.length > MANY_SOURCES}
        <span class="sep"></span>
        <!-- Many sources (a stack of 60): one chip that opens them, not rows of chips (report eeff05). -->
        <button class="chip pick" class:on={sourcesOpen} aria-expanded={sourcesOpen} onclick={() => (sourcesOpen = !sourcesOpen)} data-testid="log-sources-toggle">{t('logs.sourcesShown', { shown: sources.length - hidden.size, n: sources.length })}</button>
      {/if}
      {#if sources.length > 1 && (sources.length <= MANY_SOURCES || sourcesOpen)}
        <span class="sep"></span>
        {#each sources as s, i (i)}
          <button class="chip src-chip" data-testid="log-source" class:off={hidden.has(i)} aria-pressed={!hidden.has(i)} style:--c={color(i)} onclick={() => (hidden = toggle(hidden, i))}
            >{s.label}{status[i] === 'ended' ? ` (${t('logs.ended')})` : ''}</button
          >
        {/each}
      {/if}
    </div>
  </div>

  <!-- The count only when the filters hide lines ("506 of 506" said nothing
       and cost the log a row on a phone); the bar only when it has something. -->
  {#if barNeeded || asked}
  <div class="bar small dim">
    {#if filtered.length !== lines.length}<span data-testid="log-count">{t('logs.count', { shown: filtered.length, total: lines.length })}</span>{/if}
    {#if asked}<span class="asked" class:open={noteOpen} data-testid="log-ask-note"><Icon name="sparkle" size={14} /> <button type="button" class="note-text" title={asked.explanation} aria-expanded={noteOpen} onclick={() => (noteOpen = !noteOpen)} data-testid="log-ask-text">{asked.explanation}</button> <button class="icon-btn" aria-label={t('logs.askUndo')} title={t('logs.askUndo')} onclick={undoAsk} data-testid="log-ask-undo"><Icon name="undo" size={18} /></button></span>{/if}
    {#if droppedShown}<span data-testid="log-dropped">{t('logs.dropped', { max: MAX_LINES })}</span>{/if}
    {#if lost}<span class="alert warn small" data-testid="log-reconnecting">{t('logs.reconnecting')}</span>{/if}
    {#if general}<span class="alert error small">{general}</span>{/if}
    {#each Object.entries(status) as [i, msg] (i)}
      {#if msg === 'output'}<span class="small" data-testid="log-is-output">{sources[Number(i)]?.label}: {t('logs.isOutput')}</span>
      <!-- None read: said once, in the log's place below, not here as well (report 931cd0). -->
      {:else if msg !== 'ended' && !failedAll}<span class="alert error small">{sources[Number(i)]?.label}: {sourceProblem(msg)}</span>{/if}
    {/each}
    <span class="spacer"></span>
    {#if pinned.size}<button class="btn small" onclick={() => (showPinned = !showPinned)}><Icon name="pin" size={14} /> {pinned.size}</button>{/if}
  </div>
  {/if}

  {#if showPinned && pinnedLines.length}
    <div class="pinned" data-testid="pinned">
      {#each pinnedLines as l (l.id)}{@render row(l)}{/each}
    </div>
  {/if}

  <div class="cols" class:multi={columns.length > 1} bind:this={colsEl} data-main>
    {#each columns as col, ci (ci)}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a scrolling box: keyboard users scroll it, and pick a line with the arrows, once it has focus) -->
      <div class="log" role="log" aria-live="off" tabindex="0" aria-label={t('logs.lines')} onscroll={onScroll} onkeydown={(e) => keyPick(e, col)} data-testid="log" data-private>
        {#if columns.length > 1}<div class="colhead" style:color={color(ci)}>{sources[ci]?.label}</div>{/if}
        {#if filtered.length > SHOWN}<p class="dim small older">{t('logs.older', { n: filtered.length - SHOWN })}</p>{/if}
        {#each col as l (l.id)}{@render row(l)}{/each}
        <!-- Under its last line, not a row of its own above the log (that took the log's room). -->
        {#if singleEnded}<p class="dim small ended" data-testid="log-ended">{t('logs.noMore')}</p>{/if}
        {#if refused}<p class="alert error small refused" data-testid="log-refused">{refused}</p>
        {:else if !lines.length && failedAll}
          <!-- Where the lines would be, once, in words; docker's own text and a red bar across
               the log over the reasons above it looked broken (report 931cd0). -->
          <div class="failed-all" role="status" data-testid="log-empty-failed">
            <p class="what"><Icon name="alert" size={18} /> {t('logs.failedAll')}</p>
            {#each sources as s, i (i)}<p class="small">{sources.length > 1 ? `${s.label}: ` : ''}{sourceProblem(status[i] ?? '')}</p>{/each}
            <button class="btn small" onclick={() => tries++} data-testid="log-retry"><Icon name="reload" size={14} /> {t('common.retry')}</button>
          </div>
        {:else if !lines.length}<p class="dim small empty" data-testid="log-empty">{range === 'tail' ? t('logs.empty') : t('logs.emptyRange')}</p>
        {:else if !filtered.length && ci === 0}
          <p class="dim small empty" data-testid="log-filtered-out">{t('logs.filteredOut', { n: lines.length })} <button class="btn small" onclick={showAll} data-testid="log-show-all">{t('logs.showAll')}</button></p>
        {/if}
      </div>
    {/each}
  </div>

  {#if !following && range !== 'at'}
    <button class="resume" onclick={jumpToEnd} data-testid="log-resume"><Icon name="arrow-down" size={14} /> {unseen ? t('logs.newLines', { n: unseen }) : t('logs.follow')}</button>
  {/if}
</div>

<AnalyzeDialog
  bind:open={analyzeOpen}
  targets={sources.map((s) => ({ hostId: s.hostId, container: s.container, ...(s.file ? { file: s.file } : {}) }))}
  shown={forModel(filtered)}
  pinned={forModel(pinnedLines)}
  deepAvailable={aiOptions?.deep ?? false}
  modelAvailable={aiOptions?.available ?? false}
  names={sources.map((s) => s.label).join(', ')}
/>

<style>
  /* The app's own time and level after Burrow's: there, but out of the way. */
  .dup {
    color: var(--text-dim);
  }
  .logview {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    position: relative;
    padding-top: 8px;
  }
  .tools {
    display: flex;
    gap: 6px;
  }
  .lsearch {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-raised);
    color: var(--text-dim);
  }
  .lsearch.bad {
    border-color: var(--danger);
  }
  .lsearch input {
    flex: 1;
    /* The box's full height: the range beside it on a wide screen is a field of that height too. */
    align-self: stretch;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 8px 0;
  }
  .lsearch input:focus {
    outline: none;
  }
  .rx {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font: 600 0.8rem var(--mono);
    padding: 2px 6px;
    cursor: pointer;
  }
  .rx.on {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }
  /* Range and chips: one row on a wide screen; on a phone folded away
     until the filter button opens them. */
  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 0 0;
    min-width: 0;
  }
  .ask {
    display: flex;
    gap: 6px;
    padding: 8px 0 0;
    min-width: 0;
  }
  .ask input {
    flex: 1;
    min-width: 0;
  }
  .ask .btn {
    flex: none;
  }
  .asked {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text);
  }
  /* The model's words take the line; Undo an icon beside them (its words squeezed them to a
     column on a phone, with "Ongedaan maken" beside it). */
  .asked {
    flex: 1 1 0;
  }
  /* On one line after the count, cut with "..." (all of it on hover): two lines of it
     and a line for the count took the log's room on a phone. */
  .note-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: start;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  /* Tapped: all of it (a phone has no hover for its title). */
  .asked.open {
    flex-basis: 100%;
  }
  .asked.open .note-text {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  select.range {
    width: auto;
    flex: none;
    max-width: 55%;
  }
  .chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
  }
  /* A wide screen: every chip in sight, on a second line when they do not fit
     (a journal's source chip was cut off with no way to reach it). */
  @media (min-width: 720px) {
    .chips {
      flex-wrap: wrap;
      overflow-x: visible;
    }
    /* The range at the top of chips that wrapped, not in their middle. */
    .filters {
      align-items: flex-start;
    }
  }
  .filter-toggle {
    display: none;
    position: relative;
  }
  .filter-toggle .count {
    position: absolute;
    top: 4px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-text);
    font: 700 0.7rem/16px var(--font);
  }
  @media (max-width: 719px) {
    .filter-toggle {
      display: inline-flex;
    }
    /* Open: the range and the scrolling chips on one line (the log keeps the screen). */
    .filters {
      display: none;
    }
    .filters.open {
      display: flex;
    }
    select.range {
      max-width: none;
    }
  }
  .chip {
    flex: none;
    /* One line: "geen niveau" and "67 van 67 bronnen" broke over two in Firefox, out of their frame (report d31c8d). */
    white-space: nowrap;
    padding: 4px 10px;
    border-radius: 5px;
    border: 1px solid var(--border);
    background: var(--bg-raised);
    color: var(--text);
    font: 600 0.8rem var(--font);
    cursor: pointer;
  }
  /* Off: struck through and in the quiet text colour, which still reads (faded to 45% it did not). */
  .chips .chip.off {
    color: var(--text-dim);
    border-style: dashed;
    text-decoration: line-through;
  }
  /* One of three (all / stdout / stderr): the chosen one filled. */
  .chip.pick.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .src-chip {
    border-color: var(--c);
    color: var(--c);
  }
  .sep {
    flex: none;
    width: 1px;
    background: var(--border);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 2px 0;
    min-height: 28px;
  }
  .spacer {
    flex: 1;
  }
  .cols {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 6px;
    /* Room under the search and the filters (the search box sat on the log). */
    margin-top: 8px;
  }
  .log {
    flex: 1;
    min-width: 0;
    overflow: auto;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: 0.8rem/1.45 var(--mono);
    padding: 4px 0;
  }
  .colhead {
    position: sticky;
    top: -4px;
    padding: 4px 8px;
    background: var(--bg-raised);
    font-weight: 700;
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    padding: 1px 8px;
    border-left: 3px solid transparent;
    content-visibility: auto;
    contain-intrinsic-size: auto 18px;
    cursor: pointer;
  }
  /* A problem report's picture: every line drawn (lib/bugreport.svelte.ts). */
  :global(html.capturing) .line {
    content-visibility: visible;
  }
  @media (hover: hover) {
    .line:hover {
      background: var(--bg-hover);
    }
  }
  .line.err {
    border-left-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }
  /* A chosen or linked line: a light tint and the accent's bar at its left. A darker tint left the
     red level and the dim time under 4.5:1 (found looking at a chosen line on a phone). */
  .line.marked,
  .line.sel {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-left-color: var(--accent);
  }
  time {
    color: var(--text-dim);
    flex: none;
  }
  /* On a chosen or linked line's tint the dim time read too faintly (4.1:1, found looking at a
     chosen line on a phone): nearer the text's own colour there. */
  .line:is(.marked, .sel) :is(time, .dup) {
    color: color-mix(in srgb, var(--text-dim) 50%, var(--text));
  }
  /* A long source name is cut with ..., its whole name in the title; the level stays in sight (A3-WEB-10). */
  .src {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 700;
  }
  .lvl {
    flex: none;
    text-transform: uppercase;
    font-weight: 700;
    font-size: 0.72rem;
    padding: 0 4px;
    border-radius: 4px;
    /* With the first line of a message that wraps, not in its middle (report 97e99b). */
    align-self: flex-start;
    margin-top: 2px;
  }
  .lvl-fatal .lvl,
  .lvl-error .lvl,
  .chip.lvl-fatal,
  .chip.lvl-error {
    color: var(--danger);
  }
  .lvl-warn .lvl,
  .chip.lvl-warn {
    color: var(--warn);
  }
  .lvl-info .lvl,
  .chip.lvl-info {
    color: var(--info);
  }
  .lvl-debug .lvl,
  .lvl-trace .lvl {
    color: var(--text-dim);
  }
  .msg {
    flex: 1 1 60%;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg pre {
    margin: 2px 0;
    white-space: pre-wrap;
  }
  /* A stack trace's frames, opened: set in under their first line. */
  .line.cont {
    padding-left: 24px;
  }
  .json {
    /* One piece: it wrapped into "{..." over "}" (report 87f290's picture). */
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-raised);
    color: var(--text-dim);
    font: 0.72rem var(--mono);
    padding: 0 4px;
    cursor: pointer;
  }
  /* A chosen line's actions: one row of three like buttons, an icon and a short word each, in the
     page's own type; where the words do not fit (a phone, Dutch, larger text) the icons alone, their
     names to a tap's title and a screen reader (report 41947e: in the log's type on a narrow phone in
     Dutch, Copy ran past the log's edge and Copy link broke over two lines). Never a second row. */
  .actions {
    flex-basis: 100%;
    display: flex;
    gap: 6px;
    padding: 4px 0;
    container-type: inline-size;
  }
  .actions > :global(.btn) {
    width: auto;
    flex: 1 1 0;
    min-width: 0;
    gap: 6px;
    font-family: var(--font);
    white-space: nowrap;
  }
  @container (max-width: 22rem) {
    .word {
      display: none;
    }
  }
  .pinned {
    max-height: 30%;
    overflow: auto;
    margin-bottom: 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font: 0.8rem/1.45 var(--mono);
  }
  .older,
  .ended,
  /* Why there are no lines: words, in the page's own type, not a log line's. */
  .empty {
    padding: 4px 8px;
    margin: 0;
    font-family: var(--font);
  }
  /* Nothing read: a short note in the middle of the log's room, in the page's type, the reason in
     words and Try again (report 931cd0). */
  .failed-all {
    margin: 48px auto;
    max-width: 520px;
    padding: 0 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
    font-family: var(--font);
  }
  .failed-all p {
    margin: 0;
  }
  .failed-all .what {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: var(--danger);
  }
  .failed-all .btn {
    width: auto;
    margin-top: 6px;
  }
  .refused {
    margin: 8px;
  }
  .resume {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--accent-text);
    font: 700 0.85rem var(--font);
    box-shadow: var(--shadow);
    cursor: pointer;
  }
  @media (max-width: 719px) {
    .wide-only {
      display: none;
    }
    /* The lines' room on a small phone: a container's page with a log file's chip row gave them under two thirds. */
    .logview {
      padding-top: 2px;
    }
    /* A phone wraps a line under its time: a rule between entries says
       which time heads which text (a stack trace's frames stay together). */
    .line + .line:not(.cont) {
      border-top: 1px solid var(--border-soft);
      padding-top: 3px;
      margin-top: 2px;
    }
  }
</style>

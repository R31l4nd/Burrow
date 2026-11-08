<script lang="ts">
  import { untrack } from 'svelte';
  import { Terminal as XTerm } from '@xterm/xterm';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import '@xterm/xterm/css/xterm.css';
  import type { Recording } from '@burrow/shared';
  import Icon from '../components/Icon.svelte';
  import LoadFailed from '../components/LoadFailed.svelte';
  import { ask } from '../lib/confirm.svelte.js';
  import { del, errorMessage, get, put } from '../lib/api.js';
  import { formatBytes } from '../lib/files.svelte.js';
  import { dateTime, t } from '../lib/i18n/index.svelte.js';
  import { go, up } from '../lib/router.svelte.js';
  import { prefs } from '../lib/sessions.svelte.js';
  import { cssVar, followTheme, termTheme } from '../lib/termtheme.js';
  import { toast } from '../lib/ui.svelte.js';

  // Recorded terminal sessions (F3), kept as long as chosen here (30 days by
  // default, decision 16): the list, and one played back as it happened
  // (faster if you like), or downloaded as asciicast.

  // embedded: the list as a part of the settings (#/settings/recordings, report e34ebd); a recording plays on a page of its own.
  let { id: idProp, embedded = false }: { id: number | null; embedded?: boolean } = $props();
  const id = untrack(() => idProp);

  let list = $state<Recording[] | null>(null);
  let loadError = $state('');
  function load() {
    loadError = '';
    get<Recording[]>('/api/recordings').then(
      (l) => (list = l),
      (err: unknown) => (loadError = errorMessage(err)),
    );
  }
  load();
  const current = $derived(list?.find((r) => r.id === id) ?? null);

  const KEEP = [7, 14, 30, 60, 90, 180, 365];
  let keep = $state<number | null>(null);
  get<{ keepDays: number }>('/api/recordings/settings').then(
    (k) => (keep = k.keepDays),
    () => {},
  );
  async function setKeep(days: number) {
    try {
      const r = await put<{ keepDays: number; removed: number }>('/api/recordings/settings', { keepDays: days });
      keep = r.keepDays;
      toast(r.removed ? t('rec.keepRemoved', { n: r.removed }) : t('rec.keepSaved'));
      if (r.removed) load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function remove(r: Recording) {
    if (!(await ask({ text: t('rec.removeConfirm', { name: r.title ?? r.hostName }), confirm: t('common.remove'), danger: true }))) return;
    try {
      await del(`/api/recordings/${r.id}`);
      toast(t('rec.removed'));
      if (id === r.id) go('/settings/recordings');
      else load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  // ---- the player
  let el = $state<HTMLDivElement>();
  let events: [number, string, string][] = [];
  let at = $state(0);
  let length = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let term: XTerm | null = null;
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  // Every event up to the next one due, then a wait for that one (long pauses shortened to two seconds).
  function step() {
    stopTimer();
    if (!term || !playing) return;
    const start = events[next]?.[0] ?? length;
    while (next < events.length && events[next]![0] <= start) {
      const [time, kind, data] = events[next++]!;
      at = time;
      if (kind === 'o') term.write(data);
      else if (kind === 'r') {
        const [c, r] = data.split('x').map(Number);
        if (c && r) term.resize(c, r);
      }
    }
    if (next >= events.length) {
      playing = false;
      at = length;
      return;
    }
    const wait = Math.min(2, events[next]![0] - start) / speed;
    timer = setTimeout(step, wait * 1000);
  }
  function play() {
    if (next >= events.length) restart();
    playing = true;
    step();
  }
  function pause() {
    playing = false;
    stopTimer();
  }
  function restart() {
    stopTimer();
    next = 0;
    at = 0;
    term?.reset();
  }

  $effect(() => {
    if (!el || id === null) return;
    const x = new XTerm({ fontFamily: cssVar('--mono'), fontSize: untrack(() => prefs.fontSize), scrollback: 5000, disableStdin: true, cursorBlink: false, allowProposedApi: true, minimumContrastRatio: 4.5, theme: termTheme() });
    const unfollow = followTheme(x);
    x.loadAddon(new Unicode11Addon());
    x.unicode.activeVersion = '11';
    x.open(el);
    term = x;
    let gone = false;
    fetch(`/api/recordings/${id}/cast`).then(async (res) => {
      if (gone) return;
      if (!res.ok) return void (loadError = t('rec.unreadable'));
      const lines = (await res.text()).split('\n').filter(Boolean);
      const head = JSON.parse(lines[0] ?? '{}') as { width?: number; height?: number };
      if (head.width && head.height) x.resize(head.width, head.height);
      // The recording's width on the page: a smaller text when its columns are wider than the room
      // (its first line ended at the player's edge with room left on the page, UIB-14).
      requestAnimationFrame(() => {
        const screen = el?.querySelector<HTMLElement>('.xterm-screen');
        const room = (el?.clientWidth ?? 0) - 12;
        if (!screen || gone || room <= 0 || screen.offsetWidth <= room) return;
        x.options.fontSize = Math.max(8, Math.floor((x.options.fontSize ?? 14) * (room / screen.offsetWidth) * 10) / 10);
      });
      events = lines.slice(1).flatMap((l) => {
        try {
          const e = JSON.parse(l) as [number, string, string];
          return Array.isArray(e) && typeof e[0] === 'number' ? [e] : [];
        } catch {
          return [];
        }
      });
      length = events.at(-1)?.[0] ?? 0;
      play();
    }, () => (loadError = t('rec.unreadable')));
    return () => {
      gone = true;
      stopTimer();
      unfollow();
      x.dispose();
      term = null;
    };
  });

  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
</script>

{#snippet listPart()}
  {#if keep !== null}
    <label class="field keep">
      <span>{t('rec.keep')}</span>
      <select value={keep} onchange={(e) => void setKeep(Number(e.currentTarget.value))} data-testid="rec-keep">
        {#each KEEP.includes(keep) ? KEEP : [...KEEP, keep].sort((a, b) => a - b) as d (d)}<option value={d}>{t('rec.keepDays', { n: d })}</option>{/each}
      </select>
    </label>
  {/if}
  {#if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else if !list}
    <p class="dim">{t('common.loading')}</p>
  {:else if !list.length}
    <p class="empty" data-testid="rec-none">{t('rec.none')}</p>
  {:else}
    <div class="list" data-testid="rec-list">
      {#each list as r (r.id)}
        <div class="list-item">
          <button class="main link-row" onclick={() => go(`/recordings/${r.id}`)} data-testid="rec-open">
            <span class="title">{r.title ?? r.hostName}</span>
            <span class="sub">{t('rec.meta', { host: r.hostName, user: r.user ?? '?', at: dateTime(r.startedAt) })} | {r.endedAt ? formatBytes(r.bytes) : t('rec.running')}</span>
          </button>
          <button class="icon-btn" aria-label={t('common.remove')} title={t('common.remove')} disabled={!r.endedAt} onclick={() => remove(r)} data-testid="rec-remove"><Icon name="trash" /></button>
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#if embedded}
  <div class="stack" data-testid="recordings-page">{@render listPart()}</div>
{:else}
<!-- A recording plays as wide as the page allows. -->
<div class="page" data-testid="recordings-page" data-content>
  <header class="topbar">
    <button class="icon-btn" aria-label={t('common.back')} onclick={() => up('/settings/recordings')}><Icon name="back" /></button>
    <h1>{current ? (current.title ?? current.hostName) : t('rec.title')}</h1>
  </header>
  {#if id === null}
    {@render listPart()}
  {:else if loadError}
    <LoadFailed message={loadError} onretry={load} />
  {:else}
    {#if current}<p class="dim small">{t('rec.meta', { host: current.hostName, user: current.user ?? '?', at: dateTime(current.startedAt) })}{current.truncated ? ` | ${t('rec.truncated')}` : ''}</p>{/if}
    <div class="screen" bind:this={el} data-testid="rec-screen" data-private></div>
    <div class="controls">
      {#if playing}
        <button class="btn small" onclick={pause} data-testid="rec-pause"><Icon name="stop" size={16} /> {t('rec.pause')}</button>
      {:else}
        <button class="btn small primary" onclick={play} data-testid="rec-play"><Icon name="play" size={16} /> {t('rec.play')}</button>
      {/if}
      <button class="btn small" onclick={() => (restart(), play())} data-testid="rec-restart"><Icon name="reload" size={16} /> {t('rec.restart')}</button>
      <label class="speed">
        <span class="sr-only">{t('rec.speed')}</span>
        <select bind:value={speed} aria-label={t('rec.speed')} data-testid="rec-speed">
          {#each [1, 2, 4, 8] as s (s)}<option value={s}>{s}x</option>{/each}
        </select>
      </label>
      <span class="dim small time" data-testid="rec-time">{clock(at)} / {clock(length)}</span>
      <span class="spacer"></span>
      <a class="btn small" href={`/api/recordings/${id}/cast`} download data-testid="rec-download"><Icon name="download" size={16} /> {t('rec.download')}</a>
    </div>
  {/if}
</div>
{/if}

<style>
  /* Apart from the list under it (the two touched, UI audit of 2.1.0). */
  .keep {
    margin-bottom: 16px;
  }
  /* Words-wide from a tablet up on its own page; a phone's whole width, as its other fields (report
     6bd934), and so in Settings at every width (report bc933c). */
  @media (min-width: 720px) {
    .keep:not(:global(.fill-controls) .keep) {
      max-width: 320px;
    }
  }
  .screen {
    min-height: 240px;
    overflow: auto;
    background: var(--bg-sunken);
    border-radius: 8px;
    padding: 6px;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .time {
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .link-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
</style>

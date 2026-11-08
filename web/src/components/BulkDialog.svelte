<script lang="ts">
  import { untrack } from 'svelte';
  import { errorMessage, post } from '../lib/api.js';
  import { plan, runAll, type BulkAction, type BulkRow } from '../lib/bulk.js';
  import { t } from '../lib/i18n/index.svelte.js';
  import { readFirst, updateServices } from '../lib/stackupdate.js';
  import { followOp } from '../lib/updates.svelte.js';
  import type { OpServerMessage } from '@burrow/shared';
  import Dialog from './Dialog.svelte';

  // Several picked containers at once: first what will happen (and what is
  // left alone, and why), then each container's progress. One failing does
  // not stop the others; each action is in the audit log as from its own page.

  let { action, rows, onclose, ondone, refresh }: { action: BulkAction | null; rows: BulkRow[]; onclose: () => void; ondone?: () => void; refresh?: () => Promise<number[]> } = $props();

  type State = 'wait' | 'busy' | 'ok' | 'fail' | 'started';
  // Live while the person decides (the list's state can be a moment
  // behind); fixed once they go, so what was asked stays what is shown
  // when the containers change (stopped ones are not "left alone" after).
  const live = $derived(action ? plan(action, rows) : null);
  let frozen = $state<ReturnType<typeof plan> | null>(null);
  let phase = $state<'confirm' | 'running' | 'done'>('confirm');
  const p = $derived(phase === 'confirm' ? live : frozen);
  let states = $state<Record<string, { s: State; msg?: string }>>({});
  const key = (r: { hostId: number; name: string }) => `${r.hostId}:${r.name}`;
  const label = $derived(action ? t(`bulk.do.${action}`) : '');
  // The list can be a snapshot behind (just after the last action here): read
  // again when the dialog opens, and only then can the person go.
  let ready = $state(false);
  let unread = $state(false);
  // A run goes on when the dialog is closed; it then no longer writes into
  // the one opened after it.
  let run = 0;

  $effect(() => {
    const a = action;
    untrack(() => {
      run++;
      phase = 'confirm';
      frozen = null;
      states = {};
      ready = !refresh;
      unread = false;
      if (a && refresh) {
        const mine = run;
        // A host that could not be read again: nothing done on what was seen before (AUDIT2 WEB-08).
        void refresh().then(
          (failed) => {
            if (mine !== run) return;
            const hosts = new Set(rows.map((r) => r.hostId));
            unread = failed.some((id) => hosts.has(id));
            ready = !unread;
          },
          () => mine === run && (unread = true),
        );
      }
    });
  });

  async function go() {
    if (!live || !action || !ready) return;
    frozen = live;
    const p = live;
    // What was asked, fixed now: closing and opening the dialog for another
    // action changed it for the requests still to go (a restart went on as stop).
    const act = action;
    const mine = ++run;
    const set = (k: string, v: { s: State; msg?: string }) => {
      if (mine === run) states[k] = v;
    };
    phase = 'running';
    states = Object.fromEntries(p.act.map((r) => [key(r), { s: 'wait' as State }]));
    if (act === 'update') {
      // Each stack's update followed to its end, its last line as the progress:
      // "done" only when it is (report c28922: "2 done" when they had only started).
      const ends: Promise<void>[] = [];
      for (const s of p.stacks) {
        const mine = p.act.filter((r) => r.hostId === s.hostId && r.project === s.project);
        for (const r of mine) set(key(r), { s: 'busy' });
        try {
          // What to read first (a breaking change) asks before this stack.
          if (!(await readFirst(s.hostId, s.images, s.project))) {
            for (const r of mine) set(key(r), { s: 'fail', msg: t('bulk.notNow') });
            continue;
          }
          const op = await updateServices(s.hostId, s.project, s.services);
          for (const r of mine) set(key(r), { s: 'started' });
          ends.push(
            new Promise<void>((resolve) => {
              let last = '';
              const stop = followOp(op, (m: OpServerMessage) => {
                // Dropped before the end: followOp connects again and the update goes on.
                if (m.t === 'error' && !m.message) return;
                if (m.t === 'output') {
                  last = m.d.trim().split('\n').filter(Boolean).pop() ?? last;
                  for (const r of mine) set(key(r), { s: 'started', msg: last });
                } else {
                  const ok = m.t === 'exit' && m.code === 0;
                  for (const r of mine) set(key(r), ok ? { s: 'ok' } : { s: 'fail', msg: m.t === 'error' && m.message ? m.message : last || t('bulk.updateFailed') });
                  stop();
                  resolve();
                }
              });
            }),
          );
        } catch (err) {
          for (const r of mine) set(key(r), { s: 'fail', msg: errorMessage(err) });
        }
      }
      await Promise.all(ends);
    } else {
      await runAll(p.act, async (r) => {
        set(key(r), { s: 'busy' });
        try {
          await post(`/api/docker/${r.hostId}/containers/${encodeURIComponent(r.name)}/action`, { action: act });
          set(key(r), { s: 'ok' });
        } catch (err) {
          set(key(r), { s: 'fail', msg: errorMessage(err) });
          throw err;
        }
      });
    }
    if (mine === run) phase = 'done';
    ondone?.();
  }

  const counts = $derived({ ok: Object.values(states).filter((x) => x.s === 'ok').length, fail: Object.values(states).filter((x) => x.s === 'fail').length });
</script>

<Dialog tour="bulk" open={action !== null} title={action ? t(`bulk.title.${action}`, { n: p?.act.length ?? 0 }) : ''} {onclose}>
  {#if p}
    <div class="stack" data-testid="bulk">
      {#if !p.act.length}
        <p class="dim">{t('bulk.nothing')}</p>
      {:else}
        <ul class="rows" data-testid="bulk-act">
          {#each p.act as r (key(r))}
            {@const st = states[key(r)]}
            <li>
              <span class="name mono">{r.name}</span>
              <span class="dim small">{r.hostName}</span>
              {#if st}<span class="st {st.s}" data-testid="bulk-state">{t(`bulk.state.${st.s}`)}</span>{/if}
              {#if st?.msg}<span class="msg small">{st.msg}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if p.skip.length}
        <p class="small skiphead">{t('bulk.leftAlone')}</p>
        <ul class="rows skip" data-testid="bulk-skip">
          {#each p.skip as s (key(s.row))}<li><span class="name mono">{s.row.name}</span><span class="dim small">{t(`bulk.skip.${s.reason}`)}</span></li>{/each}
        </ul>
      {/if}
      {#if phase === 'confirm' && unread}<p class="alert error small" data-testid="bulk-unread">{t('bulk.unread')}</p>
      {:else if phase === 'confirm' && !ready}<p class="small dim" role="status" data-testid="bulk-reading">{t('bulk.reading')}</p>{/if}
      {#if phase === 'done'}<p class="small" role="status" data-testid="bulk-done">{t('bulk.done', { ok: counts.ok, fail: counts.fail })}</p>{/if}
    </div>
  {/if}
  {#snippet actions()}
    {#if phase === 'confirm'}
      <button class="btn" onclick={onclose}>{t('common.cancel')}</button>
      <button class="btn" class:primary={action !== 'stop'} class:danger={action === 'stop'} disabled={!ready || !p?.act.length} onclick={go} data-testid="bulk-go">{label}</button>
    {:else}
      <button class="btn" disabled={phase === 'running'} onclick={onclose} data-testid="bulk-close">{t('common.close')}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 8px 12px;
  }
  .rows li + li {
    border-top: 1px solid var(--border-soft);
  }
  .name {
    font-size: 0.88rem;
  }
  .st {
    margin-left: auto;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-dim);
  }
  .st.ok,
  .st.started {
    color: var(--ok);
  }
  .st.fail {
    color: var(--danger);
  }
  .msg {
    flex-basis: 100%;
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .skiphead {
    margin: 4px 0 0;
    font-weight: 600;
  }
</style>

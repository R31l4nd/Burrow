<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n/index.svelte.js';
  import Mark from './Mark.svelte';

  // Signing in, setting up, accepting an invite: on a wide screen a dark
  // panel with the mark beside the form, on a phone the form alone.
  let { page, children }: { page?: string; children: Snippet } = $props();
</script>

<div class="auth-layout" data-page={page}>
  <aside class="auth-side" aria-hidden="true">
    <div class="auth-mark"><Mark size={36} /><span>Burrow</span></div>
    <p class="auth-line">{t('login.tagline')}</p>
    <span class="auth-host">{location.host}</span>
  </aside>
  <div class="center-screen">
    {@render children()}
  </div>
</div>

<style>
  .auth-layout {
    display: flex;
    min-height: 100dvh;
  }
  .auth-layout > .center-screen {
    flex: 1;
    min-width: 0;
  }
  .auth-side {
    display: none;
  }
  @media (min-width: 900px) {
    .auth-side {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      width: min(44%, 560px);
      padding: 48px;
      background: var(--side);
      color: #f2f5f3;
    }
    .auth-mark {
      display: flex;
      align-items: center;
      gap: 12px;
      font: 600 1.3rem var(--font);
    }
    .auth-line {
      max-width: 28ch;
      margin: 0;
      font-size: 1.5rem;
      line-height: 1.35;
      color: var(--side-text);
      text-wrap: balance;
    }
    .auth-host {
      font: 0.85rem var(--mono);
      color: var(--side-dim);
    }
  }
</style>

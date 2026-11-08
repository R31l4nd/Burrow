// Transient UI state shared across pages: toasts and the step-up prompt.

import { errorMessage } from './api.js';

// apart: left out of a report's picture (data-bug-ui); testid: for the tests.
export const toasts = $state<{ items: { id: number; text: string; kind: 'info' | 'error'; apart?: boolean; testid?: string }[] }>({ items: [] });
let nextId = 1;

export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  // Nothing to say (a step-up closed on purpose): no empty toast.
  if (!text) return;
  const id = nextId++;
  // The same words again (four changes saved in a row): one toast, shown
  // for longer, not a stack of copies.
  toasts.items = [...toasts.items.filter((t) => t.text !== text || t.kind !== kind), { id, text, kind }];
  setTimeout(() => {
    toasts.items = toasts.items.filter((t) => t.id !== id);
  }, kind === 'error' ? 6000 : 3000);
}

/**
 * A toast for as long as something takes (a report's picture being made):
 * no timer, gone when the function returned is called.
 */
export function toastWhile(text: string, opts: { apart?: boolean; testid?: string } = {}): () => void {
  const id = nextId++;
  toasts.items = [...toasts.items, { id, text, kind: 'info', ...opts }];
  return () => {
    toasts.items = toasts.items.filter((t) => t.id !== id);
  };
}

/** A toast no longer true (how to start a report, once the report starts): gone before its time. */
export function dropToast(text: string): void {
  toasts.items = toasts.items.filter((t) => t.text !== text);
}

/**
 * A load nobody waits for (a list read in the background, a count): a
 * failure is said once, not thrown into the page. Burrow being away
 * (offline, restarting) is one message however many loads failed.
 */
export function inBackground(p: Promise<unknown>): void {
  p.catch((err: unknown) => toast(errorMessage(err), 'error'));
}

/**
 * An action from a button or a checkbox: a failure is said, never lost in
 * the event handler (audit WP-08). True when it went through.
 */
export async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    toast(errorMessage(err), 'error');
    return false;
  }
}

/** A checkbox whose change was not saved: back as it was (the list itself did not change). */
export function undoCheck(box: HTMLInputElement, on: boolean): void {
  box.checked = !on;
}

/** why: what asks, when it is not something the person just pressed (the app's key at its start). */
export const stepUp = $state<{ open: boolean; resolve: ((ok: boolean) => void) | null; why: string | null }>({ open: false, resolve: null, why: null });

/** fn's step-up, if it needs one, says why (it was not asked for by a press). */
export async function stepUpBecause<T>(why: string, fn: () => Promise<T>): Promise<T> {
  stepUp.why = why;
  try {
    return await fn();
  } finally {
    stepUp.why = null;
  }
}

let pending: Promise<boolean> | null = null;

/**
 * Open the step-up dialog; resolves when the user confirms or cancels.
 * Requests that need it at the same time (a double tap, two calls on one
 * page) share one dialog: one confirmation lets them all retry. Before, a
 * second request cancelled the first one's dialog and that one failed with
 * "step up required" even though the user confirmed.
 */
export function requestStepUp(): Promise<boolean> {
  pending ??= new Promise<boolean>((resolve) => {
    stepUp.resolve = resolve;
    stepUp.open = true;
  }).finally(() => {
    pending = null;
  });
  return pending;
}

export function finishStepUp(ok: boolean): void {
  stepUp.open = false;
  const r = stepUp.resolve;
  stepUp.resolve = null;
  r?.(ok);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

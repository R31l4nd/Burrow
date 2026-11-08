// The keyboard's shortcuts, all in one list: the overview ("?" on a
// computer, or Settings) shows this, so what it says is what the code does.

import type { MessageKey } from './i18n/en.js';

export const shortcuts = $state({ open: false });

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Ctrl, or Cmd on a Mac, where the app takes either. */
export const MOD = mac ? 'Cmd' : 'Ctrl';

export interface Shortcut {
  keys: string[];
  what: MessageKey;
}

export function shortcutGroups(): { title: MessageKey; items: Shortcut[] }[] {
  return [
    {
      title: 'shortcuts.everywhere',
      items: [
        { keys: ['?'], what: 'shortcuts.overview' },
        { keys: ['Esc'], what: 'shortcuts.close' },
        { keys: [`${MOD}+Shift+B`], what: 'shortcuts.report' },
      ],
    },
    { title: 'nav.hosts', items: [{ keys: ['Enter'], what: 'shortcuts.hostsEnter' }] },
    {
      title: 'nav.terminal',
      items: [
        { keys: ['Enter'], what: 'shortcuts.send' },
        { keys: ['Shift+Enter'], what: 'shortcuts.newLine' },
        { keys: ['Ctrl+Shift+F'], what: 'shortcuts.termSearch' },
        { keys: ['Enter', 'Shift+Enter'], what: 'shortcuts.nextPrev' },
        { keys: ['Shift+Wheel'], what: 'shortcuts.ownHistory' },
      ],
    },
    {
      title: 'shortcuts.editor',
      items: [
        { keys: [`${MOD}+S`], what: 'shortcuts.save' },
        { keys: [`${MOD}+F`], what: 'shortcuts.find' },
        { keys: [`${MOD}+Z`, `${MOD}+Shift+Z`], what: 'shortcuts.undo' },
        { keys: [`${MOD}+Alt+G`], what: 'shortcuts.goToLine' },
      ],
    },
    {
      title: 'shortcuts.workspace',
      items: [
        { keys: ['F1', `${MOD}+Shift+P`], what: 'shortcuts.commands' },
        { keys: [`${MOD}+P`], what: 'shortcuts.quickOpen' },
        { keys: [`${MOD}+Shift+F`], what: 'shortcuts.wsSearch' },
      ],
    },
    {
      title: 'shortcuts.elsewhere',
      items: [
        { keys: ['Up', 'Down', 'Enter'], what: 'shortcuts.pick' },
        { keys: ['Left', 'Right'], what: 'shortcuts.photos' },
        { keys: ['Up', 'Down'], what: 'shortcuts.moveApp' },
        { keys: [`${MOD}+Shift+Left`, `${MOD}+Shift+Right`], what: 'shortcuts.moveTab' },
        { keys: ['F7', 'Shift+F7'], what: 'shortcuts.diffNext' },
      ],
    },
  ];
}

/** "?" opens the overview, unless typed into something (a field, the terminal, the editor). */
export function onShortcutKey(e: KeyboardEvent): void {
  if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest('input, textarea, select, [contenteditable], .xterm, .cm-editor, dialog[open]')) return;
  e.preventDefault();
  shortcuts.open = true;
}

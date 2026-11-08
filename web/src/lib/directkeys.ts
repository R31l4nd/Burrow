import { t } from './i18n/index.svelte.js';
import { toast } from './ui.svelte.js';

/**
 * A host deleted or pointed at another account: the phones' direct-route
 * keys came off the old account and went onto the new one. Where that
 * failed the server says so (AUDIT2 MON-01), and so does this.
 */
export function sayDirectKeys(answer: unknown): void {
  const d = (answer as { directKeys?: { left: string[]; notOn: string[] } } | null | undefined)?.directKeys;
  if (!d) return;
  if (d.left.length) toast(t('hosts.directKeysLeft', { names: d.left.join(', ') }), 'error');
  if (d.notOn.length) toast(t('hosts.directKeysNotOn', { names: d.notOn.join(', ') }), 'error');
}

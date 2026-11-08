import { t } from './i18n/index.svelte.js';
import { guardLeave } from './router.svelte.js';

// A form with a Save button (several fields that belong together), or an
// editor: while it holds changes that are not saved, a question before
// another page or a reload loses them. Settings saves single choices at once
// instead. The page is its whole address, query included: App makes a page
// anew for any other address (keyed on it), so another query or a page below
// would lose the changes as well and asks too (AUDIT2 PAGE-10).
export function warnUnsaved(dirty: () => boolean, page = location.hash.replace(/^#/, '') || '/'): void {
  const stays = (next: string) => next === page;
  $effect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    const stop = guardLeave((next) => (dirty() && !stays(next) ? t('common.unsavedLeave') : null));
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      stop();
    };
  });
}

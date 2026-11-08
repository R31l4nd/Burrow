import { t } from './i18n/index.svelte.js';

/**
 * A picture in rendered text (release notes, Markdown beside its file) that
 * does not load: its words and "could not be loaded" in its place, still a
 * link to it, not a tiny broken mark (UIB-12). An action on the element the
 * HTML is rendered into ("error" does not bubble: caught on the way down).
 */
export function brokenPictures(node: HTMLElement) {
  const onError = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !node.contains(img)) return;
    const name = img.alt.trim() || decodeURIComponent(img.src.split('/').pop()?.split('?')[0] ?? '') || t('common.picture');
    const note = document.createElement('span');
    note.className = 'pic-missing';
    note.dataset.testid = 'picture-missing';
    note.textContent = t('common.pictureMissing', { name });
    // Inside a link already (a picture that links to itself): the words in it; else a link of its own.
    if (img.closest('a') || !img.src) img.replaceWith(note);
    else {
      const a = document.createElement('a');
      a.href = img.src;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(note);
      img.replaceWith(a);
    }
  };
  node.addEventListener('error', onError, true);
  return { destroy: () => node.removeEventListener('error', onError, true) };
}

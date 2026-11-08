// Android's back button: first the dialog on top closes (as the system's
// own dialogs do), only then does the page go back. Without this, back went
// to the previous page with the dialog still open over it.

let opened = 0;
/** A dialog just opened: it is the one on top now, wherever it is in the page (AUDIT2 WEB-14: the last in the page closed first). */
export function markOpened(el: HTMLElement): void {
  el.dataset.openedAt = String(++opened);
}

/** Closes the dialog opened last, as Escape would (a form with changes asks first); false when none was open. */
export function closeTopDialog(): boolean {
  const open = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  if (!open.length) return false;
  const top = open.reduce((a, b) => (Number(b.dataset.openedAt ?? 0) >= Number(a.dataset.openedAt ?? 0) ? b : a));
  // Its own cancel first: a dialog with unsaved changes stops it and asks.
  if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
  return true;
}

// Asked by the Android app before it goes back in the page's history.
(window as unknown as { __burrowBack?: () => boolean }).__burrowBack = closeTopDialog;

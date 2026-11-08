import { android, type NativeDownload } from './android.js';

// The Android app's own downloads (a download link, an app update): their
// progress for the busy pill and Settings. The app sends the whole list at
// every change; an older app without them leaves it empty.

export const nativeDownloads = $state<{ items: NativeDownload[] }>({ items: [] });

// Only a list counts: anything else (an app that answers an unknown call
// with null) left the busy pill reading null and the page broken.
const take = (list: unknown) => (nativeDownloads.items = Array.isArray(list) ? (list as NativeDownload[]) : []);

if (android) {
  android.on('downloads', take);
  void android.downloads().then(take, () => {});
}

export const stopDownload = (id: number) => void android?.stopDownload(id).catch(() => {});
export const retryDownload = (id: number) => void android?.retryDownload(id).catch(() => {});

/** How far, in percent, or null when the size is not known. */
export const percentOf = (d: NativeDownload): number | null => (d.total > 0 ? Math.min(100, Math.round((d.done / d.total) * 100)) : null);

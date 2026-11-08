// Burrow's service worker, for push messages only (no caching: Burrow is
// always live). A message is encrypted for this browser; the browser hands
// it here decrypted. A tap opens the page it is about.

self.addEventListener('push', (event) => {
  let m = { title: 'Burrow', body: '', page: '/', priority: 3, topic: 'alerts' };
  try {
    m = { ...m, ...event.data.json() };
  } catch {
    // Not JSON: shown as it is.
    if (event.data) m.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(m.title, {
      body: m.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: `${m.topic}:${m.page}`,
      requireInteraction: m.priority >= 5,
      data: { page: m.page },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = `${self.location.origin}/#${event.notification.data?.page ?? '/'}`;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // An open Burrow goes to the page; else a new one opens.
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) return win.focus().then(() => win.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});

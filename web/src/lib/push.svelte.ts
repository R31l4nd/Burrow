import type { PushDevice } from '@burrow/shared';
import { android } from './android.js';
import { del, get, post } from './api.js';
import { locale } from './i18n/index.svelte.js';

// Burrow's own notifications on this device: in a browser through its push
// service (Web Push, public/push-sw.js), in the Android app through the
// phone's UnifiedPush distributor (Push.kt). Either way the device gives
// Burrow an address and keys; Burrow encrypts each message for it.

const KEY = 'burrow.pushDevice';

export const push = $state<{ on: boolean; busy: boolean }>({ on: false, busy: false });

/** Web Push in this browser (not in the app, whose WebView has none). */
export const browserPush = !android && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const canPush = !!android || browserPush;

const remembered = (): number | null => {
  try {
    return Number(localStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
};
const remember = (id: number | null) => {
  try {
    if (id) localStorage.setItem(KEY, String(id));
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered: this device shows as off after a reload.
  }
};

function label(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  const br = android ? 'Burrow app' : /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'Safari';
  return `${br} | ${os}`;
}

async function tell(kind: 'webpush' | 'unifiedpush', endpoint: string, p256dh: string, auth: string): Promise<void> {
  const d = await post<PushDevice>('/api/push/devices', { kind, label: label(), endpoint, p256dh, auth, lang: locale() });
  remember(d.id);
  push.on = true;
}

const b64u = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

/** Whether this device has it on (and, in the app, tells Burrow a changed address). */
// Checked against what Burrow has: a device removed there (another device, Settings -> Security)
// was put back by the app's next check, and a browser showed On for an address Burrow no longer
// sends to (AUDIT2 WEB-10).
export async function checkPush(): Promise<void> {
  const mine = remembered();
  const known = mine === null ? false : (await get<PushDevice[]>('/api/push/devices')).some((d) => d.id === mine);
  if (android) {
    const s = (await android.pushState()) as { url: string; p256dh: string; auth: string } | null;
    if (s && mine !== null && !known) {
      // Removed in Burrow on purpose: off here too, not registered again behind its back.
      remember(null);
      await android.pushUnregister().catch(() => {});
      push.on = false;
    } else if (s) await tell('unifiedpush', s.url, s.p256dh, s.auth);
    else push.on = false;
    return;
  }
  if (!browserPush) return;
  const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (sub && mine !== null && !known) {
    remember(null);
    await sub.unsubscribe().catch(() => false);
  }
  push.on = !!sub && known;
}

/** On: asks the person (the browser's or Android's question), then tells Burrow. */
export async function pushOn(): Promise<void> {
  const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
  if (android) {
    // The address comes as the "pushEndpoint" event (App.svelte listens).
    await android.pushRegister(publicKey);
    return;
  }
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('denied');
  const reg = await navigator.serviceWorker.register('/push-sw.js');
  await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await tell('webpush', sub.endpoint, b64u(sub.getKey('p256dh')), b64u(sub.getKey('auth')));
}

export async function pushOff(): Promise<void> {
  if (android) await android.pushUnregister();
  else {
    const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  }
  const id = remembered();
  if (id) await del(`/api/push/devices/${id}`).catch(() => {});
  remember(null);
  push.on = false;
}

/** The app's distributor gave a (new) address, or took it back. */
export async function pushEndpoint(s: { url: string; p256dh: string; auth: string } | null): Promise<void> {
  if (s) await tell('unifiedpush', s.url, s.p256dh, s.auth);
  else push.on = false;
}

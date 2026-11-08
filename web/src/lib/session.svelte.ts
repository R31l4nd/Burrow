import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthState, PasskeyInfo } from '@burrow/shared';
import { android } from './android.js';
import { get, newAccount, post, put } from './api.js';
import { dropAll } from './termpool.js';
import { t } from './i18n/index.svelte.js';
import { stepUpBecause } from './ui.svelte.js';

// The signed-in state for the whole app. Components read `session.state`;
// everything that changes it goes through the functions below.

// keptFor: signed out while a page held work not saved yet (the sign-in ran out, or was ended
// elsewhere): the account whose page stays on screen, the sign-in over it, so the work can be saved
// once signed in again (App.svelte). Its things are kept until another account signs in.
export const session = $state<{ state: AuthState | null; keptFor: number | null }>({ state: null, keptFor: null });

/** `keep`: false after signing out on purpose (no page kept with the sign-in over it). */
export async function refreshSession(keep = true): Promise<AuthState> {
  const s = await get<AuthState>('/api/auth/state');
  setSession(s, keep);
  return s;
}

// What each part of the app keeps for the signed-in account (a report's
// screenshot and recording, copied files, transfers, activity): cleared when
// another account, or none, takes the screen. Signing out left it for the
// next one at the same page (AUDIT2 WEB-01).
const resets: (() => void)[] = [];
export function onAccountChange(reset: () => void): void {
  resets.push(reset);
}
let account: number | null = null;
// Set by the app shell: whether a page holds work not saved yet (lib/router.svelte.ts).
let unsavedHere: () => boolean = () => false;
export function keepWhenUnsaved(fn: () => boolean): void {
  unsavedHere = fn;
}

export function setSession(s: AuthState, keep = true): void {
  const now = s.user?.id ?? null;
  // Signed out with unsaved work on the page: it is kept, not torn down with all of the account's
  // things (an editor's text was lost without a word, audit 2026-11-05).
  if (keep && now === null && account !== null && !s.setupRequired && (session.keptFor === account || unsavedHere())) {
    session.keptFor = account;
    session.state = s;
    return;
  }
  session.keptFor = null;
  if (now !== account) {
    newAccount();
    // Signed out, or another account: no terminal kept connected, nothing of the last one kept.
    if (account !== null) {
      dropAll();
      for (const r of resets) r();
    }
    account = now;
  }
  session.state = s;
}

type Options = { challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };
type RegOptions = { challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] };

export async function passkeyLogin(): Promise<AuthState> {
  const { challengeId, options } = await post<Options>('/api/auth/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  const s = await post<AuthState>('/api/auth/passkey/verify', { challengeId, response });
  setSession(s);
  return s;
}

export async function passkeyStepUp(): Promise<AuthState> {
  const { challengeId, options } = await post<Options>('/api/auth/step-up/passkey/options');
  const response = await startAuthentication({ optionsJSON: options });
  const s = await post<AuthState>('/api/auth/step-up/passkey/verify', { challengeId, response });
  setSession(s);
  return s;
}

export async function registerPasskey(name: string): Promise<PasskeyInfo> {
  const { challengeId, options } = await post<RegOptions>('/api/account/passkeys/options');
  const response = await startRegistration({ optionsJSON: options });
  const pk = await post<PasskeyInfo>('/api/account/passkeys/verify', { challengeId, response, name });
  await refreshSession();
  return pk;
}

/** A readable default name for a new passkey, from the user agent. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' | ');
}

// ---- the Android app's device key (fingerprint), see lib/android.ts

async function signChallenge(deviceId: number, purpose: 'login' | 'step-up'): Promise<AuthState> {
  const { challengeId, message } = await post<{ challengeId: string; message: string }>('/api/auth/device/challenge', { deviceId, purpose });
  const { signature } = await android!.sign(message);
  return post<AuthState>('/api/auth/device/verify', { challengeId, signature });
}

export async function deviceLogin(deviceId: number): Promise<AuthState> {
  const s = await signChallenge(deviceId, 'login');
  setSession(s);
  return s;
}

export async function deviceStepUp(deviceId: number): Promise<AuthState> {
  const s = await signChallenge(deviceId, 'step-up');
  setSession(s);
  return s;
}

/**
 * In the paired app: report its direct-route SSH key (a no-op when Burrow
 * has it already) and refresh the offline cache. Best effort: the direct
 * route is for when Burrow is away, so nothing here may get in the way.
 */
export async function syncDirectRoute(): Promise<void> {
  if (!android || !session.state?.deviceId) return;
  try {
    const { publicKey } = await android.sshPublicKey();
    // A changed key needs a fresh step-up (the server asks only then): at the app's start, unasked, so it says why.
    await stepUpBecause(t('stepup.whyDirectKey'), () => put('/api/account/devices/current/ssh-key', { publicKey }));
    await android.syncDirect();
  } catch {
    // Next time.
  }
}

/** Pair this app with a code from a signed-in browser; signs the app in. */
export async function pairWithCode(code: string, name: string): Promise<AuthState> {
  const { publicKey } = await android!.createKey();
  const r = await post<{ deviceId: number; state: AuthState }>('/api/auth/pair', { code, name, publicKey });
  await android!.saveDevice(r.deviceId);
  setSession(r.state);
  void syncDirectRoute();
  return r.state;
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

// A virtual WebAuthn authenticator (Chrome DevTools Protocol), so passkey
// registration and sign-in run without hardware. The credential created in
// the setup project is saved and loaded into the later projects' browsers.

// Beside the test results, not in them: Playwright empties those at each run (E2E_REUSE needs it).
const STATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.state');
/**
 * One passkey per browser that runs at the same time (playwright.config.ts
 * workers): a passkey's signature counter only goes up, and two browsers
 * signing in with one copy of it at once made the server refuse the second.
 */
export const SLOTS = 6;
const statePath = (slot: number) => join(STATE_DIR, slot === 0 ? 'passkey.json' : `passkey-${slot}.json`);
/** This worker's passkey: by the place it runs in among the ones running now. */
const mySlot = () => {
  try {
    return test.info().parallelIndex % SLOTS;
  } catch {
    return 0;
  }
};

export interface Authenticator {
  cdp: CDPSession;
  id: string;
}

export async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

export async function saveCredential(a: Authenticator, slot = mySlot()): Promise<void> {
  const { credentials } = await a.cdp.send('WebAuthn.getCredentials', { authenticatorId: a.id });
  if (credentials.length !== 1) throw new Error(`expected one passkey, found ${credentials.length}`);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(slot), JSON.stringify(credentials[0]));
}

export async function loadCredential(a: Authenticator, slot = mySlot()): Promise<void> {
  const credential = JSON.parse(readFileSync(statePath(slot), 'utf8'));
  await a.cdp.send('WebAuthn.addCredential', { authenticatorId: a.id, credential });
}

export async function signIn(page: Page): Promise<Authenticator> {
  const a = await addAuthenticator(page);
  await loadCredential(a);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await page.getByRole('heading', { name: 'Hosts' }).waitFor();
  // The authenticator's signature counter went up; the server rejects a
  // counter that goes backwards (a cloned key), so keep the saved copy current.
  await saveCredential(a);
  return a;
}

/**
 * Fill the first field of a form that was just mounted. Rarely, a render
 * right after mount resets the field Playwright has already filled (a person
 * cannot type that fast); fill again until the value holds.
 */
export async function fillSettled(field: Locator, value: string): Promise<void> {
  await expect(async () => {
    if ((await field.inputValue()) !== value) await field.fill(value);
    await field.page().waitForTimeout(150);
    expect(await field.inputValue()).toBe(value);
  }).toPass({ timeout: 5000 });
}

/**
 * A fresh confirmation (step-up) with the passkey, without the dialog: for
 * a long test that would otherwise run past the fifteen minutes one lasts
 * (the tour, on a slow machine). The same ceremony the app does, in the page.
 */
export async function stepUpAgain(page: Page, a: Authenticator): Promise<void> {
  await page.evaluate(async () => {
    const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
    const u64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const post = (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
    const { challengeId, options } = await post('/api/auth/step-up/passkey/options');
    const cred = (await navigator.credentials.get({
      publicKey: { ...options, challenge: b64(options.challenge), allowCredentials: (options.allowCredentials ?? []).map((c: { id: string; type: 'public-key' }) => ({ ...c, id: b64(c.id) })) },
    })) as PublicKeyCredential;
    const r = cred.response as AuthenticatorAssertionResponse;
    const state = await post('/api/auth/step-up/passkey/verify', {
      challengeId,
      response: { id: cred.id, rawId: u64(cred.rawId), type: cred.type, clientExtensionResults: {}, response: { clientDataJSON: u64(r.clientDataJSON), authenticatorData: u64(r.authenticatorData), signature: u64(r.signature), userHandle: r.userHandle ? u64(r.userHandle) : undefined } },
    });
    if (!state.user) throw new Error(`step-up failed: ${JSON.stringify(state)}`);
  });
  await saveCredential(a);
}

/**
 * A host's id by its name, from the instance itself: failing when it is not
 * there. A fixed id 1 acted on whatever host an earlier run or spec made
 * first (AUDIT2 TEST-04).
 */
export async function hostNamed(page: Page, name: string): Promise<number> {
  const hosts = await page.evaluate(async () => (await (await fetch('/api/hosts')).json()) as { id: number; name: string }[]);
  const h = hosts.find((x) => x.name === name);
  if (!h) throw new Error(`no host named ${name}`);
  return h.id;
}

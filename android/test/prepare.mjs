// Prepares the Burrow test instance for the Android device test: finishes
// setup (password + TOTP), adds the test sshd host and the fake app, and
// makes a pairing code for the app. Prints JSON for scripts/android-test.sh.
//   node prepare.mjs <url> <origin> <setup-token> <sshd-host> <sshd-port> <app-url>
import { generate } from 'otplib';

const [url, origin, token, sshd, sshdPort, appUrl] = process.argv.slice(2);
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { origin, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

await call('POST', '/api/setup/begin', { token, username: 'admin' });
await call('PUT', '/api/account/password', { password: 'correct horse battery staple' });
const { secret } = await call('POST', '/api/account/totp/setup');
await call('POST', '/api/account/totp/confirm', { code: await generate({ secret }) });
await call('POST', '/api/setup/finish');

const host = await call('POST', '/api/hosts', { name: 'phone-test', address: sshd, port: Number(sshdPort), username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
const r = await call('POST', `/api/hosts/${host.id}/test`);
if (r.status === 'unknown_host_key') {
  await call('POST', `/api/hosts/${host.id}/trust`, { fingerprint: r.fingerprint });
  // Test again now that the key is trusted: that detects Docker.
  await call('POST', `/api/hosts/${host.id}/test`);
}
const app = await call('POST', '/api/apps', { name: 'Fake app', url: appUrl });
const { code } = await call('POST', '/api/account/devices/pair-code');
// A second one for the release before this one, paired before the update.
const { code: upgradeCode } = await call('POST', '/api/account/devices/pair-code');

// The admin session goes along: the direct-route step later needs it.
// The authenticator's secret too: the direct-route step steps up again with it,
// as the session may be older than the step-up's 15 minutes by then.
console.log(JSON.stringify({ pairCode: code, upgradeCode, hostId: host.id, appId: app.id, appUrl, cookie, totp: secret }));

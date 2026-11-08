// The device test's middle step: as the admin in a browser would, give the
// paired phone the direct route to the test host (Settings -> Android app ->
// Direct route). Burrow installs the phone's key on the host over SSH.
//   node enable-direct.mjs <url> <origin> <admin-cookie> <host-id> <totp-secret>
import { generate } from 'otplib';

const [url, origin, cookie, hostId, totp] = process.argv.slice(2);
const headers = { origin, cookie, 'content-type': 'application/json' };
// A fresh step-up first: with the tablet and dark passes before it, the admin
// session is older than the step-up's 15 minutes, and Burrow refused this with
// step_up_required. A code is taken once (replay protection): one already used
// in this half minute waits for the next.
for (let tries = 0; ; tries++) {
  const res = await fetch(`${url}/api/auth/step-up/totp`, { method: 'POST', headers, body: JSON.stringify({ code: await generate({ secret: totp }) }) });
  if (res.ok) break;
  if (tries >= 2) throw new Error(`step-up refused: ${res.status} ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 31_000));
}
const devices = await (await fetch(`${url}/api/account/devices`, { headers })).json();
// The newest: the app paired before an update (scripts/android-test.sh) is there too.
const phone = devices.filter((d) => d.hasSshKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
if (!phone) throw new Error(`no phone has reported its SSH key: ${JSON.stringify(devices)}`);
const res = await fetch(`${url}/api/account/devices/${phone.id}/hosts`, { method: 'PUT', headers, body: JSON.stringify({ hostIds: [Number(hostId)] }) });
const body = await res.json();
if (!res.ok || !body.results.every((r) => r.ok)) throw new Error(`enabling failed: ${res.status} ${JSON.stringify(body)}`);
console.log(`direct route: ${phone.name} -> host ${hostId}`);

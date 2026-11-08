#!/usr/bin/env python3
"""On the fresh machine: what someone does after INSTALL.md, through Burrow's
API - the setup wizard (password + authenticator app), then this machine as
the first host, its host key confirmed, and its containers read over SSH.

    python3 first-signin.py <setup-token> <gateway-ip> <ssh-password>
"""
import base64, hashlib, hmac, json, struct, sys, time, urllib.request

BASE = 'http://127.0.0.1:8080'
ORIGIN = 'http://localhost:8080'
token, gateway, ssh_password = sys.argv[1:4]
# The session cookie, kept by hand: it is set for "localhost" over plain http.
cookie = {}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else (b'{}' if method != 'GET' else None)
    headers = {'content-type': 'application/json', 'origin': ORIGIN}
    if cookie:
        headers['cookie'] = '; '.join(f'{k}={v}' for k, v in cookie.items())
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            for c in r.headers.get_all('set-cookie') or []:
                k, v = c.split(';', 1)[0].split('=', 1)
                cookie[k] = v
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path}: {e.code} {e.read().decode()}')


def totp(secret):
    key = base64.b32decode(secret + '=' * (-len(secret) % 8))
    h = hmac.new(key, struct.pack('>Q', int(time.time()) // 30), hashlib.sha1).digest()
    o = h[-1] & 15
    return str((struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


api('POST', '/api/setup/begin', {'token': token, 'username': 'admin'})
api('PUT', '/api/account/password', {'password': 'a long password for this test'})
secret = api('POST', '/api/account/totp/setup')['secret']
api('POST', '/api/account/totp/confirm', {'code': totp(secret)})
done = api('POST', '/api/setup/finish')
assert len(done['recoveryCodes']) == 10, done
state = api('GET', '/api/auth/state')
assert state['user']['username'] == 'admin' and not state['user']['incomplete'], state
print('signed in as admin, ten recovery codes')

host = api('POST', '/api/hosts', {'name': 'this-machine', 'address': gateway, 'username': 'burrow', 'authMethod': 'password', 'password': ssh_password})
r = api('POST', f"/api/hosts/{host['id']}/test")
if r['status'] == 'unknown_host_key':
    print('host key', r['fingerprint'])
    api('POST', f"/api/hosts/{host['id']}/trust", {'fingerprint': r['fingerprint']})
    r = api('POST', f"/api/hosts/{host['id']}/test")
assert r['status'] == 'ok', r
assert r['facts']['hasDocker'], r
print('first host:', r['facts']['os'], '- Docker reachable')
containers = api('GET', f"/api/docker/{host['id']}/containers")
names = [c['name'] for c in containers['containers']]
assert 'burrow' in names, names
print('containers:', ', '.join(names))
stats = api('GET', f"/api/hosts/{host['id']}/stats")
print(f"host statistics: {stats['cores']} cores, {len(stats['disks'])} disks")
print('FRESH INSTALL OK')

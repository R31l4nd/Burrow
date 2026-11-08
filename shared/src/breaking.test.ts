import { describe, expect, it } from 'vitest';
import { compareVersions, highestVersion, imageVersion, isPrerelease, needsReading, onLine, releaseFlags, releaseImageAllowed, tagLine, versionParts } from './breaking.js';

describe('release notes that ask for attention', () => {
  it('finds breaking changes by their words and by a heading', () => {
    const f = releaseFlags('## Breaking changes\n- The `DB_HOST` variable is now `DATABASE_HOST`.\n\n## Fixes\n- Faster start', 'v2.1.0', 'v2.0.3');
    expect(f.breaking).toEqual(['The `DB_HOST` variable is now `DATABASE_HOST`.']);
    expect(f.major).toBe(false);
    expect(releaseFlags('- **BREAKING:** config moved to /config', '1.4.0', '1.3.2').breaking).toEqual(['BREAKING: config moved to /config']);
    expect(releaseFlags('- feat(api)!: drop the v1 endpoints', '1.4.0', '1.3.2').breaking).toHaveLength(1);
    expect(releaseFlags('Action required: run the migration once.', '1.4.0', '1.3.2').breaking).toHaveLength(1);
  });

  it('keeps security and deprecation notes apart, and ordinary notes out', () => {
    const f = releaseFlags('- Fixes CVE-2026-1234\n- The old theme is deprecated\n- New icons', '1.2.1', '1.2.0');
    expect(f.breaking).toEqual([]);
    expect(f.important).toEqual(['Fixes CVE-2026-1234', 'The old theme is deprecated']);
    expect(needsReading(f)).toBe(false);
  });

  it('counts a new major version (and 0.x minor) as needing a read', () => {
    expect(releaseFlags('Lots of work.', 'v3.0.0', 'v2.9.4').major).toBe(true);
    expect(releaseFlags('', '0.8.0', '0.7.5').major).toBe(true);
    expect(releaseFlags('', '1.8.0', '1.7.5').major).toBe(false);
    expect(needsReading(releaseFlags('', 'v3.0.0', 'v2.9.4'))).toBe(true);
    expect(versionParts('release-2.3')).toEqual([2, 3, 0]);
    expect(versionParts('latest')).toBeNull();
  });

  it('a sub-heading inside "Breaking changes" stays in it; the next heading at its level ends it (AUDIT2 AI-11)', () => {
    const f = releaseFlags('## Breaking changes\n### Configuration\n- Set APP_URL before starting\n## Fixes\n- Faster start', 'v2.0.1', 'v2.0.0');
    expect(f.breaking).toEqual(['Set APP_URL before starting']);
  });
});

describe('pictures in release notes', () => {
  it("only GitHub's own image hosts, over https, without a user or a port", () => {
    for (const good of [
      'https://github.com/user-attachments/assets/0f1e2d3c-aaaa-bbbb',
      'https://github.com/someone/burrow/assets/123/screen.png',
      'https://github.com/someone/burrow/raw/main/docs/shot.png?raw=true',
      'https://private-user-images.githubusercontent.com/1/2.png?jwt=x',
      'https://raw.githubusercontent.com/someone/burrow/main/a.png',
    ]) expect(releaseImageAllowed(good), good).toBe(true);
    for (const bad of [
      'http://github.com/user-attachments/assets/abc',
      'https://github.com/someone/burrow/blob/main/a.png',
      'https://github.com/login',
      'https://user@github.com/user-attachments/assets/abc',
      'https://github.com:8443/user-attachments/assets/abc',
      'https://githubusercontent.com.evil.example/a.png',
      'https://evil.example/a.png',
      'javascript:alert(1)',
    ]) expect(releaseImageAllowed(bad), bad).toBe(false);
  });
});

describe('which version an image runs (report 9190c5)', () => {
  it('takes the label when it is a version, cleaned of a build and an architecture', () => {
    expect(imageVersion('ghcr.io/org/app:latest', 'v2.3.1')).toBe('v2.3.1');
    expect(imageVersion('ghcr.io/org/app:latest', '1.1.1-amd64')).toBe('1.1.1');
    expect(imageVersion('org/app:latest', '0.26.2.0+e472ecd7')).toBe('0.26.2.0');
    expect(imageVersion('lscr.io/linuxserver/app:latest', 'v1.6.2-ls369')).toBe('v1.6.2-ls369');
  });

  it('a label that is no version ("latest", "main") does not count', () => {
    expect(imageVersion('org/app:latest', 'latest')).toBeNull();
    expect(imageVersion('org/app:latest', 'main')).toBeNull();
    expect(imageVersion('org/app:master-omnibus', 'master-omnibus')).toBeNull();
  });

  it('else the image own *_VERSION variable, as the official images set it', () => {
    expect(imageVersion('postgres:15-alpine', null, ['PATH=/usr/bin', 'GOSU_VERSION=1.17', 'PG_MAJOR=15', 'PG_VERSION=15.10'])).toBe('15.10');
    expect(imageVersion('redis:8-alpine', '', ['REDIS_VERSION=8.0.2'])).toBe('8.0.2');
    expect(imageVersion('valkey/valkey:9', null, ['VALKEY_VERSION=9.0.6'])).toBe('9.0.6');
    expect(imageVersion('nginx:alpine', null, ['NGINX_VERSION=1.27.3', 'NJS_VERSION=0.8.9'])).toBe('1.27.3');
    // Another program's version is not the image's.
    expect(imageVersion('org/app:latest', null, ['GOSU_VERSION=1.17', 'NODE_VERSION=22.1.0'])).toBeNull();
  });

  it('else the tag, when that is a whole version', () => {
    expect(imageVersion('nginx:1.27.3-alpine', null)).toBe('1.27.3');
    expect(imageVersion('org/app:v2.1', null)).toBe('2.1');
    expect(imageVersion('valkey/valkey:9', null)).toBeNull();
    expect(imageVersion('org/app:latest', null)).toBeNull();
  });

  it('the line a tag follows, and whether a release is on it', () => {
    expect(tagLine('valkey/valkey:9')).toEqual([9]);
    expect(tagLine('postgres:15-alpine')).toEqual([15]);
    expect(tagLine('nginx:1.25')).toEqual([1, 25]);
    expect(tagLine('org/app:latest')).toBeNull();
    expect(onLine('9.0.7', [9])).toBe(true);
    expect(onLine('8.0.12', [9])).toBe(false);
  });

  it('a maintenance release of an older line is no new major version', () => {
    expect(compareVersions('9.0.7', '8.0.12')).toBeGreaterThan(0);
    expect(highestVersion(['8.0.12', '9.0.6', 'nightly', '8.1.4'])).toBe('9.0.6');
    expect(releaseFlags('', '9.0.7', highestVersion(['8.0.12', '9.0.6'])).major).toBe(false);
    expect(releaseFlags('', '8.0.12', highestVersion(['9.0.6', '8.0.11'])).major).toBe(false);
    expect(releaseFlags('', '9.0.0', highestVersion(['8.1.4', '8.0.11'])).major).toBe(true);
  });
});

describe('pre-releases by their tag (report 0d33eb)', () => {
  it('rc, beta, alpha and the like after a version; a plain version or a word without one is none', () => {
    for (const t of ['v3.4.0-rc.1', 'v3.4.0-rc.2', '2.0.0-beta1', '2.0.0beta2', '1.0.0-alpha', '5.1-RC1', 'v1.2.0-preview.3', '1.0.0-dev', '0.9.0-nightly.20261101', 'v2.0.0-pre']) expect(isPrerelease(t), t).toBe(true);
    for (const t of ['v3.3.6', '1.2.3', 'release-2.3.1', '17-3.5-alpine', 'v1.2.3-openvino', 'v2.0.0-preventive', '1.0.0-release', 'latest']) expect(isPrerelease(t), t).toBe(false);
  });
});

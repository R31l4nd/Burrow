import { describe, expect, it } from 'vitest';
import { newerTag, retagCompose, tagShape, updateLevel } from './tags.js';

describe('newer tags', () => {
  it('the newest of the same shape: as many numbers, the same suffix kind, the same v', () => {
    const tags = ['1.25', '1.26', '1.27', '1.27.1', '1.28-rc1', '1.27-alpine', 'latest', 'mainline', 'v1.29', '2'];
    expect(newerTag('1.25', tags)).toBe('1.27');
    expect(newerTag('1.25.3', ['1.25.3', '1.25.4', '1.26.0', '1.27'])).toBe('1.26.0');
    expect(newerTag('1.25-alpine', [...tags, '1.26-alpine'])).toBe('1.27-alpine');
    expect(newerTag('v1.2', ['v1.3', '1.9'])).toBe('v1.3');
  });

  it('a release candidate or another suffix never counts as newer than a plain tag', () => {
    expect(newerTag('1.25', ['1.26-rc1', '1.26-alpine', '1.26-beta'])).toBeNull();
  });

  it('numbers in the suffix: the same kind matches, and break a tie', () => {
    expect(newerTag('1.25-alpine3.19', ['1.27-alpine3.20', '1.27-alpine3.21', '1.26-alpine3.19'])).toBe('1.27-alpine3.21');
    expect(newerTag('3.12-alpine3.19', ['3.12-alpine3.20'])).toBe('3.12-alpine3.20');
  });

  it('nothing newer, not a version, or a date for a version: null', () => {
    expect(newerTag('1.27', ['1.25', '1.27'])).toBeNull();
    expect(newerTag('latest', ['1.27'])).toBeNull();
    expect(newerTag('stable-slim', ['1.27'])).toBeNull();
    expect(newerTag('2', ['3', '20240101'])).toBe('3');
    expect(newerTag('20240101', ['20250101', '3'])).toBe('20250101');
  });

  it('the labels choose which tags count', () => {
    const tags = ['16.2', '16.4', '17.0'];
    expect(newerTag('16.2', tags)).toBe('17.0');
    expect(newerTag('16.2', tags, { include: (t) => t.startsWith('16.') })).toBe('16.4');
    expect(newerTag('16.2', tags, { exclude: (t) => t.startsWith('17') })).toBe('16.4');
  });

  it('shapes', () => {
    expect(tagShape('1.25-alpine3.19')).toMatchObject({ v: false, nums: [1, 25], kind: '-alpine#.#', suffixNums: [3, 19] });
    expect(tagShape('sha-abc')).toBeNull();
  });
});

describe('retagging a compose file', () => {
  const file = ['services:', '  web:', '    image: nginx:1.25 # the site', '  db:', "    image: 'postgres:16.2'", '  other:', '    image: nginx:1.25-alpine', ''].join('\n');

  it("changes the image: line that names the image exactly, quotes and comments kept", () => {
    expect(retagCompose(file, 'nginx:1.25', '1.27')).toBe(file.replace('nginx:1.25 #', 'nginx:1.27 #'));
    expect(retagCompose(file, 'postgres:16.2', '16.4')).toContain("image: 'postgres:16.4'");
    expect(retagCompose(file, 'nginx:1.25-alpine', '1.27-alpine')).toContain('image: nginx:1.27-alpine\n');
    expect(retagCompose(file, 'nginx:1.25-alpine', '1.27-alpine')).toContain('image: nginx:1.25 #');
  });

  it('a registry with a port, and an image named some other way', () => {
    expect(retagCompose('services:\n  app:\n    image: localhost:5001/app:1.0\n', 'localhost:5001/app:1.0', '1.2')).toBe('services:\n  app:\n    image: localhost:5001/app:1.2\n');
    expect(retagCompose('    image: nginx:${TAG}\n', 'nginx:1.25', '1.27')).toBeNull();
    expect(retagCompose(file, 'nginx', '1.27')).toBeNull();
  });
});

describe('how big an update is', () => {
  it('major, minor or patch from the running version to the newest release; null when it cannot be read', () => {
    expect(updateLevel('1.2.3', ['1.2.4'])).toBe('patch');
    expect(updateLevel('v1.2.3', ['v1.2.5', 'v1.2.4'])).toBe('patch');
    expect(updateLevel('1.2.3', ['1.3.0', '1.2.4'])).toBe('minor');
    expect(updateLevel('1.2.3', ['2.0.0', '1.3.0'])).toBe('major');
    expect(updateLevel('10.4', ['10.5'])).toBe('minor');
    expect(updateLevel(null, ['1.0.0'])).toBeNull();
    expect(updateLevel('latest', ['1.0.0'])).toBeNull();
    expect(updateLevel('1.2.3', ['nightly'])).toBeNull();
    expect(updateLevel('1.2.3', ['1.2.3'])).toBeNull();
  });

  it("only a service's own image: key, not an image: line deeper in it or in a script (AUDIT2 AI-10)", () => {
    const f = [
      'x-run: &run',
      '  command: |',
      '    image: nginx:1.25',
      'services:',
      '  web:',
      '    image: nginx:1.25',
      '    environment:',
      '      image: nginx:1.25',
      '    labels:',
      '      - "image: nginx:1.25"',
      '    entrypoint: >',
      '      sh -c "echo',
      '      image: nginx:1.25"',
      '  sidecar:',
      '    build: .',
      '    healthcheck:',
      '      test: |',
      '        image: nginx:1.25',
      'volumes:',
      '  image: nginx:1.25',
      '',
    ].join('\n');
    const out = retagCompose(f, 'nginx:1.25', '1.27')!;
    expect(out.split('\n').filter((l) => l.includes('nginx:1.27'))).toEqual(['    image: nginx:1.27']);
    expect(out.split('\n')[5]).toBe('    image: nginx:1.27');
    expect(retagCompose('environment:\n  image: nginx:1.25\n', 'nginx:1.25', '1.27')).toBeNull();
  });
});


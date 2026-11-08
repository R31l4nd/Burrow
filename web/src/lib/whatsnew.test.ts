import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { versionCode, whatsNew } from './whatsnew.js';

const VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('what is new in a release (report 4c30b4)', () => {
  it('turns a version into its Android version code', () => {
    expect(versionCode('2.3.2')).toBe(20302);
    expect(versionCode('10.0.0')).toBe(100000);
    expect(versionCode('dev')).toBeNull();
    expect(versionCode('2.3')).toBeNull();
  });

  it('has a few sentences for this release in English and Dutch', () => {
    const en = whatsNew(VERSION, 'en');
    const nl = whatsNew(VERSION, 'nl');
    expect(en).toBeTruthy();
    expect(nl).toBeTruthy();
    expect(nl).not.toBe(en);
  });

  it('has nothing for a build of its own or a version without notes', () => {
    expect(whatsNew('dev', 'nl')).toBeNull();
    expect(whatsNew('0.0.1', 'en')).toBeNull();
  });
});

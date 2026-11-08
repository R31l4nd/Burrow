import { describe, expect, it } from 'vitest';
import { accessFolder, accessFolders, folderAllowed } from './files.js';

// The folders an operator may open (A3-SRV-01): the longest folder that holds a path decides, a
// denied one on a tie, none: closed.
describe('folder rules', () => {
  const rule = { allow: ['/srv', '/srv/secret/public', '/data/media'], deny: ['/srv/secret', '/data/media'] };

  it('the longest folder decides; a denied one where both lists name it; nothing named, nothing open', () => {
    expect(folderAllowed('/srv/app/compose.yaml', rule)).toBe(true);
    expect(folderAllowed('/srv', rule)).toBe(true);
    expect(folderAllowed('/srv/secret/key.pem', rule)).toBe(false);
    expect(folderAllowed('/srv/secret/public/readme', rule)).toBe(true);
    expect(folderAllowed('/data/media/film.mkv', rule)).toBe(false);
    expect(folderAllowed('/srvx/other', rule)).toBe(false);
    expect(folderAllowed('/etc/hostname', rule)).toBe(false);
    expect(folderAllowed('/etc/hostname', { allow: [], deny: [] })).toBe(false);
    expect(folderAllowed('/etc/hostname', { allow: ['/'], deny: [] })).toBe(true);
    expect(folderAllowed('/etc/hostname', { allow: ['/'], deny: ['/etc'] })).toBe(false);
  });

  it('keeps folders normalised, once each', () => {
    expect(accessFolder('/srv/./app//')).toBe('/srv/app');
    expect(accessFolder('/srv/app/../../etc')).toBe('/etc');
    expect(accessFolder('/../..')).toBe('/');
    expect(accessFolders(['/b/', '/a', '/b', '/a/.'])).toEqual(['/a', '/b']);
  });
});

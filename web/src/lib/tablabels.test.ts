import { describe, expect, it } from 'vitest';
import { fileLabels } from './tablabels.js';

describe('labels of open files', () => {
  it('two files of the same name in two workspace folders: the shortest part of each folder that tells them apart, the folder name first (report 9d710d)', () => {
    const l = fileLabels(['/data/docker-compose.yml', '/hdd/AppData/docker-compose.yml', '/data/.env'], ['/data', '/hdd']);
    expect(l.get('/data/docker-compose.yml')).toEqual({ name: 'docker-compose.yml', dir: 'data' });
    expect(l.get('/hdd/AppData/docker-compose.yml')).toEqual({ name: 'docker-compose.yml', dir: 'hdd/AppData' });
    // A name no other open file has: the name alone.
    expect(l.get('/data/.env')).toEqual({ name: '.env', dir: '' });
  });

  it('in one folder: only as much of the path as it takes; deep in different folders, the folder name and the end', () => {
    const one = fileLabels(['/srv/app/a/x/compose.yml', '/srv/app/b/x/compose.yml'], ['/srv/app']);
    expect([...one.values()].map((v) => v.dir)).toEqual(['a/x', 'b/x']);
    const two = fileLabels(['/data/apps/foo/compose.yml', '/hdd/apps/bar/compose.yml'], ['/data', '/hdd']);
    expect([...two.values()].map((v) => v.dir)).toEqual(['data/.../foo', 'hdd/.../bar']);
    // Outside any folder of the workspace: from /.
    const three = fileLabels(['/etc/nginx/nginx.conf', '/opt/nginx/nginx.conf', '/nginx.conf']);
    expect([...three.values()].map((v) => v.dir)).toEqual(['etc/nginx', 'opt/nginx', '/']);
  });

  it('two workspace folders of the same name: the whole path', () => {
    const l = fileLabels(['/a/data/x.yml', '/b/data/x.yml'], ['/a/data', '/b/data']);
    expect([...l.values()].map((v) => v.dir)).toEqual(['/a/data', '/b/data']);
  });
});

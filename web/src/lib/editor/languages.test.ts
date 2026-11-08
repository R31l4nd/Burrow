import { describe, expect, it } from 'vitest';
import { detectLanguage } from './languages.js';

// Which language a file is, by its name or its first line: the colours, the
// language server, and the checks Burrow runs on it (compose, hadolint).
const of = (path: string, first = '') => {
  const l = detectLanguage(path, first);
  return [l.name, l.server, l.compose, l.hadolint];
};

describe("a file's language", () => {
  it('by its name', () => {
    expect(of('/srv/app/docker-compose.yml')).toEqual(['YAML', 'yaml', true, false]);
    expect(of('/srv/app/compose.prod.yaml')).toEqual(['YAML', 'yaml', true, false]);
    expect(of('/etc/netplan/50-cloud.yaml')).toEqual(['YAML', 'yaml', false, false]);
    expect(of('/srv/README.md')).toEqual(['Markdown', null, false, false]);
    expect(of('/srv/tsconfig.jsonc')).toEqual(['JSON', 'json', false, false]);
    expect(of('/srv/build/Dockerfile')).toEqual(['Dockerfile', 'dockerfile', false, true]);
    expect(of('/srv/build/Containerfile')).toEqual(['Dockerfile', 'dockerfile', false, true]);
    expect(of('/srv/pyproject.toml')).toEqual(['TOML', 'toml', false, false]);
    expect(of('/home/me/.bashrc')).toEqual(['Shell', 'shellscript', false, false]);
    expect(of('/etc/nginx/sites-available/default')[0]).toBe('nginx');
    expect(of('/config/nginx/proxy-confs/radarr.subdomain.conf.sample')[0]).toBe('nginx');
    expect(of('/etc/systemd/system/burrow.service')[0]).toBe('INI');
    expect(of('/srv/app/.env.production')[0]).toBe('.env');
    expect(of('/srv/notes.txt')).toEqual(['Text', null, false, false]);
  });

  it('a script without an extension by its first line', () => {
    expect(of('/usr/local/bin/backup', '#!/usr/bin/env bash')[0]).toBe('Shell');
    expect(of('/usr/local/bin/tool', '#!/usr/bin/python3')[0]).toBe('Python');
    expect(of('/usr/local/bin/tool', 'just text')[0]).toBe('Text');
  });

  it('each loads its highlighting', async () => {
    for (const p of ['a.yml', 'a.md', 'a.json', 'a.py', 'Dockerfile', 'a.toml', 'a.sh', 'nginx.conf', 'a.ini', 'a.txt']) {
      const ext = await detectLanguage(p).load();
      expect(ext, p).toBeDefined();
    }
  });
});

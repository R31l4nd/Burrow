import { describe, expect, it } from 'vitest';
import { outline } from './outline.js';

const names = (text: string, lang: string) => outline(text, lang).map((x) => `${'  '.repeat(x.depth)}${x.name}:${x.line}`);

describe("a file's outline (review 2026-10-24: as VS Code's, from the text itself)", () => {
  it('Markdown: its headings, not a # in a code block', () => {
    expect(names('# Title\ntext\n## Part\n```\n# not this\n```\n### Deeper\n', 'Markdown')).toEqual(['Title:1', '  Part:3', '    Deeper:7']);
  });

  it('YAML: its keys by their indent (a compose file: services, then each service)', () => {
    expect(names('services:\n  web:\n    image: nginx\n    ports:\n      - 80:80\n  db:\n    image: postgres\nvolumes:\n  data: {}\n# a: comment\n', 'YAML')).toEqual([
      'services:1',
      '  web:2',
      '    image:3',
      '    ports:4',
      '  db:6',
      '    image:7',
      'volumes:8',
      '  data:9',
    ]);
  });

  it('JSON: its keys by their indent', () => {
    expect(names('{\n  "name": "x",\n  "scripts": {\n    "build": "vite"\n  }\n}\n', 'JSON')).toEqual(['name:2', 'scripts:3', '  build:4']);
  });

  it('Python, shell: functions and classes', () => {
    expect(names('import os\nclass A:\n    def run(self):\n        pass\ndef main():\n    pass\n', 'Python')).toEqual(['A:2', '  run:3', 'main:5']);
    expect(names('#!/bin/sh\nbackup() {\n  tar c .\n}\nfunction clean {\n  rm x\n}\n', 'Shell')).toEqual(['backup:2', 'clean:5']);
  });

  it('nginx: its blocks, nested; INI and TOML: their sections; a Dockerfile: its stages', () => {
    expect(names('http {\n  server {\n    listen 80;\n    location /api {\n      proxy_pass x;\n    }\n  }\n}\n', 'nginx')).toEqual(['http:1', '  server:2', '    location /api:4']);
    expect(names('a=1\n[server]\nport=2\n[db]\n', 'TOML')).toEqual(['server:2', 'db:4']);
    expect(names('FROM node:24 AS build\nRUN x\nFROM debian\n', 'Dockerfile')).toEqual(['build (node:24):1', 'debian:3']);
  });

  it('plain text has none; a huge file is cut', () => {
    expect(outline('just words\n', 'Text')).toEqual([]);
    expect(outline(Array.from({ length: 2000 }, (_, i) => `k${i}: 1`).join('\n'), 'YAML')).toHaveLength(500);
  });
});

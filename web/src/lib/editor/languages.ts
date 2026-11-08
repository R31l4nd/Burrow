import type { Extension } from '@codemirror/state';

// Which language a file is, by name (and shebang): the syntax mode for the
// editor and, where one exists, the language server Burrow runs for it.

export type ServerLang = 'yaml' | 'shellscript' | 'dockerfile' | 'json' | 'toml' | 'python';

export interface FileLanguage {
  // Shown in the status line.
  name: string;
  server: ServerLang | null;
  compose: boolean;
  hadolint: boolean;
  load(): Promise<Extension>;
}

const legacy = async (load: () => Promise<Parameters<typeof import('@codemirror/language').StreamLanguage.define>[0]>) => {
  const { StreamLanguage } = await import('@codemirror/language');
  return StreamLanguage.define(await load());
};

export function detectLanguage(path: string, firstLine = ''): FileLanguage {
  const name = path.split('/').pop()!.toLowerCase();
  const plain: FileLanguage = { name: 'Text', server: null, compose: false, hadolint: false, load: async () => [] };

  if (/\.(ya?ml)$/.test(name)) {
    return {
      name: 'YAML',
      server: 'yaml',
      compose: /(^|[-.])compose[^/]*\.ya?ml$/.test(name) || /^docker-compose/.test(name),
      hadolint: false,
      load: async () => (await import('@codemirror/lang-yaml')).yaml(),
    };
  }
  // Markdown: coloured, and a preview in the editor's tools (report 8fa899).
  if (/\.(md|markdown|mdown)$/.test(name)) return { ...plain, name: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() };
  if (/\.json$|\.jsonc$/.test(name)) return { ...plain, name: 'JSON', server: 'json', load: async () => (await import('@codemirror/lang-json')).json() };
  if (/\.py$/.test(name) || /^#!.*python/.test(firstLine)) {
    return { ...plain, name: 'Python', server: 'python', load: async () => (await import('@codemirror/lang-python')).python() };
  }
  if (/^dockerfile|\.dockerfile$|^containerfile/.test(name)) {
    return { ...plain, name: 'Dockerfile', server: 'dockerfile', hadolint: true, load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile) };
  }
  if (/\.toml$/.test(name)) return { ...plain, name: 'TOML', server: 'toml', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml) };
  if (/\.(sh|bash|zsh)$|^\.?(bashrc|bash_profile|profile|zshrc|bash_aliases)$/.test(name) || /^#!.*\b(ba|z|da)?sh\b/.test(firstLine)) {
    return { ...plain, name: 'Shell', server: 'shellscript', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell) };
  }
  if (/nginx|\.nginx$/.test(name) || /^(sites-(available|enabled)|conf\.d)$/.test(path.split('/').slice(-2, -1)[0] ?? '') || /\.(subdomain|subfolder)\.conf(\.sample)?$/.test(name)) {
    return { ...plain, name: 'nginx', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx) };
  }
  if (/\.(ini|cfg|conf|properties|service|timer|socket|mount)$|^\.env(\..+)?$|\.env$/.test(name)) {
    return { ...plain, name: /env/.test(name) ? '.env' : 'INI', load: () => legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties) };
  }
  return plain;
}

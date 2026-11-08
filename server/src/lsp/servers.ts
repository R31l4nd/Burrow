import { accessSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The language servers Burrow runs, one process per open editor. They work
// on the text the editor sends, so files never need to be copied here.

const require = createRequire(import.meta.url);
const COMPOSE_SCHEMA = fileURLToPath(new URL('../../assets/compose-spec.json', import.meta.url));

export type LanguageId = 'yaml' | 'shellscript' | 'dockerfile' | 'json' | 'toml' | 'python';

export interface ServerDef {
  command: string;
  args: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  // Answers to workspace/configuration and the didChangeConfiguration push.
  settings: Record<string, unknown>;
}

/** A Node-based server from node_modules, started with the running Node. */
function nodeBin(pkg: string, bin: string): string | null {
  try {
    const manifest = require.resolve(`${pkg}/package.json`);
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
    const rel = typeof json.bin === 'string' ? json.bin : json.bin?.[bin];
    return rel ? join(dirname(manifest), rel) : null;
  } catch {
    return null;
  }
}

/**
 * The environment for a tool Burrow starts (language servers, hadolint):
 * only what a program needs to run, never Burrow's own settings, among
 * them the master key when it is given as BURROW_SECRET.
 */
export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...extra };
}

/** A native binary on PATH (installed in the image: shellcheck, shfmt, taplo, ruff, hadolint). */
export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return null;
}

export function serverFor(lang: LanguageId): ServerDef | null {
  const node = process.execPath;
  switch (lang) {
    case 'yaml': {
      const bin = nodeBin('yaml-language-server', 'yaml-language-server');
      if (!bin) return null;
      return {
        command: node,
        args: [bin, '--stdio'],
        settings: {
          yaml: {
            validate: true,
            hover: true,
            completion: true,
            format: { enable: true },
            // No internet needed: the compose schema ships with Burrow.
            schemaStore: { enable: false },
            schemas: { [`file://${COMPOSE_SCHEMA}`]: ['*compose*.yml', '*compose*.yaml', 'compose.yml', 'compose.yaml'] },
          },
        },
      };
    }
    case 'shellscript': {
      const bin = nodeBin('bash-language-server', 'bash-language-server');
      if (!bin) return null;
      const shellcheck = findOnPath('shellcheck');
      const shfmt = findOnPath('shfmt');
      return {
        command: node,
        args: [bin, 'start'],
        env: {
          ...(shellcheck ? { SHELLCHECK_PATH: shellcheck } : {}),
          ...(shfmt ? { SHFMT_PATH: shfmt } : {}),
        },
        settings: {
          bashIde: {
            shellcheckPath: shellcheck ?? '',
            shfmt: { path: shfmt ?? '' },
            backgroundAnalysisMaxFiles: 0,
          },
        },
      };
    }
    case 'dockerfile': {
      const bin = nodeBin('dockerfile-language-server-nodejs', 'docker-langserver');
      return bin ? { command: node, args: [bin, '--stdio'], settings: { docker: { languageserver: {} } } } : null;
    }
    case 'json': {
      const bin = nodeBin('vscode-langservers-extracted', 'vscode-json-language-server');
      return bin
        ? { command: node, args: [bin, '--stdio'], initializationOptions: { provideFormatter: true }, settings: { json: { validate: { enable: true } } } }
        : null;
    }
    case 'toml': {
      const taplo = findOnPath('taplo');
      return taplo ? { command: taplo, args: ['lsp', 'stdio'], settings: { evenBetterToml: { schema: { enabled: false } } } } : null;
    }
    case 'python': {
      const ruff = findOnPath('ruff');
      return ruff ? { command: ruff, args: ['server'], settings: {} } : null;
    }
  }
}

/** Value for a workspace/configuration item like { section: 'yaml' }. */
export function configFor(def: ServerDef, section: string | undefined): unknown {
  if (!section) return def.settings;
  let cur: unknown = def.settings;
  for (const part of section.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return null;
  }
  return cur;
}

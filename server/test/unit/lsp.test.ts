import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { Decoder, encode } from '../../src/lsp/framing.js';
import { configFor, serverFor, toolEnv, type LanguageId } from '../../src/lsp/servers.js';
import { serverInitialize } from '../../src/lsp/bridge.js';

describe('framing', () => {
  it('round-trips messages split at any byte, multibyte text included', () => {
    const msgs = ['{"a":1}', '{"text":"héllo - ✓"}', '{}'];
    const bytes = Buffer.concat(msgs.map(encode));
    for (const size of [1, 3, 7, 64, bytes.length]) {
      const d = new Decoder();
      const out: string[] = [];
      for (let i = 0; i < bytes.length; i += size) out.push(...d.push(bytes.subarray(i, i + size)));
      expect(out).toEqual(msgs);
    }
  });
});

describe('toolEnv', () => {
  it('gives a tool what it needs to run, none of Burrow\'s own settings', () => {
    const saved = { ...process.env };
    try {
      process.env.BURROW_SECRET = 'x'.repeat(40);
      process.env.BURROW_ORIGIN = 'https://burrow.example';
      const env = toolEnv({ EXTRA: '1' });
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.EXTRA).toBe('1');
      expect(Object.keys(env).filter((k) => k.startsWith('BURROW_'))).toEqual([]);
    } finally {
      process.env = saved;
    }
  });
});

describe('configFor', () => {
  it('answers sections from the server settings', () => {
    const def = serverFor('yaml')!;
    expect(configFor(def, 'yaml.schemaStore')).toEqual({ enable: false });
    expect(configFor(def, 'nope')).toBeNull();
  });
});

/** Start a Node-based server and complete the initialize handshake. */
async function initialize(lang: LanguageId): Promise<Record<string, unknown>> {
  const def = serverFor(lang)!;
  const child = spawn(def.command, def.args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...def.env } });
  const d = new Decoder();
  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${lang}: no answer`)), 15_000);
    child.stdout!.on('data', (c: Buffer) => {
      for (const m of d.push(c)) {
        const j = JSON.parse(m) as { id?: number; result?: Record<string, unknown> };
        if (j.id === 1) {
          clearTimeout(timer);
          resolve(j.result!);
        }
      }
    });
  });
  child.stdin!.write(encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } })));
  try {
    return await reply;
  } finally {
    child.kill();
  }
}

describe('Node-based language servers', () => {
  for (const lang of ['yaml', 'shellscript', 'dockerfile', 'json'] as const) {
    it(`${lang} starts and answers initialize`, async () => {
      const r = await initialize(lang);
      expect(r).toHaveProperty('capabilities');
    }, 20_000);
  }
});

describe('composeDiagnostics', () => {
  it('maps docker compose errors to lines', async () => {
    const { composeDiagnostics } = await import('../../src/lint/routes.js');
    const text = 'services:\n  web:\n    imagee: nginx\n';
    expect(composeDiagnostics("validating compose.yaml: services.web additional properties 'imagee' not allowed", text)).toEqual([
      { line: 3, column: 1, severity: 'error', message: "services.web additional properties 'imagee' not allowed", source: 'docker compose' },
    ]);
    expect(composeDiagnostics('yaml: line 7: mapping values are not allowed in this context', text)[0]?.line).toBe(7);
  });
  it("places compose errors as Compose v5 words them on their line: a schema path, a YAML position", async () => {
    const { composeDiagnostics } = await import('../../src/lint/routes.js');
    const text = 'services:\n  db:\n    image: postgres\n    ports:\n      - 5432\n  web:\n    image: nginx\n    imagee: typo\n    ports: 80\n';
    // The key that is wrong, in the service it is in: web's ports, not db's.
    expect(composeDiagnostics('validating compose.yaml: services.web.imagee false schema', text)).toEqual([
      { line: 8, column: 1, severity: 'error', message: 'services.web.imagee false schema', source: 'docker compose' },
    ]);
    expect(composeDiagnostics('validating compose.yaml: services.web.ports must be a array', text)[0]?.line).toBe(9);
    expect(composeDiagnostics('validating compose.yaml: services.db.ports.0 must be a string', text)[0]?.line).toBe(4);
    expect(composeDiagnostics("go-yaml load error in parser (while parsing a flow sequence) at L4.C12-L5.C1: did not find expected ',' or ']'", text)[0]).toMatchObject({ line: 4, column: 12 });
  });
});

describe('initialize from the editor (AUDIT2 FS-25)', () => {
  it("carries the server's own options, never the browser's", () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, initializationOptions: { backgroundAnalysisMaxFiles: 9999 } } });
    const own = JSON.parse(serverInitialize(raw, { provideFormatter: true })) as { params: { initializationOptions?: unknown } };
    expect(own.params.initializationOptions).toEqual({ provideFormatter: true });
    const none = JSON.parse(serverInitialize(raw, undefined)) as { params: { initializationOptions?: unknown } };
    expect(none.params).not.toHaveProperty('initializationOptions');
  });
});

describe('framing limits (AUDIT2 FS-20)', () => {
  it('a message said to be larger than the limit, or a header that never ends, is refused, not held in memory', () => {
    const d = new Decoder();
    expect(() => d.push(Buffer.from(`Content-Length: ${64 << 20}\r\n\r\n{`))).toThrow(/too large/);
    const h = new Decoder();
    expect(() => h.push(Buffer.alloc(70_000, 0x41))).toThrow(/header/);
  });
});

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { cpSync, createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The Fig completion specs (@withfig/autocomplete, MIT) are served as static
// ES modules under /fig/ and loaded one CLI at a time. They are not part of
// the bundle: there are hundreds and a session needs a handful.
const FIG_DIR = dirname(createRequire(import.meta.url).resolve('@withfig/autocomplete'));

function figSpecs(): Plugin {
  return {
    name: 'burrow-fig-specs',
    configureServer(server) {
      server.middlewares.use('/fig/', (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? '').split('?')[0]!)).replace(/^[/\\]+/, '');
        const file = join(FIG_DIR, rel);
        if (!file.startsWith(FIG_DIR) || !rel.endsWith('.js') || !existsSync(file)) return next();
        res.setHeader('content-type', 'text/javascript');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(FIG_DIR, join(__dirname, 'dist', 'fig'), { recursive: true, filter: (p) => !p.endsWith('.d.ts') && !p.endsWith('.map') });
    },
  };
}

// In development the API runs separately (npm run dev:server) and Vite
// proxies /api to it. BURROW_ORIGIN on the server must then be the Vite
// origin (http://localhost:5173) so passkeys and the Origin check line up.
const VERSION = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [svelte(), figSpecs()],
  // The app's version, for a problem report.
  define: { __BURROW_VERSION__: JSON.stringify(VERSION) },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false, ws: true } },
    // It serves files of the whole checkout under /@fs/: never the instance data (data/, the live
    // instance's folder may be there: deploy/local, report 4b9965), the backups or the secrets.
    // Vite's own list first (setting it replaces it).
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...['data', 'backups', 'secrets'].map((d) => `${join(__dirname, '..', d)}/**`)] },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});

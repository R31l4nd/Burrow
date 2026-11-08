import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The Android app's direct route (web/direct.html): built on its own, into
// dist-direct/, and bundled into the APK by scripts/direct-assets.sh. The app
// serves it at https://appassets.androidplatform.net/direct/.
export default defineConfig({
  plugins: [svelte()],
  base: '/direct/',
  build: {
    outDir: 'dist-direct',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: { input: 'direct.html' },
  },
});

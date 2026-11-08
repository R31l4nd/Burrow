import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['**/dist/', '**/dist-direct/', '**/node_modules/', 'server/public/', 'e2e/test-results/', 'e2e/playwright-report/', 'artifacts/', 'android/app/build/', 'android/build/', 'android/app/src/main/assets/', 'data/', 'backups/'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The one place that renders HTML is the QR code SVG from the qrcode library.
      'svelte/no-at-html-tags': 'off',
      // Flags every local Set/Date, including short-lived ones inside a
      // function that are never meant to be reactive.
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser, extraFileExtensions: ['.svelte'] } },
  },
);

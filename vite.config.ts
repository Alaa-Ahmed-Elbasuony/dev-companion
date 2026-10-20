import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the extension UI pages. Service worker and content scripts are built
// separately by scripts/build.mjs because content scripts must be classic
// (non-module) scripts.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/ui'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome120',
    modulePreload: false,
    rolldownOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/ui/popup.html'),
        dashboard: resolve(import.meta.dirname, 'src/ui/dashboard.html'),
        devtools: resolve(import.meta.dirname, 'src/ui/devtools.html'),
      },
    },
  },
});

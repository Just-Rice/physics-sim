/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer, which the multithreaded
// particle solver uses. The desktop app sets the same headers itself, and on
// GitHub Pages public/coi-serviceworker.js adds them.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});

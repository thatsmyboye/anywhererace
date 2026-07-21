import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * Static, host-agnostic build.
 *
 * `base: './'` emits relative asset URLs so the same bundle works served from a
 * domain root, from a subdirectory, or from a preview URL, without a rebuild.
 * That is what makes deploying to anywhererace.banton-digital.com — or to any
 * static host — a matter of copying `dist/`.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwind()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // MapLibre is large and changes rarely; splitting it out means an app
    // update does not force every visitor to re-download the map engine.
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
  worker: {
    // The simulation worker is an ES module and imports across the workspace.
    format: 'es',
  },
});

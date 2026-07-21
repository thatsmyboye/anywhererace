import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * One config, three projects. Keeping them separate lets `pnpm test:determinism`
 * target the sim project alone, and makes it obvious when a track test has
 * accidentally acquired a sim dependency.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@anywhererace/core': pkg('core'),
      '@anywhererace/sim': pkg('sim'),
      '@anywhererace/track': pkg('track'),
      '@anywhererace/worker': pkg('worker'),
      '@anywhererace/ui': pkg('ui'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'sim', include: ['packages/sim/test/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'track', include: ['packages/track/test/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'worker', include: ['packages/worker/test/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'ui', include: ['packages/ui/test/**/*.test.ts'], environment: 'node' },
      },
    ],
  },
});

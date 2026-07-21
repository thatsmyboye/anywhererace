import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: named exports only.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named exports only (see CLAUDE.md conventions).',
        },
      ],
      // CLAUDE.md: no `any`, no bare @ts-ignore.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Build tooling reads its configuration from a default export; that is the
    // tools' contract, not a style choice we get to make.
    files: ['*.config.js', '*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The sim must stay headless and deterministic. These are the imports and
    // globals that would silently break replay; ban them at lint time rather
    // than discovering it via a golden-test failure months later.
    files: ['packages/sim/src/**/*.ts', 'packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'packages/sim and packages/core must stay headless.' },
        { name: 'document', message: 'packages/sim and packages/core must stay headless.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the injected seeded Rng.' },
        { object: 'Date', property: 'now', message: 'The sim has no wall clock.' },
      ],
    },
  },
);

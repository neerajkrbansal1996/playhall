// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Determinism rule (principle 5 / SDK contract): game modules and the reducers
    // the platform runs for them must never read ambient time or randomness.
    // `packages/*` and `games/*` get the strict form; apps and configs are exempt.
    files: ['packages/**/src/**/*.{ts,tsx}', 'games/**/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Use ctx.now (server-authoritative clock), not Date.now().',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Use ctx.rng (seeded, stored on the match), not Math.random().',
        },
      ],
    },
  },
  {
    files: ['**/*.config.{js,mjs,cjs,ts}', 'scripts/**/*.{js,mjs,ts}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
)

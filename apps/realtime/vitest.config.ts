import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.mjs` is here for the release-build tooling in `build.mjs` and
    // `scripts/release/`, which runs under plain Node and is not TypeScript.
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // `index.ts` boots a server on import, so it is exercised by the
      // source-map evidence run rather than by unit tests.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})

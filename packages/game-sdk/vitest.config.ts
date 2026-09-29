import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The package currently ships contracts and a fixture but no spec files, and an
    // empty run must not fail the repo-wide `pnpm test`. Remove this the moment
    // PER-10 lands the SDK's own tests — the >= 80% coverage bar is the real gate.
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Only files with executable runtime code count. Contract modules are
      // type-only by design and emit nothing to cover.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})

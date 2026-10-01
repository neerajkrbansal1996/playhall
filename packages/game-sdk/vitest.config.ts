import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Deliberately no "empty run passes" escape hatch. That flag overrides the
    // coverage thresholds below: with it set, an empty run prints all four threshold
    // errors and still exits 0, so a deleted `test/` or a stale `include` glob would
    // report this package green at 0%. An empty run must fail.
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

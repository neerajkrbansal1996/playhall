import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Only files with executable runtime code count. `index.ts` is a pure
      // re-export barrel: it compiles to nothing executable, but v8 still charges an
      // unloaded module one phantom line, function and branch, all uncovered. Left in,
      // that single phantom function was the whole gap between 83.33% and 100%
      // functions here. Keep this exclusion to the barrel — if it ever grows a
      // statement of its own, the file needs a test, not a wider glob.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})

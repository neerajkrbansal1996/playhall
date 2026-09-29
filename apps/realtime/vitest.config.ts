import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Only `health.ts` has testable logic today. `index.ts` is the server
      // bootstrap; it gets covered by the integration suite in M1, not by unit
      // tests that would just re-assert `createServer` was called.
      include: ['src/health.ts'],
    },
  },
})

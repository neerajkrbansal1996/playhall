import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `ws-probe.integration.test.ts` spawns the entrypoint twice, and tsx needs a
    // moment to start. The default 5 s is not enough for its `beforeAll`.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // `health.ts` and `ws-probe.ts` have testable logic. `index.ts` is the
      // server bootstrap; it is exercised end-to-end by the spawned-process test
      // rather than by unit tests that would re-assert `createServer` was called,
      // and a child process is not visible to the coverage provider — so it stays
      // out of this list to keep the number honest.
      include: ['src/health.ts', 'src/ws-probe.ts'],
    },
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each case spawns `node scripts/ci/gate.mjs` against a scratch repo on disk, and the
    // two "the gate actually runs the script" cases spawn pnpm underneath that.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // No coverage thresholds here on purpose, same reasoning as tools/boundaries: this
    // package is a test harness for a script outside any package's source tree, and what it
    // must prove is "every branch of the gate runner behaves", which the cases assert
    // directly. A line-coverage number over the harness itself would say nothing about that.
  },
})

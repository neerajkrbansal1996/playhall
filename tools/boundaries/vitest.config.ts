import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each case spawns dependency-cruiser against a scratch repo on disk. That is a few
    // hundred ms per case, well past vitest's 5 s default when cases run in sequence.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // No coverage thresholds here on purpose: this package is a test harness, and the thing
    // it must prove is "every rule fires", which the fixture-per-rule assertion checks
    // directly. A line-coverage number would say nothing about that.
  },
})

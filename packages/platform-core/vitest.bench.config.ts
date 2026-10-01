import { defineConfig } from 'vitest/config'

/**
 * The drift measurement only. Five minutes of wall time is too slow for every
 * PR, so it runs from its own config: `pnpm --filter @playhall/platform-core
 * bench:drift`. Release checks and any change to `record.ts`, `clock.ts` or
 * `sync.ts` should run it and report the number.
 */
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts'],
    // One file, sequential, no coverage instrumentation — v8 coverage adds
    // enough overhead to contaminate a timing measurement.
    fileParallelism: false,
    hookTimeout: 600_000,
  },
})

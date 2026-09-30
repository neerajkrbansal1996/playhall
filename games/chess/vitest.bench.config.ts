import { defineConfig } from 'vitest/config'

/**
 * The PER-92 replay benchmark, kept out of the default config on purpose: it is
 * a measurement, not a gate, and timing assertions flake on a shared runner.
 * `pnpm test` therefore never picks `bench/` up.
 */
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.ts'],
    // One long benchmark file; parallel workers would fight over the CPU.
    fileParallelism: false,
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The script under test is plain `.mjs` outside any package source tree, so the
    // cases are `.mjs` too and import it directly. No transform, no network.
    include: ['test/**/*.test.mjs'],
    // No coverage thresholds here on purpose, same reasoning as tools/ci-gate and
    // tools/boundaries: this package is a test harness for a script outside any
    // package's source tree. What it must prove is "the sweep flags the batch it
    // missed and does not flag anything that has a real wake path", which the cases
    // assert directly. A line-coverage number over the harness would say nothing
    // about that.
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // Barrel file — re-exports only, nothing to cover.
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      // Deliberately no thresholds here, unlike game-sdk. The >= 80% standard
      // names game-sdk, platform-core, netcode and game rules; `shared` is not
      // on that list, and `brand.ts` / `room-code.ts` have no tests yet. A
      // threshold set to a number the package does not meet is a threshold
      // everyone learns to bypass. Coverage is still reported so the gap is
      // visible rather than hidden.
    },
  },
})

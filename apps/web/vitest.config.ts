import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// `vite` is pinned to 5.x in package.json for @vitejs/plugin-react's sake, not
// vitest's: left floating, the plugin drags in vite 7's types and its `Plugin`
// stops being assignable to the `PluginOption` this config expects. vitest
// declares vite as a direct dependency (`^5 || ^6 || ^7.0.0-0`), so the runner
// brings its own copy and does not constrain this pin either way.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
})

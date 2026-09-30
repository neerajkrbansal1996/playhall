import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// `vite` is pinned to 5.x in package.json to match the copy vitest 2.x resolves.
// Left floating, @vitejs/plugin-react drags in vite 7's types and its `Plugin`
// stops being assignable to the `PluginOption` this config expects.
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

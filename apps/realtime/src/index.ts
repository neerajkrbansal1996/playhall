import { createServer } from 'node:http'
import { BRAND } from '@playhall/shared'
import { platformBuildInfo } from '@playhall/platform-core'
import { loadEnv } from './env'

const env = loadEnv()
const startedAt = new Date().toISOString()

/**
 * M0 skeleton: HTTP only, so `pnpm dev` has something that actually boots and
 * CI has something to probe. The wire protocol (`room:*`, `game:action`,
 * `game:view`, `timer:sync`, …) and the room runner land in M1.
 */
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        service: '@playhall/realtime',
        brand: BRAND.name,
        brandIsProvisional: BRAND.isProvisional,
        versions: platformBuildInfo(),
        startedAt,
      }),
    )
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'No such route.' } }))
})

server.listen(env.REALTIME_PORT, () => {
  console.log(`[realtime] listening on http://localhost:${env.REALTIME_PORT} (${env.NODE_ENV})`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}

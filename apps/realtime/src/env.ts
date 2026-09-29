import { z } from 'zod'

/**
 * Every external input gets a zod schema — config included. A service that
 * boots with a half-configured Redis URL fails later and less clearly.
 */
const EnvSchema = z.object({
  REALTIME_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url().default('postgresql://playhall:playhall@localhost:5432/playhall'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')
    throw new Error(`Invalid environment for @playhall/realtime:\n  ${detail}`)
  }
  return parsed.data
}

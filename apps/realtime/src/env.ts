import { z } from 'zod'
import { DEPLOY_ENVIRONMENTS, LOG_LEVELS } from '@playhall/shared'

/**
 * Every external input gets a zod schema — config included. A service that
 * boots with a half-configured Redis URL fails later and less clearly.
 *
 * Which of these each environment sets, and where the value comes from, is
 * documented in `docs/ENVIRONMENTS.md`. Nothing here has a secret as a default.
 */
const EnvSchema = z.object({
  REALTIME_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  DATABASE_URL: z.string().url().default('postgresql://playhall:playhall@localhost:5432/playhall'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Sentry's `environment` tag and the logger's `environment` field. */
  DEPLOY_ENV: z.enum(DEPLOY_ENVIRONMENTS).default('development'),
  /**
   * Commit the build came from. Becomes `playhall-realtime@<sha>` — the release
   * name Sentry resolves source maps against. `0000000` is a local placeholder,
   * never a deployed value; CI always injects the real sha.
   */
  GIT_SHA: z
    .string()
    .regex(/^[0-9a-fA-F]{7,40}$/, 'GIT_SHA must be 7-40 hex characters.')
    .default('0000000'),

  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  /** Fraction of non-lifecycle log events kept. Lower this under load, not the level. */
  LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),

  /**
   * Absent means "no error aggregation configured" — reports fall back to the
   * structured logger rather than vanishing. Not secret (a DSN is a write-only
   * ingest key) but still injected, never committed.
   */
  SENTRY_DSN: z.string().url().optional(),

  /**
   * Exposes `GET /debug/throw`, which exists only to prove the source-map
   * pipeline resolves a stack trace. Off unless explicitly enabled.
   */
  ENABLE_DEBUG_THROW_ROUTE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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

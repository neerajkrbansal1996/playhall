import { z } from 'zod'

/**
 * Every external input gets a zod schema — config included. A service that
 * boots with a half-configured Redis URL fails later and less clearly.
 */
const EnvSchema = z.object({
  /**
   * `0` is allowed and means "ask the OS for a free port" — the standard way to
   * boot this service more than once on one machine without picking ports by
   * hand, which is what the probe's spawned-process test does. The boot log
   * prints the port that was actually bound, not this value, so `0` is
   * observable rather than a mystery.
   */
  REALTIME_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  DATABASE_URL: z.string().url().default('postgresql://playhall:playhall@localhost:5432/playhall'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * M0 AC2a WebSocket transport probe (ADR-0009). Opt-in, and only `'1'` counts
   * — an unset, empty or any other value leaves `/ws/probe` unattached, which is
   * the behaviour production must keep. Set in dev and staging; never in prod.
   *
   * This flag is deleted together with `ws-probe.ts` when the M1.6 transport
   * adapter lands.
   *
   * Strict rather than truthy: `REALTIME_WS_PROBE=true` fails boot instead of
   * quietly meaning "off", because a flag that silently ignores a plausible
   * value is how a probe gets believed to be enabled on staging when it is not.
   * Unset and empty both mean off — a shell or compose file that exports an
   * empty var must not be a boot failure.
   */
  REALTIME_WS_PROBE: z
    .preprocess((value) => (value === '' || value === undefined ? '0' : value), z.enum(['0', '1']))
    .transform((value) => value === '1'),
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

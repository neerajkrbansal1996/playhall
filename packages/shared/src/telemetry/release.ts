import { z } from 'zod'

/**
 * Release identity, shared by the logger and the error reporter.
 *
 * Release names are **fully qualified** — `<service>@<git-sha>`, never a bare
 * sha. Our Sentry org is shared with an unrelated product, and a bare sha in a
 * shared org collides across projects and resolves the wrong source map, which
 * is the exact failure this ticket exists to prevent.
 *
 * Environments are a **tag**, not a separate project: one Sentry project per
 * service, `environment: staging | production` on the event.
 */

export const DEPLOY_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const

export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number]

export const DeployEnvironmentSchema = z.enum(DEPLOY_ENVIRONMENTS)

/** Lowercase slug: `playhall-web`, `playhall-realtime`. */
const SERVICE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
/** Short or full git sha. */
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/

export const ServiceNameSchema = z
  .string()
  .regex(SERVICE_PATTERN, 'Service must be a lowercase slug, e.g. "playhall-realtime".')

export const GitShaSchema = z
  .string()
  .regex(GIT_SHA_PATTERN, 'Git sha must be 7-40 lowercase hex characters.')

export const RELEASE_SEPARATOR = '@'

/**
 * `<service>@<git-sha>`. Throws on a malformed input rather than emitting a
 * release name that silently resolves the wrong source map.
 */
export function formatRelease(service: string, gitSha: string): string {
  const parsedService = ServiceNameSchema.parse(service)
  const parsedSha = GitShaSchema.parse(gitSha.toLowerCase())
  return `${parsedService}${RELEASE_SEPARATOR}${parsedSha}`
}

export interface ParsedRelease {
  readonly service: string
  readonly gitSha: string
}

/** Rejects a bare sha — that is the collision we are guarding against. */
export function parseRelease(release: string): ParsedRelease | undefined {
  const at = release.indexOf(RELEASE_SEPARATOR)
  if (at <= 0) return undefined
  const service = release.slice(0, at)
  const gitSha = release.slice(at + 1)
  if (!SERVICE_PATTERN.test(service) || !GIT_SHA_PATTERN.test(gitSha)) return undefined
  return { service, gitSha }
}

export interface ReleaseIdentity {
  readonly service: string
  readonly gitSha: string
  /** The fully-qualified release name handed to Sentry and stamped on logs. */
  readonly release: string
  readonly environment: DeployEnvironment
}

export interface ReleaseIdentityInput {
  readonly service: string
  readonly gitSha: string
  readonly environment: DeployEnvironment
}

export function createReleaseIdentity(input: ReleaseIdentityInput): ReleaseIdentity {
  const service = ServiceNameSchema.parse(input.service)
  const gitSha = GitShaSchema.parse(input.gitSha.toLowerCase())
  return {
    service,
    gitSha,
    release: formatRelease(service, gitSha),
    environment: DeployEnvironmentSchema.parse(input.environment),
  }
}

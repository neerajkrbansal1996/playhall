/**
 * Typed results and action errors.
 *
 * Games never throw to reject a move. A thrown error is indistinguishable from
 * a bug, and the room runner has to decide between killing the match and
 * swallowing it. A returned, typed rejection is a normal outcome the platform
 * can turn into a client response, a metric and a log line.
 *
 * `message` is developer-facing. Player-facing copy is resolved by the platform
 * from `code` (+ `params`), so games never ship UI strings and never fight the
 * i18n layer. That keeps product copy with Product Designer, where it belongs.
 */

import type { JsonObject } from './json.js'

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error }
}

/**
 * Rejection codes every game shares. The platform maps these to copy, to HTTP
 * semantics and to abuse counters, so a game should reach for a standard code
 * before inventing one.
 */
export const STANDARD_ACTION_ERROR_CODES = [
  /** Payload failed `actionSchema`. Raised by the platform, before the game sees it. */
  'invalid_action',
  /** The viewer holds no seat in this match (e.g. a spectator tried to act). */
  'not_seated',
  'not_your_turn',
  /** Well-formed, but not legal in the current phase (e.g. discarding during a bid). */
  'out_of_phase',
  /** Well-formed and in phase, but against the rules (e.g. moving into check). */
  'illegal_action',
  'match_over',
  'match_not_started',
  /** Action requires a seat that is currently disconnected. */
  'seat_unavailable',
  'rate_limited',
  'internal_error',
] as const

export type StandardActionErrorCode = (typeof STANDARD_ACTION_ERROR_CODES)[number]

export interface ActionError<TCode extends string = StandardActionErrorCode> {
  readonly code: TCode
  /** Developer-facing detail for logs and tests. Never rendered to a player. */
  readonly message?: string
  /** Interpolation values for the platform's copy for `code`. JSON-safe. */
  readonly params?: JsonObject
}

/**
 * The result of `validateAction`. Deliberately not `Result<void, …>`: a
 * successful validation carries nothing, and `{ ok: true }` reads better at
 * every call site than `{ ok: true, value: undefined }`.
 */
export type ValidationResult<TCode extends string = StandardActionErrorCode> =
  { readonly ok: true } | { readonly ok: false; readonly error: ActionError<TCode> }

/**
 * The single shared "this action is legal" value.
 *
 * Typed as the success arm rather than as `ValidationResult<string>`: the union
 * carries `ActionError<TCode>` in its error arm, so a `ValidationResult<string>`
 * is not assignable to a `ValidationResult<StandardActionErrorCode>` and every
 * game returning `VALID` from a strictly-typed `validateAction` failed to
 * compile. The success arm has no `TCode` in it, so this widens cleanly to every
 * instantiation. Runtime value is unchanged.
 */
export const VALID: { readonly ok: true } = Object.freeze({ ok: true })

/** Builds a rejection. `invalid('not_your_turn')` is the common case. */
export function invalid<TCode extends string>(
  code: TCode,
  message?: string,
  params?: JsonObject,
): { readonly ok: false; readonly error: ActionError<TCode> } {
  return { ok: false, error: { code, message, params } }
}

export function isStandardActionErrorCode(value: string): value is StandardActionErrorCode {
  return (STANDARD_ACTION_ERROR_CODES as readonly string[]).includes(value)
}

/** Raised when `migrateState` cannot bring a persisted state to the current version. */
export interface MigrationError {
  readonly code: 'unsupported_version' | 'corrupt_state'
  readonly fromVersion: string
  readonly toVersion: string
  readonly message?: string
}

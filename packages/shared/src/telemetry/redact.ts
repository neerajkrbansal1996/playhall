import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../room-code'

/**
 * A lobby code is a **join capability**, not an identifier (ADR-0001 §6). Anyone
 * holding one can walk into a private room. So shipping one to a third-party
 * error or analytics vendor is a security bug, not a privacy preference — and
 * so is writing one into a log stream a support tool can grep.
 *
 * This module is the single scrub used by both paths: the Sentry `beforeSend`
 * hook and the structured logger. One implementation, one test suite; a scrub
 * that only guards one of the two exits is not a scrub.
 *
 * Scope, stated honestly:
 *   - Structured fields are matched **by key** — precise, no false positives.
 *   - Free-form strings have codes redacted inside URLs, and after a cue word
 *     ("room ABCDEF", "code: ABCDEF"). A bare 6-character token with no cue and
 *     no URL around it survives, because blanket `[A-Z2-9]{6}` redaction
 *     mangles ordinary prose ("SERVER", "CLIENT" are both legal codes).
 *   - The rule that closes that gap: **pass the code as a field, never
 *     interpolate it into a message.** Key matching then catches it.
 */

export const REDACTED = '[redacted]'

/** Matched exactly (case-insensitive) so `errorCode` / `statusCode` survive. */
const EXACT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'code',
  'cookie',
  'invite',
  'password',
  'secret',
  'token',
  'authorization',
])

/** Matched as a substring (case-insensitive) — these are never innocent. */
const SUBSTRING_SENSITIVE_KEYS: readonly string[] = [
  'accesstoken',
  'apikey',
  'authtoken',
  'connectionid',
  'guesttoken',
  'invitecode',
  'invitelink',
  'inviteurl',
  'joincode',
  'joinurl',
  'lobbycode',
  'passphrase',
  'privatekey',
  'refreshtoken',
  'roomcode',
  'sentrydsn',
  'sessiontoken',
  'setcookie',
  'shareurl',
  'shortlink',
  'socketid',
]

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true
  return SUBSTRING_SENSITIVE_KEYS.some((needle) => normalized.includes(needle))
}

const CODE_CHAR_CLASS = `[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}`

const CUE_WORDS = ['room', 'lobby', 'join', 'invite', 'game', 'pin', 'code'] as const

/**
 * Deliberately **not** case-insensitive on the code half. With the `i` flag the
 * alphabet class also matches lowercase, and "game before it starts" becomes
 * "game [redacted] it starts". Codes are uppercase; only the cue word varies.
 */
const CUE_ALTERNATION = CUE_WORDS.map((word) => {
  const title = word.charAt(0).toUpperCase() + word.slice(1)
  return `${word}|${word.toUpperCase()}|${title}`
}).join('|')

/** `code=ABCDEF`, `room: ABCDEF`, `lobby code ABCDEF`, `invite - ABCDEF`. */
const CUED_CODE = new RegExp(
  `(\\b(?:${CUE_ALTERNATION})\\s*(?:code|CODE|Code)?\\s*[:=\\-/]?\\s*)(${CODE_CHAR_CLASS})\\b`,
  'g',
)

/** Any code-shaped token inside a URL, wherever it sits. */
const URLISH = /\b(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi

const CODE_TOKEN = new RegExp(`\\b${CODE_CHAR_CLASS}\\b`, 'g')

/**
 * Redact join capabilities out of one free-form string. Order matters: URLs are
 * rewritten first so a cue word inside a query string cannot shadow the rest of
 * the URL.
 */
export function scrubString(input: string): string {
  const urlsScrubbed = input.replace(URLISH, (url) => url.replace(CODE_TOKEN, REDACTED))
  return urlsScrubbed.replace(CUED_CODE, (_match, cue: string) => `${cue}${REDACTED}`)
}

export interface ScrubOptions {
  /** Depth beyond which a nested value is replaced by a marker. */
  readonly maxDepth?: number
  /** Extra keys to treat as sensitive, in addition to the built-in list. */
  readonly extraKeys?: readonly string[]
}

const DEFAULT_MAX_DEPTH = 8
const TOO_DEEP = '[depth-limit]'
const CYCLE = '[circular]'

/**
 * Deep-scrub an arbitrary value into something safe to serialise. Also flattens
 * `Error`, `Map`, `Set` and `Date`, because a logger that emits `{}` for an
 * error is worse than no logger.
 */
export function scrubValue(value: unknown, options: ScrubOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const extra = new Set((options.extraKeys ?? []).map(normalizeKey))
  const sensitive = (key: string): boolean => isSensitiveKey(key) || extra.has(normalizeKey(key))
  const seen = new Set<object>()

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return node
    if (typeof node === 'string') return scrubString(node)
    if (typeof node === 'number') return Number.isFinite(node) ? node : String(node)
    if (typeof node === 'boolean') return node
    if (typeof node === 'bigint') return node.toString()
    if (typeof node === 'function' || typeof node === 'symbol') return undefined

    if (depth >= maxDepth) return TOO_DEEP
    if (seen.has(node as object)) return CYCLE
    seen.add(node as object)
    try {
      if (node instanceof Date) return node.toISOString()
      if (node instanceof Error) {
        return {
          name: node.name,
          message: scrubString(node.message),
          stack: node.stack === undefined ? undefined : scrubString(node.stack),
          cause: node.cause === undefined ? undefined : walk(node.cause, depth + 1),
        }
      }
      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
      if (node instanceof Set) return [...node].map((item) => walk(item, depth + 1))
      if (node instanceof Map) {
        const out: Record<string, unknown> = {}
        for (const [key, item] of node) {
          const name = String(key)
          out[name] = sensitive(name) ? REDACTED : walk(item, depth + 1)
        }
        return out
      }

      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (item === undefined) continue
        out[key] = sensitive(key) ? REDACTED : walk(item, depth + 1)
      }
      return out
    } finally {
      seen.delete(node as object)
    }
  }

  return walk(value, 0)
}

/** Convenience for call sites that hold a code and want it loggable. */
export function redactRoomCode(code: string): string {
  return code.length > 0 ? REDACTED : code
}

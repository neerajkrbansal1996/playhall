/**
 * Value plumbing the conformance checks share.
 *
 * Everything here is deliberately dependency-free and deterministic: the
 * testkit is the thing that proves games are deterministic, so it must not
 * itself reach for ambient time, randomness or a comparison library whose
 * key ordering could change under us.
 */

const OBJECT_PROTO: unknown = Object.getPrototypeOf({})

/** Structural equality with strict key sets. `{a: undefined}` !== `{}`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false

  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false

  if (aIsArray) {
    const left = a as readonly unknown[]
    const right = b as readonly unknown[]
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (!deepEqual(left[i], right[i])) return false
    }
    return true
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

/**
 * Canonical JSON: object keys sorted, so two structurally equal values always
 * produce the same string. Used for diff messages and for set membership,
 * never for the equality assertions themselves.
 */
export function stableStringify(value: unknown, depth = 0): string {
  if (depth > 64) return '"<max-depth>"'
  if (value === undefined) return '<undefined>'
  if (value === null) return 'null'
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : `<${String(value)}>`
  if (typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value) ?? 'null'
  if (typeof value === 'bigint') return `<bigint:${value.toString()}>`
  if (typeof value === 'function') return '<function>'
  if (typeof value === 'symbol') return '<symbol>'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1)}`)
    .join(',')
  return `{${body}}`
}

/** Short, stable rendering for failure messages. */
export function preview(value: unknown, maxLength = 400): string {
  const text = stableStringify(value)
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

/** The round trip the platform performs every time state goes to Redis. */
export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A detached copy that shares no references with the original. */
export function detachedClone<T>(value: T): T {
  return structuredClone(value)
}

export interface JsonSafetyProblem {
  readonly path: string
  readonly reason: string
}

/**
 * Walks a value and reports every part of it that would not survive
 * `JSON.stringify` / `JSON.parse`. This is the authoritative check the
 * `JsonSafe<T>` compile-time helper cannot perform.
 */
export function findJsonSafetyProblems(value: unknown): JsonSafetyProblem[] {
  const problems: JsonSafetyProblem[] = []
  const seen = new Set<unknown>()

  const walk = (node: unknown, path: string): void => {
    if (node === null) return
    const type = typeof node
    if (type === 'string' || type === 'boolean') return
    if (type === 'number') {
      if (!Number.isFinite(node as number)) {
        problems.push({ path, reason: `${String(node)} does not survive JSON` })
      }
      return
    }
    if (type === 'undefined') {
      problems.push({ path, reason: 'undefined is dropped by JSON.stringify' })
      return
    }
    if (type === 'bigint' || type === 'function' || type === 'symbol') {
      problems.push({ path, reason: `${type} is not JSON-safe` })
      return
    }
    if (seen.has(node)) {
      problems.push({ path, reason: 'circular reference' })
      return
    }
    seen.add(node)

    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${path}[${index}]`)
      })
      return
    }

    const proto: unknown = Object.getPrototypeOf(node)
    if (proto !== OBJECT_PROTO && proto !== null) {
      const name = (node as object).constructor?.name ?? 'unknown'
      problems.push({
        path,
        reason: `${name} instance is not a plain object; JSON.parse will not rebuild it`,
      })
      return
    }

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path === '' ? key : `${path}.${key}`)
    }
  }

  walk(value, '')
  return problems
}

/**
 * Finds `needle` anywhere inside `haystack` and returns the path to it, or
 * null. A scalar counts as found when it appears as a leaf, as an object key,
 * or as a substring of a string leaf — because `"you hold the ace"` leaks the
 * ace just as surely as `{ card: "ace" }` does.
 */
export function findScalar(haystack: unknown, needle: string | number | boolean): string | null {
  const needleText = String(needle)
  const substringSearch = typeof needle === 'string' && needleText.length >= 2
  const seen = new Set<unknown>()

  const walk = (node: unknown, path: string): string | null => {
    if (node === null || node === undefined) return null
    if (typeof node === 'object') {
      if (seen.has(node)) return null
      seen.add(node)
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const hit = walk(node[i], `${path}[${i}]`)
          if (hit !== null) return hit
        }
        return null
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        const childPath = path === '' ? key : `${path}.${key}`
        if (key === needleText) return `${childPath} (as a key)`
        const hit = walk(child, childPath)
        if (hit !== null) return hit
      }
      return null
    }
    if (Object.is(node, needle)) return path === '' ? '<root>' : path
    if (substringSearch && typeof node === 'string' && node.includes(needleText)) {
      return `${path === '' ? '<root>' : path} (inside a string)`
    }
    return null
  }

  return walk(haystack, '')
}

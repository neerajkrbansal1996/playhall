/**
 * JSON value types.
 *
 * Everything a game persists (state) or emits (views, events, snapshots of
 * turn-based games) must survive a `JSON.stringify` / `JSON.parse` round trip.
 * The platform stores state in Redis and replays it from a match log; a `Map`,
 * a `Set`, a `Date` or a class instance silently becomes something else.
 */

export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface JsonObject {
  readonly [key: string]: JsonValue
}

/**
 * Structural JSON-safety check, for game authors who want the compiler to
 * catch a `Date` or a method sneaking into state.
 *
 * Opt-in: `type _check = AssertJsonSafe<MyState>`. It is a best-effort type
 * (it cannot see through `unknown` or index signatures), so the authoritative
 * check is the round-trip assertion in `@atrium/game-testkit`.
 */
export type JsonSafe<T> = T extends JsonPrimitive
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends readonly (infer U)[]
      ? readonly JsonSafe<U>[]
      : T extends object
        ? { readonly [K in keyof T]: JsonSafe<T[K]> }
        : never

/** Resolves to `T` when `T` is JSON-safe, and to `never` otherwise. */
export type AssertJsonSafe<T> = T extends JsonSafe<T> ? T : never

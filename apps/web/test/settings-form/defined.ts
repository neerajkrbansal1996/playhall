/**
 * Narrow away the `| undefined` that `noUncheckedIndexedAccess` adds to every
 * array index, and fail with a useful message instead of `Cannot read
 * properties of undefined` when the assumption is wrong.
 */
export function defined<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`)
  return value
}

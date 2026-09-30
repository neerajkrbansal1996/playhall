/**
 * Room-code alphabet, shared by the code generator (platform-core) and by any
 * client-side input normalisation. Excludes 0/O/1/I/L so a code read aloud or
 * typed on a phone cannot land on the wrong room.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' as const

export const ROOM_CODE_LENGTH = 6

/**
 * Normalise user input into a candidate room code: upper-case, then keep only
 * alphabet characters. Does not validate length — callers decide whether a
 * partial code is acceptable.
 *
 * **There is deliberately no confusable folding.** The obvious idea is to map
 * a typed `O` to `0`, or `I` to `1` — but both halves of every such pair are
 * excluded from the alphabet, so there is no in-alphabet character to fold
 * *to*. Excluding the ambiguity at generation time is what solves the problem;
 * a fold table on top of that is dead code pretending to be a safety net.
 *
 * Dropping the stray character rather than rejecting the whole input is what
 * makes `ABC-234`, `abc 234` and a code with a trailing period all resolve. A
 * genuinely misread character leaves five usable characters, which fails the
 * length check and lands on the friendly not-found path.
 */
export function normalizeRoomCode(input: string): string {
  const out: string[] = []
  for (const raw of input.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.includes(raw)) out.push(raw)
  }
  return out.join('')
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

/**
 * Room-code alphabet, shared by the code generator (platform-core) and by any
 * client-side input normalisation. Excludes 0/O/1/I/L so a code read aloud or
 * typed on a phone cannot land on the wrong room.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' as const

export const ROOM_CODE_LENGTH = 6

/** Characters a human is likely to substitute, mapped to the canonical form. */
const CONFUSABLES: Record<string, string> = { O: '0', '0': 'O', I: '1', L: '1' }

/**
 * Normalise user input into a candidate room code: upper-case, strip anything
 * outside the alphabet, and fold the obvious confusables. Does not validate
 * length — callers decide whether a partial code is acceptable.
 */
export function normalizeRoomCode(input: string): string {
  const out: string[] = []
  for (const raw of input.toUpperCase()) {
    const ch = ROOM_CODE_ALPHABET.includes(raw) ? raw : undefined
    if (ch) {
      out.push(ch)
      continue
    }
    // '0' -> 'O' is not a legal target (O is excluded), so only fold the
    // directions that land inside the alphabet.
    const folded = CONFUSABLES[raw]
    if (folded && ROOM_CODE_ALPHABET.includes(folded)) out.push(folded)
  }
  return out.join('')
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

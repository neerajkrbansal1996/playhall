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

/**
 * Split `input` into the maximal runs of alphabet characters it contains, after
 * upper-casing. Anything outside `ROOM_CODE_ALPHABET` is a boundary — and that
 * includes `0 1 I L O`, not only punctuation and whitespace, which is what makes
 * the runs useful: the excluded letters are common enough in English that most
 * prose shatters into short fragments rather than forming a six-run of its own.
 */
function canonicalRuns(input: string): string[] {
  const runs: string[] = []
  let run = ''
  for (const raw of input.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.includes(raw)) run += raw
    else if (run !== '') {
      runs.push(run)
      run = ''
    }
  }
  if (run !== '') runs.push(run)
  return runs
}

/**
 * Pull a room code out of input that carries more than the code — an invite
 * link, or a code wrapped in a chat sentence. Returns `undefined` when the
 * input does not unambiguously contain one, which is the caller's signal to
 * fall back to `normalizeRoomCode` + a length cap.
 *
 * **The rule: exactly one run of exactly six alphabet characters.** No URL
 * parsing, no host list, no "strip the scheme" special case — so there is
 * nothing here that a change of product domain could invalidate, and the final
 * name and domain remain an open decision (see `brand.ts`).
 *
 * It holds because `ROOM_CODE_ALPHABET` excludes `0 1 I L O`. `https://` is not
 * one token to this function, it is `HTTPS` — five characters, because `:` and
 * `/` are boundaries. `join/` is `J` then `N`. So the code is normally the only
 * six-run present, and it is found without knowing anything about what precedes
 * it.
 *
 * Two refusals are deliberate, and each is load-bearing:
 *
 * - **A seven-run is not a code.** `ABC2345` — a genuine typo — contains no
 *   six-run, so this returns `undefined` and the caller's cap drops the 7th
 *   character and announces it ([PER-214](/PER/issues/PER-214)). Taking the
 *   first six characters of an over-long run would silently swallow exactly the
 *   loss that issue exists to report. A substring search would also find
 *   `ABC234` *inside* `ABC2345`, which is why this matches whole runs only.
 * - **Two six-runs are not a code either.** Nothing distinguishes them, so
 *   guessing would be a coin flip presented as certainty; `undefined` routes the
 *   input to the cap, which keeps the first six and says it dropped something.
 *
 * A six-run can still be the wrong six — a host or a word of prose that happens
 * to be six alphabet characters long, next to a code that is not. That is the
 * residual risk and it is strictly smaller than the one it replaces, where the
 * *leading* fragment of any prose won by position alone.
 */
export function extractRoomCode(input: string): string | undefined {
  const sixes = canonicalRuns(input).filter((run) => run.length === ROOM_CODE_LENGTH)
  return sixes.length === 1 ? sixes[0] : undefined
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

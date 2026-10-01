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
 * What `extractRoomCode` found. The two refusals are separate outcomes rather
 * than one `undefined`, because they call for different things to be said to
 * the player: `ambiguous` means we had candidates and could not choose between
 * them, `declined` means there was no candidate at all.
 */
export type RoomCodeExtraction =
  | { readonly outcome: 'extracted'; readonly code: string }
  | { readonly outcome: 'ambiguous'; readonly codes: readonly string[] }
  | { readonly outcome: 'declined' }

/**
 * Pull a room code out of input that carries more than the code — an invite
 * link, or a code wrapped in a chat sentence. Anything but `extracted` is the
 * caller's signal to fall back to `normalizeRoomCode` + a length cap.
 *
 * **The rule: exactly one _distinct_ run of exactly six alphabet characters.**
 * No URL parsing, no host list, no "strip the scheme" special case — so there is
 * nothing here that a change of product domain could invalidate, and the final
 * name and domain remain an open decision (see `brand.ts`).
 *
 * It holds because `ROOM_CODE_ALPHABET` excludes `0 1 I L O`. `https://` is not
 * one token to this function, it is `HTTPS` — five characters, because `:` and
 * `/` are boundaries. `join/` is `J` then `N`. So the code is normally the only
 * six-run present, and it is found without knowing anything about what precedes
 * it.
 *
 * **Why _distinct_** ([PER-250](/PER/issues/PER-250) B1). Every lobby hands its
 * host both a link and a code, so "here's the link …/join/ABC234 — code is
 * ABC234" is a message shape the product itself produces. Counting runs rather
 * than values made that the one shape where the same code, said twice, read as
 * two candidates and lost to the cap. Deduplicating costs one `Set` and moves no
 * other case: two six-runs that disagree are still ambiguous.
 *
 * Two refusals are deliberate, and each is load-bearing:
 *
 * - **A seven-run is not a code.** `ABC2345` — a genuine typo — contains no
 *   six-run, so this declines and the caller's cap drops the 7th character and
 *   announces it ([PER-214](/PER/issues/PER-214)). Taking the first six
 *   characters of an over-long run would silently swallow exactly the loss that
 *   issue exists to report. A substring search would also find `ABC234` *inside*
 *   `ABC2345`, which is why this matches whole runs only.
 * - **Two different six-runs are not a code either.** Nothing distinguishes
 *   them, so guessing would be a coin flip presented as certainty. The caller
 *   keeps the first six and says it could not choose.
 *
 * ## The residual risk, stated accurately
 *
 * A six-run can still be the wrong six: a word of prose that happens to be six
 * alphabet characters long, standing next to a code that is *not* six. Then the
 * prose is the only six-run present, so this accepts it confidently and the
 * caller says nothing.
 *
 * ```
 * 'Secret code ABC2345'  -> SECRET      'Secret code ABC23'  -> SECRET
 * 'Your answer: ABC2345' -> ANSWER
 * ```
 *
 * For that family the risk is **larger** than the one it replaces, not smaller:
 * before extraction the cap also landed `SECRET`, but it said something had been
 * dropped. These rows are pinned in `room-code.test.ts`, and one of them at the
 * component level, so the hole is found by reading the tests rather than
 * rediscovered in support.
 *
 * It is not closed here because every mechanism that closes it costs more than
 * it saves, measured rather than assumed — see that test file's
 * `the family this rule is silently wrong about` block, which runs the two
 * candidate rules over the pinned corpus. "Decline when any run is longer than
 * six" throws away `?utm_source=whatsapp` (`WHATSAPP` is an eight-run); "decline
 * when some other run is near code length" throws away every `https://` link
 * (`HTTPS` is a five-run). Both trade a rare wrong code for a common lost one.
 * The property to aim at, if a cheaper mechanism appears: *do not go silent
 * about a run rejected for being the wrong length* — that run is usually the
 * player's real code, mistyped.
 */
export function extractRoomCode(input: string): RoomCodeExtraction {
  const sixes = canonicalRuns(input).filter((run) => run.length === ROOM_CODE_LENGTH)
  const [first, ...rest] = [...new Set(sixes)]
  if (first === undefined) return { outcome: 'declined' }
  if (rest.length === 0) return { outcome: 'extracted', code: first }
  return { outcome: 'ambiguous', codes: [first, ...rest] }
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

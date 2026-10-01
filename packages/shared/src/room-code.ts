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
 *
 * `codes` is a **non-empty** tuple rather than `readonly string[]`, so that a
 * caller can read `codes[0]` without a null check under
 * `noUncheckedIndexedAccess`. That is not a convenience: the difference between
 * `ambiguous` and `declined` is precisely that candidates exist, so a type that
 * admitted an empty list would describe a state this function cannot return.
 * `join-by-code-form.tsx` puts `codes[0]` in the field — one of the player's
 * real candidates beats the first six characters of the surrounding URL — and
 * that is only sound because the type guarantees there is one.
 */
export type RoomCodeExtraction =
  | { readonly outcome: 'extracted'; readonly code: string }
  | { readonly outcome: 'ambiguous'; readonly codes: readonly [string, ...string[]] }
  | { readonly outcome: 'declined' }

/**
 * Pull a room code out of input that carries more than the code — an invite
 * link, or a code wrapped in a chat sentence. Anything but `extracted` is the
 * caller's signal to fall back to `normalizeRoomCode` + a length cap — unless
 * `capWouldKeepNoise` says that fallback has nothing to be right about, which is
 * the one case where there is no value to show at all ([PER-277](/PER/issues/PER-277)).
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
 *   them, so guessing would be a coin flip presented as certainty. All of them
 *   are returned and the caller says it could not choose.
 *
 *   Returning the whole list rather than `declined` is what lets the caller put
 *   a *candidate* in the field instead of the first six characters of the
 *   surrounding text. On the shape that motivates this — an invite link with a
 *   six-character query value, `…/r/ABC234?ref=XYZ789` — the cap's answer is
 *   `HTTPSE`, which is not in `codes` at all and is not a thing the player has
 *   ever seen. `codes[0]` is `ABC234`, the code in the path. Neither is
 *   *chosen*; the field is flagged invalid and says there was more than one
 *   either way. But one of the two is recognisable to the person who pasted it,
 *   and the other is scheme noise.
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

/**
 * Would "normalise, then keep the first six" land six characters that are not a
 * damaged copy of anything the player typed? ([PER-277](/PER/issues/PER-277))
 *
 * Only meaningful when `extractRoomCode` has already `declined`: it is the
 * caller's question about its own fallback, not a third extraction outcome. The
 * cap itself stays in `JoinByCodeForm`, because the six-cell field is what makes
 * a bound necessary; what lives here is the run structure the judgement needs.
 *
 * ## The claim the cap's announcement makes
 *
 * `OVERFLOW_MESSAGE` says *only the first 6 characters were used — check the
 * code you were sent*. Both halves presume the kept six are the player's code
 * with the tail trimmed off. That presumption is sound for `ABC2345` and
 * `ABC-2345`, and false for `https://playhall.app/play/chess`, where the field
 * ends up holding `HTTPSP`: a value `isValidRoomCode` accepts, assembled out of
 * the scheme, that the player has never seen and cannot check. PER-214's note
 * fires, so this was never the silent-wrong-value class — but a true sentence
 * that does not describe what happened is its own defect.
 *
 * ## The rule, and why it is these two clauses
 *
 * **More than one canonical character was discarded, *and* the six kept do not
 * all come from the first run.** Both are needed, and each rules out one family
 * the other would wreck:
 *
 * - *Dropped more than one.* `ABC-2345` is seven canonical characters stitched
 *   out of two runs, so the second clause alone would clear it — and that is
 *   [PER-197](/PER/issues/PER-197)'s shape, a real code typed with a separator,
 *   where `ABC234` is exactly the right value and the note is exactly right
 *   about it.
 * - *Not all from the first run.* `ABC23456` is one long run, so the first
 *   clause alone would clear it — and an over-long code is precisely what
 *   PER-214's note was written for. If the six are the head of a single token
 *   the player typed, "only the first six were used" is a true account of that
 *   token however long it ran on.
 *
 * Checking the **first** run is the whole of the second clause because the cap
 * takes canonical characters in order: they all come from one run exactly when
 * that run is already at least `ROOM_CODE_LENGTH` long.
 *
 * ## No URL shape, measured not assumed
 *
 * Nothing here asks whether the input is a link — same constraint as
 * `extractRoomCode`, same reason: the product name and domain are an open board
 * decision ([PER-2](/PER/issues/PER-2)) and a rule keyed on URL shape has to be
 * re-litigated when they land. The two candidates PER-277 proposed were measured
 * against the pinned corpus and both lost, which is recorded in
 * `room-code-extract.test.ts`:
 *
 * - *"no run of 4-6 characters"* misses **every** codeless link — `HTTPS` is a
 *   five-run and `AYHA` a four-run — and clears `ABC2345`, the PER-214 row.
 * - *"the input contains `://`"* is clean but partial: it misses
 *   `www.playhall.app`, the form a chat app delivers once it has stripped the
 *   scheme, and `Code: ABC2345`, which turns out to be in this family too (the
 *   cap keeps `CDEABC` there, not `ABC234`).
 */
export function capWouldKeepNoise(input: string): boolean {
  const runs = canonicalRuns(input)
  const canonicalLength = runs.reduce((total, run) => total + run.length, 0)
  if (canonicalLength <= ROOM_CODE_LENGTH + 1) return false
  const [first] = runs
  return first !== undefined && first.length < ROOM_CODE_LENGTH
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false
  return true
}

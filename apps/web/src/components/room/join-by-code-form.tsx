'use client'

import { useId, useState } from 'react'
import { AlertCircle } from 'lucide-react'

import {
  ROOM_CODE_LENGTH,
  capWouldKeepNoise,
  extractRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '@playhall/shared'

import { Button } from '@/components/ui/button'
import { testIds } from '@/lib/testids'

export interface JoinByCodeFormProps {
  /**
   * Called with a **canonical** 6-character code. The form never hands up a
   * lower-cased or punctuated value, so a caller cannot forget to normalise.
   */
  readonly onJoin: (code: string) => void
  /** Server-side outcome to show — unknown room, expired room, room closed. */
  readonly error?: string
  /** True while a join is in flight. */
  readonly pending?: boolean
  readonly className?: string
}

/**
 * Join-by-code, the second of the landing page's two paths.
 *
 * Normalisation happens **on input**, not on submit, using the same
 * `normalizeRoomCode` the server uses. A player who pastes `abc 234` or
 * `ABC-234` from a chat message watches it become `ABC234` in the field, so the
 * thing they can see is the thing that will be sent. Doing it only on submit
 * would leave the visible value and the request disagreeing, which is exactly
 * the class of bug that makes "I typed it right" support reports unfalsifiable.
 *
 * ## Why the length cap is in `onChange` and not `maxLength`
 *
 * It used to be `maxLength={ROOM_CODE_LENGTH}` on the input, justified as "a
 * 7th character is never part of a code". That is true of **canonical**
 * characters and false of **raw** ones — and `maxLength` is enforced by the
 * browser on the raw inserted string, before React's `onChange` can strip a
 * separator. So both of the examples above, seven raw characters each, were
 * clipped to `abc 23` on paste and normalised to a five-character `ABC23`, in a
 * field the player had no way to tell was wrong ([PER-197](/PER/issues/PER-197)).
 *
 * The loss was not a fixed off-by-one, which is why the fix is a reordering and
 * not an arithmetic tweak: what survived was the canonical characters among the
 * first six **raw** ones, so `  abc-234  ` — the shape a double-tap selection
 * produces on a phone — landed as `ABC`, and an indented chat line emptied the
 * field entirely.
 *
 * Only the bulk-insert path broke: typing `abc 234` keystroke by keystroke
 * normalises as it arrives, so the value never grows past six and `maxLength`
 * never bit. `e2e/room-contract.spec.ts` asserts the typed and bulk-inserted
 * paths separately, and keeps one case per inserted shape, so a regression in
 * one cannot hide behind the other.
 *
 * Capping with `.slice(0, ROOM_CODE_LENGTH)` after normalising keeps the value
 * bounded — the reason `maxLength` was there — while letting separators be
 * stripped first.
 *
 * ## Why there is a hint before the first keystroke
 *
 * `normalizeRoomCode` drops anything outside `ROOM_CODE_ALPHABET`, and that
 * alphabet deliberately excludes every visually confusable glyph. So a player
 * who hand-types the `O` they believe they can see in `ABC0234` gets **no
 * feedback of any kind** — no character appears, the field does not grow, and
 * nothing is announced. The keystroke is simply swallowed
 * ([PER-215](/PER/issues/PER-215), [PER-221](/PER/issues/PER-221)).
 *
 * Before this, the only length affordance was the `ABC234` placeholder — which
 * is not an accessible description and disappears on the first keystroke — plus
 * a message that arrives after a press. Both are too late: they describe a
 * mistake instead of preventing it. The fix is a hint that is already there.
 *
 * It renders as a plain `<p>`, **not** `role="status"` and **not** a live
 * region: the copy never changes after mount, so there is nothing to announce,
 * and a spurious live region would compete with the `role="alert"` message node
 * below. It reaches assistive technology purely through `aria-describedby`.
 * Keeping it role-less is also what keeps `getByRole('alert')` unambiguous in
 * the tests.
 *
 * It sits **above** the input, grouped with the label, because the input row is
 * `flex-col sm:flex-row`: a hint placed after that row lands below the Join
 * button on a phone, where it reads as a description of the button rather than
 * of the field.
 *
 * ## Why the cap announces itself
 *
 * The cap still has to drop a 7th *canonical* character, because the field is a
 * fixed six-cell display and an unbounded value would let a pasted chat line
 * stretch it. But dropping one silently was the same "silent wrong value" class
 * as [PER-197](/PER/issues/PER-197) ([PER-214](/PER/issues/PER-214)): `ABC2345`
 * became `ABC234`, and the player then joined **a different room than the one
 * they were sent**, or landed on the friendly not-found page, with nothing
 * connecting either outcome to the character we removed.
 *
 * So the `overflowed` paste outcome announces it, through the same
 * `role="alert"` node and `aria-describedby` wiring the short-code and server
 * messages already use — one message slot, so the two can never stack or
 * contradict each other. Three properties of that choice are load-bearing:
 *
 * - It is keyed on the **canonical** length, not the raw one. Seven raw
 *   characters that normalise to six (`ABC-234`) lost nothing, and shouting at
 *   that player would re-break what PER-197 just fixed.
 * - It fires **while typing**, unlike `tooShort`, which waits for a press. The
 *   two are not comparable: a half-typed code is an expected intermediate
 *   state, whereas a character we threw away is a completed loss, and saying so
 *   late is saying so after the wrong room has already opened.
 * - It does **not** veto the press. Six canonical characters is a well-formed
 *   code and the server owns whether that room exists. The message stays up
 *   across the press as the account of what we dropped — and because
 *   `overflowed` implies the value *is* six canonical characters, which
 *   `isValidRoomCode` accepts, it can never coexist with `tooShort`.
 *
 * ## Why a pasted invite link yields its code ([PER-242](/PER/issues/PER-242))
 *
 * "Normalise, then cap" has one failure mode the announcement above cannot
 * repair: when the dropped characters are at the **end**, the six that survive
 * are not the code. `https://example.test/join/ABC234` kept `HTTPSE`, and
 * `Code: ABC234` kept `CDEABC` — both well-formed codes, so nothing downstream
 * could tell. The player was told characters were dropped, but not that the ones
 * kept were wrong, because the field could not know. And the invite link is the
 * *primary* share artifact: every lobby has a link as well as a code, so "tap
 * the link text, paste it" is the most likely paste there is.
 *
 * So `onChange` tries `extractRoomCode` before the cap. **The rule is: exactly
 * one _distinct_ run of exactly six alphabet characters, where a run is a
 * maximal stretch of `ROOM_CODE_ALPHABET` characters after upper-casing.** It
 * lives in `packages/shared`, next to the alphabet it depends on, where its own
 * doc comment carries the reasoning. Three consequences are worth having here:
 *
 * - **No URL parsing and no host.** `:` and `/` are boundaries like any other
 *   non-alphabet character, so `https://` is just a five-run. The rule therefore
 *   hard-codes no domain and survives the open naming decision untouched; it
 *   also works on a link whose scheme a chat app stripped, which URL parsing
 *   would not.
 * - **`ABC2345` is unaffected.** Seven canonical characters are one seven-run,
 *   not a six-run, so extraction declines and the cap still drops the 7th and
 *   announces it. That pairing is the whole reason the rule matches *whole runs*
 *   rather than searching for a six-character substring.
 * - **A successful extraction is silent.** The overflow note says which six
 *   survived and asks the player to check the code they were sent; once the
 *   field shows the code they were *actually* sent, that is a false alarm, and
 *   it was being raised on `ABC234 join me` — a paste that joins the right room
 *   — before this. The cap's announcement still fires for everything extraction
 *   declines *and* the cap can salvage — see the PER-277 section below for the
 *   declines it cannot.
 *
 * Silence has a known cost, and it is not smaller everywhere. `Secret code
 * ABC2345` — a six-letter word of prose beside a *mistyped* code — has exactly
 * one six-run, so the field now shows `SECRET` and says nothing, where before it
 * showed `SECRET` and at least said something had been dropped. That family is
 * pinned rather than papered over, here and in `room-code.ts`, which also
 * records the two candidate fixes and the measurement that rejects both.
 *
 * ## Ambiguity is a different message, not a quieter one ([PER-250](/PER/issues/PER-250))
 *
 * Two *different* six-runs in one paste are not guessed at. What the field says
 * about that is its own string, because the overflow copy's diagnosis is false
 * here — nothing was "extra", we had two candidates and no way to choose — and
 * asking the player to check a value we picked is the wrong instruction when
 * what we need is the one we could not pick. `AMBIGUOUS_MESSAGE` says that
 * instead, and outranks the overflow note: a paste with two candidates always
 * overflows too, so without an order the less accurate of the two would win by
 * position.
 *
 * **The value shown is `codes[0]`, not the cap's answer.** This is the one place
 * the three outcomes do not share a fallback, and the reason is that the cap's
 * answer here is not even one of the candidates. The shape that motivates it is
 * an invite link carrying a six-character query value — a `?ref=`, a share
 * token, a campaign id:
 *
 * ```
 * …/r/ABC234                      -> ABC234  extracted, silent
 * …/r/ABC234?utm_source=whatsapp  -> ABC234  extracted, silent  (WHATSAPP is an 8-run)
 * …/r/ABC234?ref=XYZ789           -> ABC234  ambiguous          (cap would say HTTPSE)
 * …/r/ABC234?s=ABC234             -> ABC234  extracted, silent  (one distinct run)
 * ```
 *
 * Only a *different* six-run in the query reaches the ambiguous row, and there
 * the cap's `HTTPSE` is scheme noise the player has never seen, while `codes[0]`
 * is the code in the link's path. Showing a candidate is not choosing one:
 * `aria-invalid` is true and the message still says there was more than one. It
 * is the difference between "we think it might be this, check" and a six-letter
 * value with no relationship to anything that was pasted.
 *
 * The same code written *twice* — "here's the link …/join/ABC234 — code is
 * ABC234", the shape we cause by handing every host both a link and a code — is
 * not ambiguous at all. The rule counts distinct runs, so that extracts
 * silently like any other link.
 *
 * ## A paste with no code in it empties the field ([PER-277](/PER/issues/PER-277))
 *
 * The third thing the cap can be is simply wrong, with nothing to be right
 * about. `https://example.test/play/chess` has no six-run, so extraction
 * declines, and the cap keeps the first six alphabet characters of the URL:
 * `HTTPSE`. For *any* schemed link that is always the scheme plus one character,
 * whatever the host, because `HTTPS` is a five-run.
 *
 * This was never the silent-wrong-value class — the overflow note fires, so the
 * player is told something. What they are told is the defect: *only the first 6
 * characters were used — check the code you were sent* is a true sentence that
 * does not describe what happened. Nothing they were sent was used, and there is
 * no code in that link to check. Pressing Join sent `HTTPSE`, which
 * `isValidRoomCode` accepts, and landed on the friendly not-found page.
 *
 * So the cap no longer runs when its answer would be noise. `capWouldKeepNoise`
 * in `packages/shared` carries the rule and the measurement behind it — **more
 * than one canonical character discarded, and the six kept not all from the first
 * run** — and the two clauses are what keep PER-197's `ABC-2345` and PER-214's
 * `ABC2345` on the overflow path where they belong. Three properties here:
 *
 * - **The field is emptied, not filled with a guess.** A six-cell field showing
 *   `HTTPSE` asserts that we read a code out of the paste. We did not. Emptying
 *   it also spares the player a select-all before they can retype, which is the
 *   one thing the old behaviour cost them in taps.
 * - **The press is still refused, not routed to the server.** An empty value
 *   fails `isValidRoomCode`, so `onJoin` is not called — unlike the overflow
 *   case, where six canonical characters are a well-formed code and the server
 *   is the authority on whether that room exists. Here there is nothing to ask
 *   it about.
 * - **`noCode` outranks `tooShort`, so the press does not swap the message.**
 *   Both are live after a press on an emptied field, and *why* the field is
 *   empty is more use than `Enter the code from your invite.` alone — which is
 *   why `NO_CODE_MESSAGE` ends with that sentence rather than competing with it.
 *
 * It costs one row that used to be told about its loss: `Code: ABC2345` kept
 * `CDEABC` — not `ABC234`, which is the point — under the overflow note, and now
 * empties instead. That row was in this family all along; the ticket's table only
 * listed links.
 *
 * ## Why none of the five messages restate the length rule
 *
 * The hint says `${ROOM_CODE_LENGTH} characters` two lines above the field, so a
 * message that opens `A room code is 6 characters.` states a rule the player
 * can already read — and, because `aria-describedby` composes the hint and the
 * message into **one** accessible description, a screen reader hears that rule
 * twice in a single breath ([PER-225](/PER/issues/PER-225)). Each message now
 * carries only the part the hint cannot:
 *
 * - overflow names *which* six survived the cap, the fact that actually
 *   matters, because the field now holds a well-formed code for a possibly
 *   different room;
 * - ambiguity names the count, because "more than one" is the whole diagnosis
 *   and the instruction that follows from it is different from every other
 *   message's: enter one code, do not re-check the one we showed;
 * - a codeless paste names the absence, which is the fact the player cannot see
 *   from an emptied field, and then borrows the empty field's instruction;
 * - an empty field gets an instruction rather than a specification;
 * - a partial code gets its own length, which is the one number the player
 *   cannot read off a `tracking-[0.3em]` six-cell field at a glance.
 *
 * A server `error` still outranks all four: an actual join outcome is more
 * actionable than our note about the input.
 *
 * The submit button is **never disabled for validation**. A disabled control
 * with no explanation is the worst of both worlds on a phone: nothing happens
 * on tap and no assistive technology announces why. Pressing it with a short
 * code produces a real error message instead, wired to the input through
 * `aria-describedby`. It *is* disabled while a join is in flight, where the
 * label itself ("Joining…") supplies the explanation.
 */

/**
 * The glyph list is hard-coded rather than computed from the 26 + 10 characters
 * `ROOM_CODE_ALPHABET` omits, because computing it would ship the full alphabet
 * and a set difference to the landing page to render five characters that have
 * not changed since the alphabet was chosen. `testids.test.tsx` pins the two
 * directions instead — the hint may not name a permitted glyph, and may not
 * omit an excluded one — so the literal cannot go stale silently.
 */
const HINT = `${ROOM_CODE_LENGTH} characters. Codes never use O, 0, I, 1 or L.`

const EMPTY_MESSAGE = 'Enter the code from your invite.'
const OVERFLOW_MESSAGE = `Only the first ${ROOM_CODE_LENGTH} characters were used. Check the code you were sent.`
const AMBIGUOUS_MESSAGE = `More than one ${ROOM_CODE_LENGTH}-character code in that paste — enter just the one you were sent.`
/**
 * It does not say *link*, because nothing upstream of it knows whether the paste
 * was one — see `capWouldKeepNoise`. It does not restate the length either; the
 * hint two lines above the field already gives it, and PER-225 is why no message
 * here repeats a rule the player can read.
 *
 * The second clause is `EMPTY_MESSAGE`'s, deliberately: this outcome *leaves the
 * field empty*, so the instruction that fits an empty field is the right one.
 */
const NO_CODE_MESSAGE = 'No room code in that paste. Enter the code from your invite.'

/**
 * What the last `onChange` made of the input, beyond the value it produced.
 * One state rather than two booleans: a paste carrying two candidates also
 * overflows, and these are two accounts of the same event, so they must not be
 * able to both be set and race for the one message slot.
 */
type PasteOutcome = 'clean' | 'overflowed' | 'ambiguous' | 'noCode'

/**
 * The single message the field shows, in authority order: a real join outcome,
 * then what we could not do with the paste, then a code too short to send.
 *
 * The three paste outcomes are mutually exclusive by construction — one state,
 * not three flags — so their order here is readability, not precedence. Only
 * `error` outranks anything.
 */
function fieldMessage(
  error: string | undefined,
  paste: PasteOutcome,
  tooShort: boolean,
  code: string,
): string | undefined {
  if (error !== undefined) return error
  if (paste === 'ambiguous') return AMBIGUOUS_MESSAGE
  if (paste === 'noCode') return NO_CODE_MESSAGE
  if (paste === 'overflowed') return OVERFLOW_MESSAGE
  if (!tooShort) return undefined
  if (code.length === 0) return EMPTY_MESSAGE
  return `That code has ${code.length} of ${ROOM_CODE_LENGTH} characters.`
}

export function JoinByCodeForm({ onJoin, error, pending = false, className }: JoinByCodeFormProps) {
  const inputId = useId()
  const hintId = `${inputId}-hint`
  const messageId = `${inputId}-message`

  const [code, setCode] = useState('')
  // Only set once the player has actually pressed join, so the field does not
  // shout at someone who is still typing their second character.
  const [tooShort, setTooShort] = useState(false)
  // Set as it happens, by contrast: a dropped character is already lost, and
  // the field cannot show the player what it removed.
  const [paste, setPaste] = useState<PasteOutcome>('clean')

  const message = fieldMessage(error, paste, tooShort, code)
  // Hint first, then the message, matching `fieldIds()` in
  // `components/settings-form/field-shell.tsx` — one hint/error composition
  // order for the whole platform rather than one per form.
  const describedBy = message ? `${hintId} ${messageId}` : hintId

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        if (!isValidRoomCode(code)) {
          setTooShort(true)
          return
        }
        setTooShort(false)
        onJoin(code)
      }}
    >
      <div className="flex flex-col gap-2">
        {/*
          Label and hint are one group, tighter than the gap to the field, so
          the hint reads as part of the label rather than as a third sibling.
        */}
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            Join with a code
          </label>

          <p id={hintId} className="text-muted-foreground text-xs">
            {HINT}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={inputId}
            data-testid={testIds.joinCodeInput}
            data-value={code}
            // The canonical alphabet is upper-case letters and digits, so the
            // numeric-ish keypad is wrong; `characters` gets the phone keyboard
            // to stop auto-capitalising *and* stop lower-casing.
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="go"
            // Deliberately **no** `maxLength`. See the component doc comment:
            // the browser applies it to the raw string before `onChange` runs,
            // which truncates every pasted code that carries a separator. The
            // cap lives in `onChange` instead, after normalisation.
            placeholder="ABC234"
            value={code}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setTooShort(false)

              // Extraction first: an invite link or a chat sentence carrying one
              // distinct six-run yields that run, and nothing the player needed
              // was dropped, so there is nothing to announce.
              const extraction = extractRoomCode(event.target.value)
              if (extraction.outcome === 'extracted') {
                setCode(extraction.code)
                setPaste('clean')
                return
              }

              // Two candidates and no way to choose. Show the first *candidate*
              // rather than falling through to the cap, whose answer on the
              // shape this exists for — a link with a six-character query value
              // — is the scheme (`HTTPSE`) and not a candidate at all. See the
              // ambiguity section in the doc comment above.
              if (extraction.outcome === 'ambiguous') {
                setCode(extraction.codes[0])
                setPaste('ambiguous')
                return
              }

              // No candidate at all, and the cap's six would be stitched out of
              // the surrounding noise rather than trimmed off the player's code
              // — `https://example.test/play/chess` → `HTTPSP`. Leave the field
              // empty and say so, because the alternative is to display a value
              // `isValidRoomCode` accepts that the player has never seen, under
              // a note asking them to check it. See the PER-277 section above.
              if (capWouldKeepNoise(event.target.value)) {
                setCode('')
                setPaste('noCode')
                return
              }

              // Otherwise normalise, then cap. A 7th *canonical* character is
              // still never part of a code, so it is still dropped — but a 7th
              // *raw* character routinely is one, once a separator is gone,
              // which is why the overflow flag reads the canonical length and
              // not `event.target.value.length`.
              const canonical = normalizeRoomCode(event.target.value)
              setCode(canonical.slice(0, ROOM_CODE_LENGTH))
              setPaste(canonical.length > ROOM_CODE_LENGTH ? 'overflowed' : 'clean')
            }}
            className="h-11 w-full rounded-md border bg-background px-4 text-center font-mono text-lg tracking-[0.3em] uppercase outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive sm:w-48 sm:text-left"
          />

          <Button type="submit" data-testid={testIds.joinSubmit} disabled={pending}>
            {pending ? 'Joining…' : 'Join'}
          </Button>
        </div>

        {/*
          `role="alert"` rather than a polite live region on a permanently-mounted
          node. The reason this used to give — the message only ever appears in
          response to a press — is no longer true: `overflowed` fires while
          typing. The choice stands on a different one. A polite region queues
          behind the character echo the field is already producing, so its
          announcement can land after the player has tapped Join; for a character
          that is already gone, that is too late to be acted on. Icon plus text,
          never colour alone.

          The hint above carries no role, so this stays the field's only `alert`.
        */}
        {message ? (
          <p
            id={messageId}
            role="alert"
            className="flex items-center gap-1.5 text-sm text-destructive [&_svg]:size-4"
          >
            <AlertCircle aria-hidden="true" />
            {message}
          </p>
        ) : null}
      </div>
    </form>
  )
}

'use client'

import { useId, useState } from 'react'
import { AlertCircle } from 'lucide-react'

import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@playhall/shared'

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
 * So `overflowed` announces it, through the same `role="alert"` node and
 * `aria-describedby` wiring the short-code and server messages already use —
 * one message slot, so the two can never stack or contradict each other. Three
 * properties of that choice are load-bearing:
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
 * ## Why none of the three messages restate the length rule
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
 * - an empty field gets an instruction rather than a specification;
 * - a partial code gets its own length, which is the one number the player
 *   cannot read off a `tracking-[0.3em]` six-cell field at a glance.
 *
 * A server `error` still outranks both: an actual join outcome is more
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

/**
 * The single message the field shows, in authority order: a real join outcome,
 * then a character we dropped, then a code too short to send.
 */
function fieldMessage(
  error: string | undefined,
  overflowed: boolean,
  tooShort: boolean,
  code: string,
): string | undefined {
  if (error !== undefined) return error
  if (overflowed) return OVERFLOW_MESSAGE
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
  const [overflowed, setOverflowed] = useState(false)

  const message = fieldMessage(error, overflowed, tooShort, code)
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
              // Normalise first, then cap. A 7th *canonical* character is still
              // never part of a code, so it is still dropped — but a 7th *raw*
              // character routinely is one, once a separator is gone, which is
              // why the overflow flag reads the canonical length and not
              // `event.target.value.length`.
              const canonical = normalizeRoomCode(event.target.value)
              setCode(canonical.slice(0, ROOM_CODE_LENGTH))
              setOverflowed(canonical.length > ROOM_CODE_LENGTH)
              setTooShort(false)
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

          `items-start` plus `[&_svg]:mt-0.5`, not `items-center`: the overflow
          message wraps to two lines at 360 px, and centring against the whole
          block parks the icon in the gutter between them, aligned to neither.
          `mt-0.5` is the exact centring offset for the *first* line, not a nudge
          by eye — `text-sm` is a 14 px font in a 20 px line box and the icon is
          `size-4` = 16 px, so (20 − 16) / 2 = 2 px. One-line messages therefore
          render pixel-identically to the old `items-center`. `shrink-0` is
          defensive: `size-4` sets a width but not a flex-basis, so a future copy
          revision carrying a long unbroken token could squeeze the icon into an
          ellipse.
        */}
        {message ? (
          <p
            id={messageId}
            role="alert"
            className="flex items-start gap-1.5 text-sm text-destructive [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <AlertCircle aria-hidden="true" />
            {message}
          </p>
        ) : null}
      </div>
    </form>
  )
}

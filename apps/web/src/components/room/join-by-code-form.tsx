'use client'

import { useId, useState } from 'react'
import { AlertCircle, Link2 } from 'lucide-react'

import { ROOM_CODE_LENGTH, isValidRoomCode } from '@playhall/shared'

import { Button } from '@/components/ui/button'
import { testIds } from '@/lib/testids'

import { readRoomCodeInput, type RoomCodeInputReading } from './read-room-code-input'

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
 *   code and the server owns whether that room exists, so blocking submit would
 *   only strand a player whose code really is those six. The message stays up
 *   across the press as the account of what we dropped.
 *
 * A server `error` still outranks it: an actual join outcome is more actionable
 * than our note about the input.
 *
 * ## Why an invite link is not read as code characters
 *
 * `readRoomCodeInput` carries that decision and its reasoning
 * ([PER-235](/PER/issues/PER-235)). What lands here is that the field has a
 * **second, non-error message tone**: lifting `ABC234` out of a pasted
 * `https://…/r/ABC234` replaces forty visible characters with six, which the
 * player has to be told about — but it is a *success*, and announcing it
 * through the destructive-styled `role="alert"` slot with `aria-invalid` set
 * would mark a field that is about to join the right room as broken.
 *
 * So the slot takes a tone. `error` keeps everything it had: the alert role,
 * the destructive colour, `aria-invalid`, the warning icon. `note` is
 * `role="status"`, muted, link-icon, and leaves `aria-invalid` unset. It is
 * still **one** slot, so the messages can never stack or contradict.
 *
 * The submit button is **never disabled for validation**. A disabled control
 * with no explanation is the worst of both worlds on a phone: nothing happens
 * on tap and no assistive technology announces why. Pressing it with a short
 * code produces a real error message instead, wired to the input through
 * `aria-describedby`. It *is* disabled while a join is in flight, where the
 * label itself ("Joining…") supplies the explanation.
 */
const TOO_SHORT_MESSAGE = `A room code is ${ROOM_CODE_LENGTH} characters.`
const OVERFLOW_MESSAGE = `${TOO_SHORT_MESSAGE} Extra characters were not used — check the code you were sent.`
const LINK_MESSAGE = 'Took the code from that link.'
const LINK_WITHOUT_CODE_MESSAGE = `That looks like a link with no room code in it. Open the link instead, or paste just the ${ROOM_CODE_LENGTH}-character code.`

/** An empty field has been read as nothing, not as a link and not as a loss. */
const EMPTY_READING: RoomCodeInputReading = {
  code: '',
  source: 'characters',
  overflowed: false,
}

interface FieldMessage {
  readonly text: string
  /** `error` marks the field invalid; `note` reports what we did with the input. */
  readonly tone: 'error' | 'note'
}

/**
 * The single message the field shows, in authority order: a real join outcome,
 * then a link we could not read, then a character we dropped, then a code too
 * short to send, and last the note that a link was read for them.
 *
 * The note sits at the bottom because every message above it is a reason the
 * press will not do what the player wants, and the note is a reason it will.
 */
function fieldMessage(
  error: string | undefined,
  source: RoomCodeInputReading['source'],
  overflowed: boolean,
  tooShort: boolean,
): FieldMessage | undefined {
  if (error !== undefined) return { text: error, tone: 'error' }
  if (source === 'link-without-code') return { text: LINK_WITHOUT_CODE_MESSAGE, tone: 'error' }
  if (overflowed) return { text: OVERFLOW_MESSAGE, tone: 'error' }
  if (tooShort) return { text: TOO_SHORT_MESSAGE, tone: 'error' }
  if (source === 'link') return { text: LINK_MESSAGE, tone: 'note' }
  return undefined
}

export function JoinByCodeForm({ onJoin, error, pending = false, className }: JoinByCodeFormProps) {
  const inputId = useId()
  const messageId = `${inputId}-message`

  const [code, setCode] = useState('')
  // Only set once the player has actually pressed join, so the field does not
  // shout at someone who is still typing their second character.
  const [tooShort, setTooShort] = useState(false)
  // The rest of the reading is kept as it happens, by contrast: a dropped
  // character is already lost and a link has already been swapped for its
  // code, and the field cannot show the player either one after the fact.
  const [reading, setReading] = useState<RoomCodeInputReading>(EMPTY_READING)

  const message = fieldMessage(error, reading.source, reading.overflowed, tooShort)

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
        <label htmlFor={inputId} className="text-sm font-medium">
          Join with a code
        </label>

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
            // `aria-invalid` tracks the *tone*, not the presence of a message:
            // the field holding a code we lifted out of a link is as valid as
            // one the player typed.
            aria-invalid={message?.tone === 'error' ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            onChange={(event) => {
              // One reading per keystroke or paste, and the field shows what it
              // says: an invite link becomes the code inside it, anything else
              // is normalised then capped. `readRoomCodeInput` holds both rules
              // and why they are in that order.
              const next = readRoomCodeInput(event.target.value)
              setReading(next)
              setCode(next.code)
              setTooShort(false)
            }}
            className="h-11 w-full rounded-md border bg-background px-4 text-center font-mono text-lg tracking-[0.3em] uppercase outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive sm:w-48 sm:text-left"
          />

          <Button type="submit" data-testid={testIds.joinSubmit} disabled={pending}>
            {pending ? 'Joining…' : 'Join'}
          </Button>
        </div>

        {/*
          `role="alert"` rather than a live region on a permanently-mounted
          node: the message only ever appears in response to a press or a
          paste, so an announcement on mount is what we want. Icon plus text,
          never colour alone — which is also what keeps the two tones apart
          without relying on destructive-red versus muted-grey: a different
          icon and a different sentence.

          A note takes `role="status"` instead. It is polite rather than
          assertive because the player has not been stopped from doing
          anything — the code is in the field and the button works.
        */}
        {message ? (
          <p
            id={messageId}
            role={message.tone === 'error' ? 'alert' : 'status'}
            data-tone={message.tone}
            className={
              message.tone === 'error'
                ? 'flex items-center gap-1.5 text-sm text-destructive [&_svg]:size-4'
                : 'flex items-center gap-1.5 text-sm text-muted-foreground [&_svg]:size-4'
            }
          >
            {message.tone === 'error' ? (
              <AlertCircle aria-hidden="true" />
            ) : (
              <Link2 aria-hidden="true" />
            )}
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  )
}

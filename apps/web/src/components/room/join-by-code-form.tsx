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
 * The submit button is **never disabled for validation**. A disabled control
 * with no explanation is the worst of both worlds on a phone: nothing happens
 * on tap and no assistive technology announces why. Pressing it with a short
 * code produces a real error message instead, wired to the input through
 * `aria-describedby`. It *is* disabled while a join is in flight, where the
 * label itself ("Joining…") supplies the explanation.
 */
export function JoinByCodeForm({ onJoin, error, pending = false, className }: JoinByCodeFormProps) {
  const inputId = useId()
  const messageId = `${inputId}-message`

  const [code, setCode] = useState('')
  // Only set once the player has actually pressed join, so the field does not
  // shout at someone who is still typing their second character.
  const [tooShort, setTooShort] = useState(false)

  const message = error ?? (tooShort ? `A room code is ${ROOM_CODE_LENGTH} characters.` : undefined)

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
            // A hard cap rather than a validator: a 7th character is never
            // part of a code, and silently dropping it beats a late error.
            maxLength={ROOM_CODE_LENGTH}
            placeholder="ABC234"
            value={code}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            onChange={(event) => {
              setCode(normalizeRoomCode(event.target.value))
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
          node: the message only ever appears in response to a press, so an
          announcement on mount is what we want. Icon plus text, never colour
          alone.
        */}
        {message ? (
          <p
            id={messageId}
            role="alert"
            className="flex items-center gap-1.5 text-sm text-destructive"
          >
            <AlertCircle aria-hidden="true" />
            {message}
          </p>
        ) : null}
      </div>
    </form>
  )
}

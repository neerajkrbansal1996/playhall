'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { testIds } from '@/lib/testids'

export interface RoomInviteProps {
  /** Canonical 6-character room code. */
  readonly code: string
  /** Absolute invite URL, e.g. `https://…/r/ABC234`. */
  readonly url: string
  readonly className?: string
}

type CopyState = 'idle' | 'copied' | 'failed'

/** How long the "Copied" confirmation stays up. */
const COPIED_RESET_MS = 2000

/**
 * The invite block: the code big enough to read across a table, the link in
 * full, and one copy control.
 *
 * Both the code and the link are rendered as **text** and both are selectable,
 * because copy is not the only way people share. Someone reads the code aloud;
 * someone else screenshots it. The link is never truncated with an ellipsis in
 * the DOM — CSS may clip it, but `room-link`'s text content is the whole URL,
 * so a spec asserting the invite target gets the target and not `https://…`.
 *
 * Copy has a failure state. `navigator.clipboard.writeText` rejects on an
 * insecure origin and in a Safari gesture that the browser decides was not a
 * user gesture, and a copy button that silently does nothing is a dead end
 * mid-share. On failure the text stays selected-able and the button says so.
 *
 * The native share sheet (Web Share API) is deliberately **not** here — it
 * belongs with the rest of the waiting room on
 * [PER-20](/PER/issues/PER-20). This component exists to carry the invite
 * surface's contract selectors, and growing it past that would make PER-20's
 * job a merge instead of a build.
 */
export function RoomInvite({ code, url, className }: RoomInviteProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  async function copy() {
    if (resetTimer.current) clearTimeout(resetTimer.current)
    try {
      await navigator.clipboard.writeText(url)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    resetTimer.current = setTimeout(() => setCopyState('idle'), COPIED_RESET_MS)
  }

  return (
    <div className={className}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">Room code</span>
          {/*
            `aria-label` spells the code out. A screen reader handed `ABC234`
            reads "abbasea two hundred thirty-four", which is unusable for
            reading a code to someone on a call.
          */}
          <p
            data-testid={testIds.roomCode}
            data-value={code}
            aria-label={`Room code ${code.split('').join(' ')}`}
            className="font-mono text-4xl font-semibold tracking-[0.25em] tabular-nums"
          >
            {code}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">Invite link</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code
              data-testid={testIds.roomLink}
              data-value={url}
              className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 text-sm"
            >
              {url}
            </code>

            <Button
              type="button"
              data-testid={testIds.copyRoomLink}
              data-copy-state={copyState}
              onClick={copy}
              // The accessible name changes with state rather than relying on
              // the tick icon, which conveys nothing to a screen reader and
              // nothing in a high-contrast mode that drops colour.
              aria-label={copyState === 'copied' ? 'Invite link copied' : 'Copy invite link'}
            >
              {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copyState === 'copied' ? 'Copied' : 'Copy link'}
            </Button>
          </div>

          {copyState === 'failed' ? (
            <p role="alert" className="text-sm text-destructive">
              Could not copy automatically — select the link above to copy it.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

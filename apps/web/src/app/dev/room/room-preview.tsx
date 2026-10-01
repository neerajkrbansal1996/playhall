'use client'

import { useState } from 'react'

import { JoinByCodeForm, RoomInvite, SeatList, type SeatView } from '@/components/room'
import { Button } from '@/components/ui/button'

const CODE = 'ABC234'

const SEATS: readonly SeatView[] = [
  { id: 'w', label: 'White', occupantName: 'Priya', connected: true },
  { id: 'b', label: 'Black', occupantName: 'Sam', connected: false },
]

/**
 * Harness for the room surfaces, so the contract's selectors can be seen and
 * measured in a real build before the real routes exist.
 *
 * The toggles are here because the states a spec cares about are the awkward
 * ones: a seat mid-reconnect, a room with nobody watching, a join that the
 * server rejected. Rendering only the happy path would let a state ship with
 * no styling and no one would notice until the E2E suite sat on it.
 */
export function RoomPreview() {
  const [disconnected, setDisconnected] = useState(true)
  const [spectators, setSpectators] = useState(2)
  const [joinError, setJoinError] = useState<string | undefined>(undefined)
  const [joined, setJoined] = useState<string | null>(null)

  const seats = SEATS.map((seat) =>
    seat.id === 'b' ? { ...seat, connected: !disconnected } : seat,
  )

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Room surfaces preview</h1>
        <p className="text-sm text-muted-foreground">
          Invite, seats, presence and join-by-code, driven by props only.
        </p>
      </header>

      <RoomInvite code={CODE} url={`https://example.test/r/${CODE}`} />

      <hr className="border-border" />

      <SeatList seats={seats} spectatorCount={spectators} />

      <hr className="border-border" />

      <div className="flex flex-col gap-2">
        <JoinByCodeForm
          onJoin={(code) => {
            setJoined(code)
            setJoinError(undefined)
          }}
          error={joinError}
        />
        {joined ? (
          <p className="text-sm text-muted-foreground">
            Would join <code>{joined}</code>
          </p>
        ) : null}
      </div>

      <hr className="border-border" />

      {/*
        Harness-only hooks, literal strings rather than entries in
        `@/lib/testids`: that registry is the *platform* contract, and a toggle
        that exists only in a preview route must not look like a surface the
        real `/r/[code]` is expected to expose. Same convention as
        `toggle-server-error` in the create-lobby preview.

        They exist because `e2e/lib/viewports.ts` requires every route state to
        be reached by a CSS selector that is not user-visible copy — a click
        keyed on "Drop Black" silently stops matching the day the label is
        reworded, and the suite then measures the default state N times while
        staying green.
      */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="toggle-black-presence"
          onClick={() => setDisconnected((v) => !v)}
        >
          {disconnected ? 'Reconnect Black' : 'Drop Black'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="toggle-spectators"
          onClick={() => setSpectators((n) => (n === 0 ? 2 : 0))}
        >
          {spectators === 0 ? 'Add spectators' : 'Clear spectators'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="toggle-join-error"
          onClick={() => setJoinError((e) => (e ? undefined : 'That room has expired.'))}
        >
          {joinError ? 'Clear join error' : 'Show join error'}
        </Button>
      </div>
    </main>
  )
}

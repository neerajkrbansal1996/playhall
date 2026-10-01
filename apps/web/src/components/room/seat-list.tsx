import { Circle, Eye, UserRound, WifiOff } from 'lucide-react'

import { seatTestAttributes, testIds } from '@/lib/testids'

export interface SeatView {
  /**
   * The seat id the platform assigned, straight from the game's player
   * descriptor — `w`/`b` for chess, `p1`…`p12` for a twelve-player room. Never
   * a colour union: `apps/web` does not know what a colour is.
   */
  readonly id: string
  /** Human label for the seat itself, e.g. "White". Supplied by the platform. */
  readonly label: string
  /** Occupant display name, or null for a free seat. */
  readonly occupantName: string | null
  /** Whether the occupant currently has a live connection. */
  readonly connected: boolean
}

export interface SeatListProps {
  readonly seats: readonly SeatView[]
  readonly spectatorCount: number
  readonly className?: string
}

/**
 * Seats and presence for the waiting room and the in-game shell.
 *
 * Presence is carried three ways at once — the `data-connected` attribute for
 * specs, an icon shape, and a word — because "never colour alone" is not
 * satisfied by a green dot next to a red dot. A player looking at a greyscale
 * screenshot or a protanopic display has to be able to tell a reconnecting
 * opponent from a present one, and "Reconnecting…" does that where `#ef4444`
 * does not.
 *
 * An **empty seat reports `data-connected="false"`**. The alternative — leaving
 * the attribute off, or calling an empty seat connected because nobody has
 * dropped — would make `[data-testid="seat-b"][data-connected="false"]` mean
 * two different things depending on whether anyone had sat down, and the
 * disconnect scenarios assert exactly that selector. `data-occupied`
 * distinguishes the two cases for a spec that needs to, and it comes out of
 * `seatTestAttributes` with the other two rather than being written here — a
 * surface cannot spread the bundle and omit the attribute that makes presence
 * readable.
 */
export function SeatList({ seats, spectatorCount, className }: SeatListProps) {
  return (
    <div className={className}>
      {/*
        A list, not a pile of divs: a screen reader announces "3 items" and the
        seat count is the single most useful thing to know about a waiting room
        before you read any seat.
      */}
      <ul className="flex flex-col gap-2" aria-label="Seats">
        {seats.map((seat) => (
          <li
            key={seat.id}
            {...seatTestAttributes(seat.id, {
              connected: seat.connected,
              occupied: Boolean(seat.occupantName),
            })}
            className="flex items-center gap-3 rounded-md border bg-card px-3 py-2"
          >
            {/*
              lucide ships 24px icons and nothing here is inside a Button, so
              every icon needs an explicit size or it dwarfs the label it sits
              next to.
            */}
            <span className="text-muted-foreground [&_svg]:size-5" aria-hidden="true">
              {seat.occupantName ? <UserRound /> : <Circle />}
            </span>

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">
                {seat.occupantName ?? 'Open seat'}
              </span>
              <span className="text-xs text-muted-foreground">{seat.label}</span>
            </span>

            <SeatPresence seat={seat} />
          </li>
        ))}
      </ul>

      <p
        data-testid={testIds.spectatorCount}
        // The number as an attribute as well as text: a spec should not have to
        // parse "2 watching" and re-derive the count from a sentence we are
        // free to reword.
        data-count={String(spectatorCount)}
        className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground [&_svg]:size-4"
      >
        <Eye aria-hidden="true" />
        {spectatorCount === 1 ? '1 spectator' : `${spectatorCount} spectators`}
      </p>
    </div>
  )
}

/** Presence badge: shape, word and attribute, so no single channel carries it. */
function SeatPresence({ seat }: { readonly seat: SeatView }) {
  if (!seat.occupantName) {
    return <span className="text-xs text-muted-foreground">Waiting</span>
  }

  if (!seat.connected) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 [&_svg]:size-4">
        <WifiOff aria-hidden="true" />
        Reconnecting…
      </span>
    )
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-2.5">
      <Circle aria-hidden="true" className="fill-current" />
      Ready
    </span>
  )
}

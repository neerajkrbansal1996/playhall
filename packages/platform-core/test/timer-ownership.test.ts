/**
 * A timer's `seatId` is ownership, and a re-arm must carry the game's intent.
 *
 *   - `set` threads `options.seatId` on the re-arm branch as well as the create
 *     branch, so `setTimer(MOVE_TIMER, 30_000, nextSeat)` — the pattern the SDK
 *     documents — actually moves the timer to the next mover. Keeping the first
 *     mover's seat forever means every seat-scoped decision about that timer
 *     points at the wrong player: the mover's own deadline counts down through
 *     their disconnect, and the non-mover dropping freezes it.
 *   - `undefined` means "leave ownership alone" on the direct `set` API, so a
 *     `set` that only extends a deadline cannot disown the timer.
 *   - The `version: 1` read path refuses a corrupt multi-runner snapshot
 *     instead of falling through a `??` chain into its second inference rule.
 *
 * Origin: CTO review pass 4 of PR #17, [PER-108](/PER/issues/PER-108).
 */
import { type TimerSpec, asMatchId, asSeatId, asTimerId, setTimer } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import { fixedClock } from '../src/runtime.js'
import { createManualScheduler } from '../src/timers/scheduler.js'
import { TimerService, restoreTimerService } from '../src/timers/service.js'

const MATCH = asMatchId('m1')
const WHITE = asSeatId('white')
const BLACK = asSeatId('black')
const TURN = asTimerId('turn')

const SPECS: readonly TimerSpec[] = [
  { id: 'turn', kind: 'turn', description: 'move deadline', pausesOnDisconnect: true },
  { id: 'clock:white', kind: 'chess-clock', description: 'white', pausesOnDisconnect: true },
  { id: 'clock:black', kind: 'chess-clock', description: 'black', pausesOnDisconnect: true },
  { id: 'clock:green', kind: 'chess-clock', description: 'green', pausesOnDisconnect: true },
]

function newService(): { service: TimerService; advance: (ms: number) => void } {
  const clock = fixedClock(1_000_000)
  const service = new TimerService({
    matchId: MATCH,
    clock,
    scheduler: createManualScheduler(),
    specs: SPECS,
  })
  return { service, advance: (ms) => clock.advance(ms) }
}

/**
 * The pattern `packages/game-sdk/README.md:251` documents and the reference
 * game implements: one `MOVE_TIMER` id, re-armed for whoever is next to move.
 */
describe('a re-armed turn timer must follow its new owner', () => {
  it('re-owns the record when `set` names a different seat', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    service.set(TURN, { seatId: BLACK, delayMs: 30_000, issuedAtMs: 1_005_000 })

    expect(service.get(TURN)?.seatId).toBe(BLACK)
  })

  it('leaves ownership alone when `set` does not mention a seat', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    // `undefined` means "unchanged", so a re-arm that says nothing about the
    // seat must not null out the owner it already had.
    service.set(TURN, { delayMs: 30_000, issuedAtMs: 1_005_000 })

    expect(service.get(TURN)?.seatId).toBe(WHITE)
  })

  it('clears ownership when `set` names it explicitly', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    service.set(TURN, { seatId: null, delayMs: 30_000, issuedAtMs: 1_005_000 })

    expect(service.get(TURN)?.seatId).toBeNull()
  })

  it('follows the seat through `apply`, the only path a game actually uses', () => {
    const { service } = newService()
    service.apply([setTimer(TURN, 30_000, WHITE)], 1_000_000)
    service.apply([setTimer(TURN, 30_000, BLACK)], 1_005_000)

    expect(service.get(TURN)?.seatId).toBe(BLACK)
    service.pauseForSeat(BLACK, 1_006_000)
    expect(service.isRunning(TURN)).toBe(false)
  })

  it('disowns through `apply` when the game names no seat', () => {
    const { service } = newService()
    service.apply([setTimer(TURN, 30_000, WHITE)], 1_000_000)
    // `setTimer`'s seat defaults to `null` and a `TimerCommand` has no way to
    // say "unchanged", so through `apply` the command is always a statement of
    // ownership — and it matches what the create branch already does with the
    // same command. A game that wants the seat kept names it.
    service.apply([setTimer(TURN, 30_000)], 1_005_000)

    expect(service.get(TURN)?.seatId).toBeNull()
    service.pauseForSeat(WHITE, 1_006_000)
    expect(service.isRunning(TURN)).toBe(true)
  })
})

/**
 * The four-way matrix. `pauseForSeat` holds the seat, and the seat scope reaches
 * a record through `record.seatId` — so stale ownership silently inverts which
 * disconnect freezes the move deadline. A disconnect mid-move is the single most
 * common real event on mobile data, which is our stated arrival path.
 */
describe('a disconnect must freeze the move deadline of the seat that is on move', () => {
  it('stops the deadline when the seat that owns it drops (before a re-arm)', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })

    service.pauseForSeat(WHITE, 1_001_000)
    expect(service.isRunning(TURN)).toBe(false)
  })

  it('leaves the deadline running when a seat that does not own it drops (before a re-arm)', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })

    service.pauseForSeat(BLACK, 1_001_000)
    expect(service.isRunning(TURN)).toBe(true)
  })

  it('stops the deadline when the new owner drops after a re-arm', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    service.set(TURN, { seatId: BLACK, delayMs: 30_000, issuedAtMs: 1_005_000 })

    // Black is on move and Black's socket closes. Without the fix Black's own
    // deadline counts down to a timeout they never saw.
    service.pauseForSeat(BLACK, 1_006_000)
    expect(service.isRunning(TURN)).toBe(false)
  })

  it('leaves the deadline running when the previous owner drops after a re-arm', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    service.set(TURN, { seatId: BLACK, delayMs: 30_000, issuedAtMs: 1_005_000 })

    // White is not on move. White dropping must not freeze Black's deadline.
    service.pauseForSeat(WHITE, 1_006_000)
    expect(service.isRunning(TURN)).toBe(true)
  })

  it('resumes for the new owner and not for the old one', () => {
    const { service } = newService()
    service.set(TURN, { seatId: WHITE, delayMs: 30_000, issuedAtMs: 1_000_000 })
    service.set(TURN, { seatId: BLACK, delayMs: 30_000, issuedAtMs: 1_005_000 })
    service.pauseForSeat(BLACK, 1_006_000)

    // The previous owner reconnecting must not restart a deadline it no longer
    // owns — the mirror of the freeze case, through `resumeForSeat`.
    service.resumeForSeat(WHITE, 1_007_000)
    expect(service.isRunning(TURN)).toBe(false)

    service.resumeForSeat(BLACK, 1_008_000)
    expect(service.isRunning(TURN)).toBe(true)
  })

  it('charges the new owner nothing for the time it was away', () => {
    const { service, advance } = newService()
    service.apply([setTimer(TURN, 30_000, WHITE)], 1_000_000)
    service.apply([setTimer(TURN, 30_000, BLACK)], 1_005_000)

    service.pauseForSeat(BLACK, 1_006_000)
    advance(11_000) // now 1_011_000, so 5s of absence
    service.resumeForSeat(BLACK, 1_011_000)

    expect(service.isRunning(TURN)).toBe(true)
    // 1s of the 30s budget was spent before the drop; the 5s away cost nothing.
    expect(service.remainingMs(TURN)).toBe(29_000)
  })
})

const CLOCK_CONFIG = {
  initialMs: 300_000,
  incrementMs: 0,
  delayMs: 0,
  delayMode: 'none' as const,
  maxMs: null,
}

function v1Record(fields: {
  timerId: string
  seatId: string
  startedAtMs?: number | null
  holds?: readonly string[]
}) {
  return {
    timerId: fields.timerId,
    seatId: fields.seatId,
    kind: 'chess-clock' as const,
    remainingMs: 290_000,
    startedAtMs: fields.startedAtMs ?? null,
    delayRemainingMs: 0,
    turnElapsedMs: 0,
    clock: CLOCK_CONFIG,
    expired: false,
    holds: fields.holds ?? [],
    version: 4,
  }
}

/**
 * `readV1Scopes`'s docstring promises rule 2 applies when "**nothing** is
 * running", and that two running clocks means the snapshot is corrupt and it
 * stops rather than picking a victim. A `??` chain cannot keep that promise.
 *
 * Unreachable at two seats — two running clocks leave no third record for the
 * `['room']`-alone rule to find. Reachable the moment a game declares chess
 * clocks for three or more seats, which nothing in `TimerService` forbids, and
 * the docstring is the contract a future reader will trust.
 */
describe('the version:1 read must refuse a corrupt snapshot, not fall through', () => {
  it('yields no mover when two clocks ran and a third was held by `room` alone', () => {
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_008_000,
        timers: [
          v1Record({ timerId: 'clock:white', seatId: 'white', startedAtMs: 1_000_000 }),
          v1Record({ timerId: 'clock:black', seatId: 'black', startedAtMs: 1_000_000 }),
          v1Record({ timerId: 'clock:green', seatId: 'green', holds: ['room'] }),
        ],
      },
      {
        clock: fixedClock(2_000_000),
        scheduler: createManualScheduler(),
        specs: SPECS,
      },
    )

    // Rule 1 refused: two clocks were running. Green's clock was demonstrably
    // *stopped* while those two ran, so naming Green would charge a player the
    // snapshot says was not moving.
    expect(restored.onMoveSeatId).toBeNull()
  })

  it('still applies rule 2 when nothing at all was running', () => {
    const restored = restoreTimerService(
      {
        version: 1,
        matchId: 'm1',
        savedAtMs: 1_008_000,
        timers: [
          v1Record({ timerId: 'clock:white', seatId: 'white', holds: ['seat-disconnect'] }),
          v1Record({ timerId: 'clock:black', seatId: 'black', holds: ['room'] }),
        ],
      },
      {
        clock: fixedClock(2_000_000),
        scheduler: createManualScheduler(),
        specs: SPECS,
      },
    )

    // The guard must not cost the recoverable case: nothing ran, and exactly
    // one clock carries `room` alone, so that clock was the one the freeze hit.
    expect(restored.onMoveSeatId).toBe(BLACK)
  })
})

/**
 * Standoff as a conformance subject.
 *
 * This is the whole of ADR-0010's new surface as a game author writes it: one
 * scenario, `trigger: 'timer'`, and the id of a timer the game already declares
 * in its own manifest. There is no `seatId` to invent and no clock offset to
 * keep in step with the game's `delayMs` — the driver arms the timer from the
 * game's own `TimerCommand` and advances `ctx.now` to the deadline the game
 * itself chose.
 *
 * Contrast the action arm (`AbortScenario` with `abortAction`), which needs the
 * author to supply both the acting seat and, for a deadline-gated abort, an
 * `advanceMs` that has to be kept larger than the game's own deadline by hand.
 */

import type {
  StandoffAction,
  StandoffEvent,
  StandoffSettings,
  StandoffState,
  StandoffView,
} from './standoff.js'
import { FIRST_MOVE_TIMER, manifest, server } from './standoff.js'
import type { TurnBasedConformanceSubject } from '../subject.js'

export const standoffSubject: TurnBasedConformanceSubject<
  StandoffState,
  StandoffAction,
  StandoffView,
  StandoffSettings,
  StandoffEvent
> = {
  manifest,
  server,
  abortScenarios: [
    {
      label: 'nobody fires before the opening deadline',
      trigger: 'timer',
      timerId: FIRST_MOVE_TIMER,
    },
  ],
  probeActions: [{ type: 'fire' }],
  malformedActions: [{ type: 'duck' }, { type: 'fire', extra: 1 }, 'fire'],
}

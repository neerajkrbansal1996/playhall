/**
 * The chess `TurnBasedConformanceSubject`.
 *
 * `conformance.test.ts` is the three-line vitest binding; the subject lives here
 * so the same value can be handed to `runTurnBasedConformance` directly when you
 * want the report rather than a suite (`formatReport` for a PR comment, a REPL
 * while tuning a scenario). Importing a `*.test.ts` file to get at its exports
 * would re-declare its `describe` block.
 *
 * Everything the suite cannot derive from `{ manifest, server }` is declared
 * here, and every number in it was measured rather than guessed. The numbers are
 * in the comments next to the constant they justify.
 */

import type { Rng, SeatId, SeatRoster } from '@playhall/game-sdk'
import type {
  AbortScenario,
  ActionCandidate,
  SettingsVariant,
  TurnBasedConformanceOptions,
  TurnBasedConformanceSubject,
} from '@playhall/game-testkit'

import {
  canAbort,
  chessSettingsSchema,
  FIRST_MOVE_TIMER,
  manifest,
  server,
  type ChessClientAction,
  type ChessEvent,
  type ChessMatchState,
  type ChessSettings,
  type ChessView,
} from '../src/index.js'

/* -------------------------------------------------------------------------- */
/* Settings variants                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Four variants instead of the default "defaults plus all six presets".
 *
 * The axes are picked for what they change, not for coverage theatre:
 *
 *   - **`color`** is the only settings field the reducer reads
 *     (`setup` → `assignColors`), and `'random'` is the one path that consumes
 *     `ctx.rng`. All three preferences appear below, so `determinism` sees both
 *     the seeded and the fixed assignment.
 *   - **`timeControl`** is inert in the reducer by design — the platform clock
 *     owns countdown, increment and the low-time warning — but it reaches
 *     `describeTimeControl` in the `match_started` payload, and the variants
 *     exist to keep it that way: a reducer path that secretly depended on the
 *     time control would show up as a `determinism` or `legal-actions-agree`
 *     difference between "No clock" and 1+0.
 *   - **`takebacks` / `autoQueen`** are both client-side preferences today. They
 *     are flipped on the custom variant so that a future server-side takeback
 *     never lands with the gate only ever having seen the default.
 *
 * Dropping from seven variants to four is a deliberate budget trade: the suite
 * replays the full SAN list on every action and every view build (PER-92), so
 * cost is quadratic in playout length, and the length is what buys real chess
 * positions. See `CHESS_CONFORMANCE_OPTIONS`.
 */
export const CHESS_SETTINGS_VARIANTS: readonly SettingsVariant<ChessSettings>[] = [
  // 5+0, colour random. What the lobby opens on.
  { label: 'defaults', settings: manifest.defaultSettings },
  {
    label: 'no clock · white',
    settings: chessSettingsSchema.parse({ timeControl: 'unlimited', color: 'white' }),
  },
  {
    label: 'bullet 1+0 · black',
    settings: chessSettingsSchema.parse({ timeControl: '1+0', color: 'black' }),
  },
  {
    // Both custom bounds at their extremes: the shortest initial time the form
    // offers (0.5 min) and the largest increment (60 s).
    label: 'custom 0.5+60 · random',
    settings: chessSettingsSchema.parse({
      timeControl: 'custom',
      customInitialMinutes: 0.5,
      customIncrementSeconds: 60,
      color: 'random',
      takebacks: true,
      autoQueen: true,
    }),
  },
]

/* -------------------------------------------------------------------------- */
/* Playout policy                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Per-ply chance of ending the game by conceding (`resign`, `accept_draw`).
 *
 * Measured, 168 playouts, default uniform picker: **84.5% resignation, 14.3%
 * abort, 1.2% checkmate**, mean 20 plies. The default picks uniformly across the
 * ~22 actions the side to move has, so roughly one ply in eleven is a concession
 * and most "games" are over before a piece leaves the second rank — the suite was
 * certifying the opening position eleven times over.
 *
 * Sweep at 16 playouts each (mean plies · ms per playout):
 *
 * | concede | mean plies | ms/playout | endings                        |
 * | ------- | ---------- | ---------- | ------------------------------ |
 * | 1/30    | 29.8       | 164        | resignation 15, abort 1        |
 * | 1/40    | 64.9       | 810        | resignation 22, checkmate 1, abort 1 |
 * | 1/60    | 71.7       | 1019       | resignation 15, checkmate 1    |
 * | 1/120   | 184.3      | 7153       | resignation 19, insufficient_material 4, stalemate 1 |
 *
 * 1/60 is the knee: mean 72 plies and a 184-ply longest game is a real
 * middlegame — castling, promotion and en-passant positions all occur — while
 * 1/120 costs 7× for the same contract coverage.
 *
 * Resignation still ends most playouts, and that is not a defect to tune out:
 * random legal moves essentially never reach checkmate, so a bounded random
 * playout has to end by concession, by a claimable draw or by insufficient
 * material. Chess's fourteen endings are covered by FEN in
 * `end-conditions.test.ts`, `timeout.test.ts` and `player-endings.test.ts`; what
 * the conformance gate needs from a playout is *depth of real play*, and that is
 * what this constant buys.
 */
const CONCEDE_ODDS = 1 / 60

/**
 * Per-ply chance of draw-offer traffic (`offer_draw`, `decline_draw`) — neither
 * of which ends the match.
 *
 * Chess's only piece of per-seat private state is a pending draw offer, which
 * `getViewFor` redacts from spectators. 1/12 puts an offer on the board for a
 * few plies in most playouts, so `serialization-round-trip`,
 * `reconnect-snapshot-matches-live` and the view builders see `drawOffer` and
 * `lastDrawOfferPly` populated rather than always null. Measured at 1/12 over 16
 * playouts: 89 offers and 7 declines against 1,147 moves.
 */
const DRAW_TALK_ODDS = 1 / 12

/**
 * Chance of taking a claimable draw the moment it becomes available.
 *
 * Threefold repetition and the fifty-move rule are *claimable*, never automatic
 * (FIDE 9.2/9.3), so a driver that never claims leaves `claim_draw` out of the
 * played corpus entirely — and a driver that always claims means a repetition can
 * never run on to the automatic fivefold ending. A coin flip gets both.
 */
const CLAIM_ODDS = 0.5

type Choice = { readonly seatId: SeatId; readonly action: ChessClientAction }

/**
 * Steers playouts towards real chess.
 *
 * Two rules, in order:
 *
 * 1. **Nothing terminal while the abort window is open.** Until both sides have
 *    moved, only moves are picked. A resignation or an abort on ply 0 is not a
 *    playout, it is a discarded match — and the abort path is covered
 *    deliberately by `CHESS_ABORT_SCENARIOS` rather than incidentally, which is
 *    also what makes their `afterSteps` reachable for *any* seed instead of
 *    ~98% of them.
 * 2. **Otherwise: claim, concede, talk, move** — at the measured odds above.
 *
 * Pure and deterministic: every decision comes from `rng`, which the driver
 * derives from the match seed. No `Math.random()`, no clock.
 */
export function chooseChessAction(
  state: ChessMatchState,
  candidates: readonly ActionCandidate<ChessClientAction>[],
  rng: Rng,
): Choice | null {
  const moves: Choice[] = []
  const claims: Choice[] = []
  const talk: Choice[] = []
  const concessions: Choice[] = []

  for (const candidate of candidates) {
    for (const action of candidate.actions) {
      const choice: Choice = { seatId: candidate.seatId, action }
      switch (action.type) {
        case 'move':
          moves.push(choice)
          break
        case 'claim_draw':
          claims.push(choice)
          break
        case 'offer_draw':
        case 'decline_draw':
          talk.push(choice)
          break
        default:
          // resign | accept_draw | abort — everything that ends the match.
          concessions.push(choice)
      }
    }
  }

  // Rule 1. `canAbort` is `moves.length < 2`, i.e. exactly the window in which a
  // terminal action would throw the playout away.
  if (canAbort(state)) {
    if (moves.length > 0) return rng.pick(moves)
    // No legal move in the opening window means a hand-placed initial FEN, which
    // the conformance driver never produces; fall through rather than stall.
  }

  if (claims.length > 0 && rng.bool(CLAIM_ODDS)) return rng.pick(claims)
  if (moves.length === 0) {
    const rest = [...talk, ...concessions]
    return rest.length === 0 ? null : rng.pick(rest)
  }
  if (concessions.length > 0 && rng.bool(CONCEDE_ODDS)) return rng.pick(concessions)
  if (talk.length > 0 && rng.bool(DRAW_TALK_ODDS)) return rng.pick(talk)
  return rng.pick(moves)
}

/* -------------------------------------------------------------------------- */
/* Abort scenarios                                                            */
/* -------------------------------------------------------------------------- */

function abortBy(index: number) {
  return (state: ChessMatchState, roster: SeatRoster): Choice | null => {
    const seat = roster[index]
    // `null` is the contract's "not reachable from this state", and the suite
    // reports it as a failure. Asking `canAbort` rather than letting
    // `validateAction` reject the action keeps the failure message pointed at the
    // window instead of at an error code.
    if (seat === undefined || !canAbort(state)) return null
    return { seatId: seat.seatId, action: { type: 'abort' } }
  }
}

/**
 * Both ends of chess's abort window, plus the deadline that closes a lobby
 * nobody ever played in. Between them they cover both of chess's `abort` causes.
 *
 * The first two use the action arm. The window is open until both players have
 * moved (`state.ts` → `canAbort`), so `afterSteps` is capped at 1 by the rules
 * and not by taste: at 2 the window has closed, the abort is unreachable, and
 * the suite fails an unreachable declared abort rather than skipping it. Both
 * land on `cause: 'agreed'`.
 *
 * The third uses the timer arm (ADR-0010) and reaches the other cause,
 * `'first_move_timeout'`: nobody acts, the 30 s first-move deadline comes due,
 * and the platform calls `onTimer`. It needs no `advanceMs` and has none — the
 * driver replays the `setTimer(FIRST_MOVE_TIMER, FIRST_MOVE_TIMEOUT_MS)` that
 * chess returns from `createInitialState` and fires it at that command's own
 * deadline, which is `startedAt + 30_000`, exactly the boundary
 * `firstMoveDeadline` checks. Because the driver replays chess's commands rather
 * than synthesising the call, this scenario doubles as the assertion that chess
 * arms the window itself at setup instead of leaning on the lobby to do it.
 *
 * `maxFires: 1` is left at its default because `'first-move'` is the only timer
 * chess ever `set`s: `CHESS_CLOCK_TIMER` is declared so `onTimer` can react to
 * it, but the platform timer service owns arming it, so nothing else can come
 * due first.
 *
 * `player-endings.test.ts` keeps its unit test of the same ending, and neither
 * replaces the other. The unit test pins the rule — the reducer refuses the
 * timeout a millisecond early. This scenario proves the ending is reachable the
 * way production reaches it: through a timer, with no actor.
 */
export const CHESS_ABORT_SCENARIOS: readonly AbortScenario<ChessMatchState, ChessClientAction>[] = [
  {
    label: 'first seat aborts from the opening position',
    afterSteps: 0,
    abortAction: abortBy(0),
  },
  {
    // The far end of the window: one move played, the second seat aborts. Proves
    // the window is open to *either* side and that it survives a move.
    label: 'second seat aborts after one move',
    afterSteps: 1,
    abortAction: abortBy(1),
  },
  {
    // No `afterSteps`: the position production reaches this ending from is a
    // lobby where nobody moved at all.
    label: 'nobody plays a first move and the 30 s deadline aborts the match',
    trigger: 'timer',
    timerId: FIRST_MOVE_TIMER,
  },
]

/* -------------------------------------------------------------------------- */
/* Probes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Actions the suite tries everywhere, so the reverse half of
 * `legal-actions-agree` can catch an action category `getLegalActions` omits
 * *everywhere* — the classic being "forgot resigning is always available", which
 * is invisible to a check that can only probe what `getLegalActions` offered.
 *
 * One entry per arm of `chessActionSchema`, plus a promotion push and an opening
 * move, so every branch of `getLegalActions` is probed from a state where it
 * should be absent.
 */
const CHESS_PROBE_ACTIONS: readonly ChessClientAction[] = [
  { type: 'resign' },
  { type: 'abort' },
  { type: 'offer_draw' },
  { type: 'accept_draw' },
  { type: 'decline_draw' },
  { type: 'claim_draw', claim: 'threefold_repetition' },
  { type: 'claim_draw', claim: 'fifty_move_rule' },
  { type: 'move', move: { from: 'e2', to: 'e4' } },
  { type: 'move', move: { from: 'g1', to: 'f3' } },
  { type: 'move', move: { from: 'a7', to: 'a8', promotion: 'q' } },
]

/**
 * Chess-shaped junk `chessActionSchema` must reject, on top of the suite's
 * standard battery.
 *
 * The first three are the ones that matter most: `flag`, `first_move_timeout`
 * and `claim_abandonment` are arms of the *reducer's* `ChessAction` union that a
 * client must never be able to send. They are raised by the server from the
 * platform clock. `claim_abandonment` in particular is accepted unconditionally
 * by the reducer, so a schema that let it through would hand a modified client a
 * free win against a present opponent. This is the assertion that keeps them out.
 */
const CHESS_MALFORMED_ACTIONS: readonly unknown[] = [
  { type: 'flag', color: 'w' },
  { type: 'first_move_timeout' },
  { type: 'claim_abandonment', outcome: 'win' },
  { type: 'claim_abandonment', outcome: 'draw' },
  // A square off the board, and a rank that does not exist.
  { type: 'move', move: { from: 'e2', to: 'e9' } },
  { type: 'move', move: { from: 'j2', to: 'j4' } },
  // Promoting to a king, and to a pawn.
  { type: 'move', move: { from: 'e7', to: 'e8', promotion: 'k' } },
  { type: 'move', move: { from: 'e7', to: 'e8', promotion: 'p' } },
  // SAN on the wire. Keyboard entry is resolved to coordinates client-side.
  { type: 'move', move: 'e4' },
  { type: 'move' },
  // `.strict()`: an extra key is a client the server does not recognise.
  { type: 'move', move: { from: 'e2', to: 'e4', extra: 1 } },
  // Resigning on somebody else's behalf. The actor is the connection, never a
  // field in the payload.
  { type: 'resign', seatId: 'seat-2' },
  { type: 'claim_draw' },
  { type: 'claim_draw', claim: 'insufficient_material' },
]

/* -------------------------------------------------------------------------- */
/* The subject                                                                */
/* -------------------------------------------------------------------------- */

/**
 * No `secrets`.
 *
 * `hasHiddenInformation` is false and the board is public, so the suite's leak
 * fuzzer has nothing to search for. The one thing `getViewFor` does redact — a
 * pending draw offer, hidden from spectators — cannot be declared here usefully:
 * the only scalar identifying it is `drawOffer.by`, which is `'w'` or `'b'`, and
 * the fuzzer searches by value, so it would collide with `turn`, every move's
 * colour and the material panel and report a leak on every view. That redaction
 * is asserted directly in `view.test.ts` ("HIDES a pending draw offer from
 * spectators") instead.
 */
export const chessConformanceSubject: TurnBasedConformanceSubject<
  ChessMatchState,
  ChessClientAction,
  ChessView,
  ChessSettings,
  ChessEvent
> = {
  manifest,
  server,
  settingsVariants: CHESS_SETTINGS_VARIANTS,
  abortScenarios: CHESS_ABORT_SCENARIOS,
  chooseAction: chooseChessAction,
  probeActions: CHESS_PROBE_ACTIONS,
  malformedActions: CHESS_MALFORMED_ACTIONS,
  detail: {
    concedeOdds: CONCEDE_ODDS,
    drawTalkOdds: DRAW_TALK_ODDS,
    claimOdds: CLAIM_ODDS,
  },
}

/**
 * 8 playouts per variant instead of the default 24.
 *
 * 4 variants × 8 = 32 seeded playouts at ~1 s each. The default 24 would be 96,
 * and the suite is dominated by chess replaying its whole SAN list on every
 * action and every view build — quadratic in playout length (PER-92). Given a
 * fixed budget, depth beats breadth here: the variants differ only in settings
 * the reducer barely reads, whereas plies 40-180 are where castling, promotion
 * and en-passant positions live. Raise this once PER-92 lands.
 *
 * `nowStepMs` is deliberately left at its 1,000 ms default. It is subject-level,
 * shared by every check, and raising it to reach a first-move timeout would
 * advance every playout's clock 30 s per ply.
 */
export const CHESS_CONFORMANCE_OPTIONS: TurnBasedConformanceOptions = {
  playoutsPerVariant: 8,
}

# games/chess

The chess game module. Rules are decided here, on the server; the client only hints.

## Layout

| Path            | What it holds                                                    |
| --------------- | ---------------------------------------------------------------- |
| `src/rules/`    | Pure chess: positions, material, end conditions. No match state. |
| `src/state.ts`  | The match reducer — the one place an action can change a game.   |
| `src/result.ts` | Endings → the platform's standings shape.                        |
| `src/view.ts`   | `getViewFor`, including redaction.                               |
| `src/record.ts` | PGN export.                                                      |
| `src/settings/` | Lobby settings: schema, presets, form descriptor.                |
| `src/sdk/`      | **Temporary** shims for `packages/game-sdk` (see below).         |

## Design rules this package holds itself to

**The move list is the state, not the FEN.** `ChessMatchState` stores `initialFen` plus a
SAN move list, and every read replays it. A stored FEN cannot tell you how many times a
position has repeated, so a FEN-as-truth design gets threefold repetition wrong — and
players notice that instantly.

**Legality is decided in one place.** `applyAction` is the only way a move enters the
state, and it replays the move through chess.js before accepting it. A client that skips
its own legal-move dots gets `illegal_move` back. In particular, a promotion with no piece
named is rejected: `autoQueen` decides whether the UI shows the picker, never what the
server accepts.

**Claimable draws stay claimable.** Threefold repetition and the fifty-move rule are
_offered_, not applied. Auto-drawing on the third repetition robs a player who is
repeating to gain time on the clock. Fivefold and seventy-five-move are automatic, per
FIDE 9.6.

**Nothing ambient.** No `Date.now()`, no `Math.random()`. Time comes from `ctx.now`,
randomness from `ctx.rng` (seeded server-side, seed stored on the match), so replaying a
match log reproduces the same colours. The root ESLint config enforces this; `setup.test.ts`
also asserts it at runtime.

## Two rules worth spelling out

**Timeout against insufficient material (FIDE 6.9).** When a player's clock runs out they
lose — _unless_ the opponent cannot checkmate, in which case it is a draw. `canPossiblyMate`
decides that: a bare king, king + one knight, or king + bishops all on one square colour
cannot mate. Two knights **can** (mate is reachable even though it cannot be forced), so
that side wins on the flag.

**Abort.** Allowed until both players have moved, and the side to move gets 30 seconds for
their first move or the game aborts. An abort produces `status: 'no_result'` with **empty
standings** — the match is not recorded.

## The SDK boundary

`src/sdk/contract.ts` is the module's single point of contact with `@playhall/game-sdk`: every
SDK type chess uses — the rules types and the settings **form descriptor** (how the platform
renders a create-lobby form from a game's schema, ADR-0007) — is re-exported from there rather
than imported across a dozen files, so an SDK contract change has a one-file blast radius and a
reach outside the contract is visible in one place.

This package imports from `@playhall/game-sdk`, `chess.js`, `zod`, and itself. Nothing else —
no platform internals, no other game.

### Two places where chess had to pick a reading

- `MatchResult.reason` is the platform's seven-value vocabulary and cannot say "fivefold
  repetition". The exact chess reason goes in `detail.chessReason`; `reason` carries the
  nearest platform term (`completed` for a draw by rule, `timeout` for both timeout
  outcomes, `disconnect_forfeit` for abandonment).
- An **abort** returns `reason: 'aborted'` with an **empty** `standings` array, against the
  SDK's "one entry per seat" note, because no seat won, lost or drew it. `detail.recorded`
  is `false`. If the platform would rather see two seats with an explicit non-outcome, the
  SDK needs a `SeatOutcome` that means "did not count".

## Commands

```sh
pnpm --filter @playhall/chess test        # 238 tests
pnpm --filter @playhall/chess typecheck   # src and tests
pnpm --filter @playhall/chess test:coverage
```

## Licences

- `chess.js` — **BSD-2-Clause** (note: permissive, but not MIT as originally scoped).
- `zod` — MIT.

Both need logging in the repo-root `THIRD_PARTY_LICENSES.md`, which is outside this package.

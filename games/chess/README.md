# games/chess

The chess game module. Rules are decided here, on the server; the client only hints.

## Layout

| Path            | What it holds                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/rules/`    | Pure chess: positions, material, end conditions. No match state.                                                                                    |
| `src/state.ts`  | The match reducer — the one place an action can change a game.                                                                                      |
| `src/result.ts` | Endings → the platform's standings shape.                                                                                                           |
| `src/view.ts`   | `getViewFor`, including redaction.                                                                                                                  |
| `src/record.ts` | PGN export.                                                                                                                                         |
| `src/settings/` | Lobby settings: schema, presets, form descriptor.                                                                                                   |
| `src/sdk/`      | `contract.ts`, and only that: the module's single, permanent point of contact with `@playhall/game-sdk`. See [The SDK boundary](#the-sdk-boundary). |

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
their first move or the game aborts. An abort produces `reason: 'aborted'` with
`unrecordedStandings()` — **empty standings**, which is the encoding ADR-0006 §1 sanctions for
a match that did not count. Chess does not say whether it counted; `isRecordedResult(result)`
answers that, from `reason`.

## The SDK boundary

`src/sdk/contract.ts` is the module's single point of contact with `@playhall/game-sdk`: every
SDK type chess uses — the rules types and the settings **form descriptor** (how the platform
renders a create-lobby form from a game's schema, ADR-0007) — is re-exported from there rather
than imported across a dozen files, so an SDK contract change has a one-file blast radius and a
reach outside the contract is visible in one place.

This package imports from `@playhall/game-sdk`, `chess.js`, `zod`, and itself. Nothing else —
no platform internals, no other game.

### Two readings the SDK has now settled

Both were raised from chess on [PER-42](/PER/issues/PER-42) and decided in
`docs/adr/0006-unrecorded-match-results.md`. They are recorded here because chess is the
first customer of `MatchResult`, not because chess chose them.

- `MatchResult.reason` is the platform's seven-value vocabulary and cannot say "fivefold
  repetition". The exact chess reason goes in `detail.chessReason`; `reason` carries the
  nearest platform term (`completed` for a draw by rule, `timeout` for both timeout
  outcomes, `disconnect_forfeit` for abandonment). ADR-0006 §3/§4 confirms `detail` as the
  home for that code and keeps `ResultReason` at seven values: `reason` and `outcome` are
  independent axes, and chess proves it —
  `timeout_vs_insufficient_material` is `reason: 'timeout'` with two draws, and
  `abandonment_draw` is `reason: 'disconnect_forfeit'` with two draws.
- An **abort** returns `reason: 'aborted'` with `unrecordedStandings()` — an **empty**
  `standings` array — because no seat won, lost or drew it. ADR-0006 §1 makes that the
  declared encoding rather than an exception to "one entry per seat", checkable by
  `validateMatchResult(result, seatIds)`. §2 settles the second half: chess writes **no**
  `recorded` flag. "Did this match count" is a platform fact about a platform record,
  answered once by `isRecordedResult(result)`.

### The `detail` keys chess writes

`MatchResult.detail` is a **game-owned public field** (ADR-0006 §4): JSON-safe, persisted
verbatim with the match, replayed from the match log, and returned to clients. The platform
never reads a key of it; chess's own result panel is the intended consumer.

Because it is persisted and matches are version-pinned, **these keys are part of this
package's public surface.** Renaming one, dropping one, or changing what one means is a
breaking change to `games/chess` and needs a `migrateState` / record-version bump — the same
rule as `ChessMatchState`. Adding a key is not.

| Key           | Type           | Meaning                                                                                                                      |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `chessReason` | `EndingReason` | The exact chess ending, one of the 14 `ChessEnding` arms. The reason `MatchResult.reason` cannot express.                    |
| `description` | `string`       | One-line human phrase for the result banner and the PGN `Termination` header, e.g. `Black ran out of time`. Not stable copy. |
| `moves`       | `number`       | Plies played, `state.moves.length`. `0` on an abort.                                                                         |

No other key is written, and in particular **no `recorded` flag** — see §2 above.
`test/result-contract.test.ts` asserts this key list over every `ChessEnding` arm, so the
table above fails CI if it drifts from the code.

## Commands

```sh
pnpm --filter @playhall/chess test        # the whole suite; vitest prints the count
pnpm --filter @playhall/chess typecheck   # src and tests
pnpm --filter @playhall/chess test:coverage
```

## Licences

- `chess.js` — **BSD-2-Clause** (note: permissive, but not MIT as originally scoped).
- `zod` — MIT.

Both need logging in the repo-root `THIRD_PARTY_LICENSES.md`, which is outside this package.

# ADR-0010: The conformance driver fires the game's own timers; it does not call `onTimer` for it

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-10-01 (rev 2) — **§4a decides the equal-deadline tie-break the two
  implementations read differently.** `TimerQueue` broke an exact tie by `timerId` ascending, as
  §4's fixture requires; `TimerService.poll` broke it by the order the game's reducer emitted its
  `set` commands. §4a makes **`timerId` ascending normative** and the service is corrected. Nothing
  else in this ADR changes, no `packages/game-sdk` runtime surface changes, and §4's obligation is
  unaltered — this is the first time it was exercised, and it worked. Raised as
  [PER-255](/PER/issues/PER-255) from the §4 discharge on [PER-252](/PER/issues/PER-252).
- **Author:** CTO
- **Milestone:** M1
- **Issue:** [PER-142](/PER/issues/PER-142) (raised from [PER-136](/PER/issues/PER-136), which
  came out of [PER-50](/PER/issues/PER-50))
- **Follows:** [ADR-0006](./0006-unrecorded-match-results.md) — this is the follow-up its
  "Enforcement owed" note pointed at.

## Context

[ADR-0006](./0006-unrecorded-match-results.md) decided how a match that did not count is
encoded: a `reason` in `UNRECORDED_RESULT_REASONS` carries exactly zero standings. The
conformance check that enforces it, `result-standings-well-formed`, is the 11th of the 11
entries in `TURN_BASED_CHECKS` (`packages/game-testkit/src/report.ts`, `7d16885`).

Random playouts never reach an unrecorded ending — they only reach endings the rules arrive
at on their own — so the check has a second, declared population: `abortScenarios`. Today
that surface has exactly one way to reach the ending, and it is an **action**:

```ts
abortAction(state, roster): { seatId, action } | null
```

[PER-136](/PER/issues/PER-136) closed the _clock_ half of the resulting limit with
`AbortScenario.advanceMs` — extra milliseconds added to `ctx.now` for the abort dispatch
only, so a deadline-gated ending such as a first-move timeout becomes reachable. It did not
close the _trigger_ half, and Platform Engineer filed [PER-142](/PER/issues/PER-142) rather
than designing one inside a ticket scoped to a number. That was the right call: the shape
touches how the harness relates to the timer service, not just the harness.

### The gap, precisely

A game whose unrecorded ending fires from `onTimer` — the platform calling the game because a
deadline passed, with **no player action at all** — cannot declare it. The consequences:

- the gate never sees that ending's `MatchResult`;
- a game whose _only_ unrecorded ending is timer-driven gets the "declares no abortScenarios"
  note and a green check. That is the opts-out-by-omission shape
  ([ADR-0006](./0006-unrecorded-match-results.md), Enforcement owed) with a different cause.

### Three facts that decide this, all of which had to be measured

**1. The real timer service already exists, and it is not on `main`.**
`packages/platform-core/src/timers/` on the unmerged branch `m1.5/timer-service` (merge-base
`7882d04`) holds a `TimerService` with `clock.ts`, `record.ts`, `scheduler.ts`, `service.ts`,
`sync.ts` and `wire.ts`. Its own header states the split this ADR has to respect:

> It does not know what a game is, **does not call `onTimer` itself**, and does not touch
> Redis. The room runner (M1.6) owns the game module, the match log and persistence.

It already has `fixedClock` + `createManualScheduler` ("the test drives the manual
clock and calls `service.poll()`"), a `specs` option that rejects a `set` for an id the
manifest never declared, and a `TimerExpiry.dueAtMs` documented as "use this as `ctx.now` when
replaying". Every question [PER-142](/PER/issues/PER-142) asks has a draft answer in that
branch. The harness must not contradict it.

**2. The testkit may not import it.** `no-testkit-to-platform`
([ADR-0002](./0002-dependency-boundary-enforcement.md) §2, rev 2.2) forbids
`^packages/game-testkit/` → `^packages/(platform-core|netcode|ui)`, because the testkit is
reachable from game **test** paths (§2.5) and must not become a tunnel to the internals games
may not reach. So "just use `TimerService`" is not available, and widening the rule to get it
is precisely the platform→game-shaped leak the rule exists to stop. This is the constraint
that shapes the whole decision.

**3. The driver already collects the data and throws it away.** `ApplyResult.timers` is
returned by `createInitialState`, `applyAction` and `onTimer`. `playout()` records
`timers: applied.timers ?? []` on every step and never reads it; `abortRun()` does not even
record it — it takes `createInitialState(...).state` and drops the rest of the
`ApplyResult`. The wiring for this decision is a field the harness is already carrying.

### Why this is not urgent, and why it is still worth an ADR now

It does not affect chess. Chess's only unrecorded reason is `aborted`, reached by an action;
`abandonment` maps to the _recorded_ `disconnect_forfeit`. M2 is not blocked. It is worth
deciding now because the answer constrains what the M1.6 room runner may do, and because the
window in which the harness and `TimerService` can be made to agree cheaply is the window
before `TimerService` lands.

## Decision

### 1. The driver owns a timer queue fed by the game's own `TimerCommand`s. It never synthesises an `onTimer` call

This is the answer to [PER-142](/PER/issues/PER-142)'s first question, and it is the second of
the two options it offered: honour the commands the game actually emitted and fire the expiry
the game itself scheduled.

The driver's own header already commits to this standard — it "deliberately mirrors the real
runner's call order … so that a game which passes conformance is actually being exercised the
way `apps/realtime` will exercise it." A driver that calls
`onTimer(ctx, state, timerId, seatId)` from a scenario-declared payload is not mirroring the
runner; it is mirroring a game author's belief about the runner. Concretely, it would let this
pass:

> a game with an `onTimer` arm for `'first-move'` that **never emits**
> `setTimer('first-move', …)` from `createInitialState` or `applyAction`.

The gate would go green on an ending production can never reach. That is the same
opts-out-by-omission defect this ticket exists to close, moved one level down — and it is
worse than the current state, because the current state at least _says_ it never exercised the
unrecorded half.

The queue also fixes the payload question for free. `onTimer`'s `seatId` comes from the `set`
command that armed the timer, so with a queue the scenario cannot name a seat the game would
never have scheduled. With direct invocation, a hand-written `seatId` is unfalsifiable.

Obligations on the queue, all of which follow from the real service:

- **Ops.** All four of `set` / `clear` / `pause` / `resume`. Ignoring `pause` is not a
  simplification: it would make the harness fire a timer the real service had frozen, which is
  a **false failure** reported against the game.
- **Deadline.** `ctx.now` of the call that returned the command, plus `delayMs`. This is
  `timers.ts`'s stated semantics ("The runner resolves them against the same `ctx.now` it
  passed in"), and it is what makes the deadline a pure function of the log.
- **`replace` defaults true**, per `SetTimerCommand`.
- **Manifest cross-check.** A `set` for a `timerId` not in `manifest.timers` fails the
  scenario. `TurnBasedGameServer.onTimer`'s docstring already promises "`timerId` always
  corresponds to a `TimerSpec` declared in the manifest", and `TimerService` already enforces
  it via `specs`. The harness enforcing it too is a free check on a class of bug the suite
  currently cannot see at all.
- **Deterministic fire order.** Earliest deadline first; ties broken by `timerId` ascending.
  Named because "whatever `Map` iteration gives" is a reproducibility bug waiting for a
  two-timer game.
- **`onTimer`'s own `ApplyResult.timers` are applied**, so a fire may re-arm or clear. Bounded
  by §3's `maxFires`.

### 2. The clock advances to the deadline. `ctx.now` stays monotonic, and it is still pure

`contextAt(options, sequence)` today is `startNow + sequence * nowStepMs`. A timer fire uses:

```
ctx.now      = max(deadline, nowOfPreviousMutation)
ctx.sequence = next sequence
```

and the resulting offset is **carried forward** for the rest of that scenario, not applied to
one dispatch.

Three things about this:

- **It supersedes hand-tuning for the timer arm.** [PER-136](/PER/issues/PER-136)'s
  `advanceMs` is a number the scenario author picks and keeps in step with the game's
  `delayMs`. Here the offset is _computed from the game's own `delayMs`_, so it cannot drift
  from the deadline it is supposed to clear. That makes the timer arm strictly more
  trustworthy than the action arm on the clock axis, which is worth knowing when choosing
  between them.
- **Carried, not per-dispatch, is forced.** After a fire at `now = D`, a later sequence
  computed as `startNow + seq * nowStepMs` can be _less_ than `D`. `advanceMs` can be
  per-dispatch because the abort dispatch is the last thing that happens; a timer fire is not.
  This is the concrete reason the timer arm cannot reuse `advanceMs` and needed its own
  decision.
- **`max(…)` rather than `dueAtMs`, deliberately.** The real service reports
  `TimerExpiry.dueAtMs` and tells the runner to use it as `ctx.now`; under load `dueAtMs` can
  be _behind_ the last action's `ctx.now`, so production `ctx.now` is **not** monotonic across
  a late timer fire. The harness clamps instead. Inside a conformance run the two coincide
  (the harness is never late), and a harness that could rewind the clock would make a failure
  depend on a jitter value no fixture can pin. A game that breaks only on a rewound clock is a
  real bug and it is **out of scope for this gate** — see Revisit triggers.

Determinism is preserved: `now` is a pure function of `(scenario, sequence, the game's own
delayMs)`, with no value the harness invents. That is a stronger determinism property than the
action arm has.

### 3. One `abortScenarios` list, discriminated on `trigger`, defaulting to `'action'`

The answer to [PER-142](/PER/issues/PER-142)'s second question: a discriminated union on the
existing field, not a second field.

```ts
interface AbortScenarioBase {
  readonly label: string
  readonly afterSteps?: number
}

export interface ActionAbortScenario<TState, TAction> extends AbortScenarioBase {
  readonly trigger?: 'action' // absent === 'action'
  readonly advanceMs?: number // PER-136; action arm only
  abortAction(state: TState, roster: SeatRoster): { seatId: SeatId; action: TAction } | null
}

export interface TimerAbortScenario extends AbortScenarioBase {
  readonly trigger: 'timer'
  /** Which expiry this scenario means. Must be declared in `manifest.timers`. */
  readonly timerId: TimerId
  /** Fires to allow before giving up. Default 1. */
  readonly maxFires?: number
}

export type AbortScenario<TState, TAction> =
  ActionAbortScenario<TState, TAction> | TimerAbortScenario
```

- **The discriminant is optional on the action arm**, so every existing declaration compiles
  untouched. `trigger === 'timer'` narrows; the `else` branch is the action arm.
- **`timerId` is required, not optional.** A scenario that says "let some timer fire" is the
  weak declaration this ADR exists to replace: if a `grace` timer fires first and produces a
  _recorded_ `disconnect_forfeit`, an unnamed expectation yields a confusing failure, while a
  named one yields "the match ended on `grace` before the declared `first-move` fired". The
  cost is one string the game reads out of its own manifest.
- **`maxFires` bounds termination.** The driver fires in deadline order, applying each one as
  the runner would, until `timerId` fires, `getResult` goes non-null, or the budget is spent.
  Default 1 — the common case (a first-move timeout) is one fire, and a game with a cascade
  raises it explicitly.
- **No `advanceMs` on the timer arm.** §2 makes it meaningless there.

A parallel `timerAbortScenarios` field loses on three counts, in Alternatives.

### 4. No `packages/game-sdk` change, and no second scheduler — the two are reconciled by a shared fixture

Platform Engineer's stated worry was that "the shape touches the timer-service contract".
Measured, it does not: `TimerCommand`, `TimerSpec`, `manifest.timers`, `TimerId` and
`onTimer(ctx, state, timerId, seatId)` all already exist and are sufficient. This design
**exercises** the SDK timer contract; it does not change it. Nothing here needs board approval
after M2, and `AbortScenario` is testkit surface, not Game SDK contract, so it is not frozen by
[ADR-0008](./0008-game-sdk-contract-v1.md) either.

The queue therefore lives at `packages/game-testkit/src/internal/`, because §Context fact 2
leaves nowhere else for it. That accepts a real cost — a second reading of `TimerCommand`
semantics alongside `TimerService` — and this ADR does **not** discharge it with a promise to
be careful:

> **Obligation.** The normative semantics of `TimerCommand` become a data fixture —
> a table of `(commands, clock advances) → expected (timerId, deadline) fire order` — checked
> in under `packages/game-sdk/test/fixtures/`. The testkit queue must pass it. **`TimerService`
> must pass the same fixture as a condition of merging `m1.5/timer-service`**, and a new op or
> a changed tie-break adds a row before it changes either implementation.

A JSON fixture read by two test suites costs the SDK zero runtime surface, crosses no boundary
rule (`platform-core` → `game-sdk` and `game-testkit` → `game-sdk` are both legal), and is
reversible. If the two implementations still diverge, the promotion path is the pure reducer
into `game-sdk` next to `timers.ts` — by ADR, at that point, not pre-emptively now against an
implementation that is not on `main`.

### 4a. An equal-deadline tie fires in `timerId` ascending order, not in arm order (rev 2)

§4's obligation worked exactly as written: discharging it on [PER-252](/PER/issues/PER-252) found
that the two readings disagree on one thing, and the disagreement reached an ADR instead of being
closed by whoever noticed it.

**The disagreement, measured.** For two timers with the _same_ deadline:

| reading                                                              | equal-deadline order                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `TimerQueue` (`packages/game-testkit/src/internal/timer-queue.ts`)   | `timerId` ascending — what the fixture's row requires   |
| `TimerService.poll` (`packages/platform-core/src/timers/service.ts`) | the order the game's reducer emitted its `set` commands |

The service's `due.sort((a, b) => a.dueAtMs - b.dueAtMs)` has no secondary key.
`Array.prototype.sort` is stable and `#records` is a `Map` iterated in insertion order, so an
equal-deadline batch reached `onExpire` — and through the room runner, `game.onTimer` — in arm
order. [PER-252](/PER/issues/PER-252) asserted it positively in _both_ directions (arm `alpha`
then `beta` → `['alpha','beta']`; arm `beta` then `alpha` → `['beta','alpha']`), so it was
insertion order specifically and not an id-descending sort that happens to look like it. Both
suites were green throughout, which is the point: this is a divergence no test could see, because
each side only tested itself.

**Decision: `timerId` ascending is normative.** The fixture row was already right; the service is
corrected, in both of its ordering sites (see below).

Why, by the lenses that decide it:

- **Determinism.** The guarantee is that the same seed plus the same inputs reproduce the same
  outcome. Arm order makes the fire order a function of _the order two lines appear in inside
  `applyAction`_ — not of the match, the seed, the log, or anything a replay carries. Swapping two
  adjacent `setTimer` calls is a refactor with no semantic content, and under arm order it can
  change who wins, because `onTimer` can end a match. `timerId` ascending is a function of the
  declared ids, which are manifest data, and which **version pinning** already freezes for the
  life of a match.
- **Blast radius.** Arm order is not stated anywhere; it is an emergent property of `Map`
  insertion order, `list()`, `snapshot()`'s JSON array, Redis, and `restore()`'s re-insertion loop.
  Five layers would have to preserve an invariant none of them declares, and any future change to
  the snapshot encoding — a keyed object, a migration that re-sorts, a Redis hash — would silently
  change live match outcomes with every test still green. The chosen rule is one comparator, and
  cannot be broken that way.
- **Reversibility.** `timerId` ascending is a two-call-site change behind a fixture row that
  already existed. Arm order would have meant rewriting the testkit queue, rewriting the fixture
  row, _and_ taking on the durability invariant above.

**The alternatives, and why not.**

- _(a) Arm order is normative._ Rejected on the three lenses above. Note that the fixture row's own
  rationale already calls this a reproducibility bug, and it is right.
- _(b) Underspecified — drop the row, document equal deadlines as unordered._ Rejected, and it is
  the tempting one because it is free. An unordered contract is a contract two implementations are
  free to keep drifting on. Worse here specifically: `onTimer` can end a match, so "unordered"
  means "the same inputs may produce different results", and the conformance suite's whole job is
  to certify a game's determinism. You cannot certify a game against an underspecified platform.
- _(c) Promote a shared timer reducer into `packages/game-sdk` so there is only one reading._ Still
  the right answer eventually and still not now — this is §4's alternative (d) and its trigger has
  not fired. One divergence, found by the mechanism designed to find it and fixed by a comparator,
  is evidence the fixture is working, not that it is insufficient.

**Two corrections this required beyond the reported one.** [PER-255](/PER/issues/PER-255) named
`poll`. There were two ordering sites, and a fix applied only where the issue pointed would have
left the second:

1. `poll` — the primary path, `onExpire` → room runner → `game.onTimer`.
2. `#forceExpireDue` — the `MAX_DRAIN_PASSES` escape hatch, which reports through
   `onDrainExhausted` and had the same deadline-only sort. The shared fixture **cannot** reach it:
   its driver observes `onExpire` only, and `TimerQueue` has no drain cap for a row to describe. It
   is covered by a direct test in `packages/platform-core/test/timer-command-semantics.test.ts`
   instead, and this is a known limit of the fixture rather than a gap in it.

Both now use one `compareFireOrder` helper, so the next site cannot be added with a different rule.

**The fixture gains a row, and the existing one was not enough on its own.** §4 says a changed
tie-break adds a row before it changes either implementation. Strictly this tie-break is not
_changed_ — the table always said `timerId` ascending and the service never implemented it — but
the table could not tell the chosen rule apart from a plausible wrong one. The existing row
`ties-break-by-timer-id-ascending` arms in reverse id order, so it is **also satisfied by a rule
that simply reverses arm order**. `ties-break-by-timer-id-ascending-when-armed-in-id-order` arms
the same tie in id order; only the pair pins `timerId` ascending, and the property being pinned is
that arm order does not decide this at all. Measured: the new row passes against the _unfixed_
service too, because arm order and id order agree in that direction — it is a guard against a
future wrong fix, and the old row is what catches the divergence this amendment closes.

`packages/game-sdk/src/timers.ts` gains a sentence stating the guarantee where a game author writes
the commands, since the fixture is a test file and was the contract's only statement of it. That is
documentation on an existing type: no field, no signature and no runtime behaviour changes, so
[ADR-0008](./0008-game-sdk-contract-v1.md)'s contract-v1 freeze is not engaged and no board
approval is needed — and in any case this lands in M1, before the M2 gate it describes.

### 5. `result-standings-well-formed` keeps its name and its id

The check id does not change and no 12th check is added. The trigger is how the harness reaches
the ending; the thing being asserted is still [ADR-0006](./0006-unrecorded-match-results.md)'s
encoding. Forking the gate would make the conformance check set differ by base branch, which
is a known failure mode here — the same head has already reported a different check count
against two different bases (#58 vs #63).

Two consequences for the check:

- A `trigger: 'timer'` scenario whose game has **no `onTimer`** is a failure, not a skip —
  same rule as an `abortAction` that returns `null`. A declared abort that cannot run is a
  hole in the gate.
- The "declares no `abortScenarios`" note must name **both** arms, so "my ending is
  timer-driven and there is no way to say so" stops being a true excuse. It stays a note and
  not a failure: [ADR-0006](./0006-unrecorded-match-results.md) is clear that a game with no
  unrecorded ending is legal.

## Alternatives considered

### (a) The driver calls `onTimer` directly from a scenario-declared `{ timerId, seatId }`

[PER-142](/PER/issues/PER-142)'s first option, and much the cheaper of the two — roughly a
dozen lines against a queue, and it needs no `TimerCommand` semantics at all.

Rejected on the **server-authoritative** lens pointed at our own harness. It proves that a
game's `onTimer` _would_ produce a well-formed unrecorded result if the platform ever called
it, and proves nothing about whether the platform ever will. The specific green-on-unreachable
case is in §1. It also makes `seatId` a fiction the scenario author writes, where the queue
takes it from the `set` command the game emitted.

There is an honest argument for it — the harness is not the runner, and every check here is
already an approximation. It loses because this particular approximation drops the exact fact
the check is trying to establish: that the ending is _reachable_.

### (b) A parallel `timerAbortScenarios` field

Tidier at the type level: no union, no optional discriminant, no narrowing.

Rejected on three counts, all about the check rather than the types. The "no abortScenarios"
note becomes a two-field condition and is wrong the day someone updates one branch of it. The
check iterates two lists and has to interleave two failure vocabularies. And a game whose only
unrecorded ending is timer-driven declares an empty `abortScenarios` and a populated
`timerAbortScenarios` — which trips the note keyed on the wrong array, reintroducing this
ticket's bug as a false negative in the gate that was supposed to fix it.

One list, one discriminant, one note. The union costs one optional field on the arm that
already exists.

### (c) Generalise `advanceMs` into "advance the clock until something fires"

Attractive because [PER-136](/PER/issues/PER-136) has just shipped the clock-offset machinery
and this reuses it: keep one scenario kind, let the driver push `ctx.now` forward and see what
happens.

Rejected because without a queue there is nothing to fire — `advanceMs` moves `ctx.now` for a
_dispatch_, and a timer-driven ending has no dispatch. Adding the queue is the whole of the
work, after which the union in §3 is the cheap part. It also keeps the clock a hand-tuned
number rather than the game's own `delayMs` (§2), which is the property that makes the timer
arm worth having.

### (d) Promote a timer reducer into `packages/game-sdk` now, and have both sides import it

The structurally correct answer to the two-implementations problem, and the one I would take if
`TimerService` were on `main`.

Rejected on **reversibility**. It adds runtime surface to the package every game imports, in
order to de-duplicate against an implementation that currently exists only on an unmerged
branch off a five-week-old merge-base — and `m1.5/timer-service` may yet change shape before it
lands. Committing SDK surface to match a draft is the expensive, hard-to-reverse choice made
first. §4's fixture buys the same guarantee (the two agree, and CI says so) at the cost of a
JSON file, and leaves promotion available as the documented escalation.

### (e) Widen `no-testkit-to-platform` so the testkit can use `TimerService`

Zero duplication, perfect fidelity: the harness runs the actual service, with the manual clock
and manual scheduler that branch already provides for exactly this purpose.

Rejected, and it is not close. Game test paths may import `game-testkit`
([ADR-0002](./0002-dependency-boundary-enforcement.md) §2.5), so this edge makes
`platform-core` transitively reachable from inside a game's own package — the tunnel the rule
was written to prevent, opened by the person who wrote the rule, for convenience. The
**plugin boundary** lens gives one answer and the fact that the workaround is a JSON file makes
the trade obvious. Noted here because it is the option a future reader will re-propose, and
they should find it already refused.

### (f) Do nothing; document the limit in `AbortScenario`

Defensible today: chess does not need it, no game on `main` declares any `abortScenarios` at
all, and the gate's own notes already say when the unrecorded half went unexercised.

Rejected because the cost of deciding rises rather than falls. The harness's timer semantics
have to agree with `TimerService`, and the cheap moment to arrange that is before
`TimerService` merges, not after. A documented limit also has a way of being read as a
sanctioned one.

## Evidence

This is a decision about what a gate can observe, so the checkable claims are counts and call
paths, not latency. All counted against `7d16885` (`origin/main`) unless stated.

| Claim                                                      | Measured                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Checks in `TURN_BASED_CHECKS`                              | 11; `result-standings-well-formed` is the last                                                         |
| `TimerCommand` ops the queue must implement                | 4 (`set`, `clear`, `pause`, `resume`)                                                                  |
| `TimerKind` members                                        | 6                                                                                                      |
| Reasons in `UNRECORDED_RESULT_REASONS`                     | 2 of 7 in `RESULT_REASONS`                                                                             |
| Ways `abortScenarios` can reach an unrecorded ending today | 1 (`abortAction`)                                                                                      |
| Games on `main` declaring any `abortScenario`              | **0** — the only hits for `abortScenarios` are `game-testkit`'s own `src/` and `test/fixtures/race.ts` |
| `ApplyResult.timers` read by the driver                    | 0 call sites; `playout()` records them, `abortRun()` discards the whole `ApplyResult` bar `.state`     |
| SDK files this design changes                              | **0**                                                                                                  |
| Boundary rules this design changes                         | **0**                                                                                                  |

Two branch facts that this decision depends on, and that will age:

- `AbortScenario.advanceMs` ([PER-136](/PER/issues/PER-136)) is **not on `main`**. It is
  `0a1932b` on `per-136/testkit-abort-advance-ms`, whose `merge-base` with `main` is `7d9479e`.
  §3's union is written to sit on top of it, so **[PER-136](/PER/issues/PER-136) lands first**;
  if the order inverts, the action arm ships without `advanceMs` and PER-136 adds it to that
  arm.
- `TimerService` is **not on `main`**. It is `m1.5/timer-service`, merge-base `7882d04`. §4's
  fixture obligation is written as a merge condition on that branch precisely because it has
  not merged.

**What I have not measured.** Nobody has yet written a game with a timer-driven unrecorded
ending, so the shape in §3 is validated against the real `TimerService` and the real SDK
contract, not against a game that needs it. The first implementation should build the fixture
game _before_ the harness — a reference subject in `packages/game-testkit/src/reference/`
whose only unrecorded ending is a first-move timeout — so that the surface is shaped by a
consumer rather than by this document. If that exercise contradicts §3, §3 is what gives way.

## Consequences

**Easier**

- A game whose only unrecorded ending is timer-driven can declare it, and
  [ADR-0006](./0006-unrecorded-match-results.md) §1 gets exercised for that game instead of
  noted as unexercised.
- The harness gains a timer queue, which is the missing prerequisite for every other
  timer-shaped check we do not have yet: that a game clears the turn timer it set, that a
  pause on disconnect actually freezes a clock, that `onTimer` is pure. None are in scope here;
  all become cheap.
- The manifest cross-check (§1) catches a `set` for an undeclared `timerId` — a real bug class
  the suite is blind to today, at no extra cost.

**Harder**

- Two readings of `TimerCommand` semantics exist until §4's fixture lands. That is the price of
  `no-testkit-to-platform` and it is the right price, but it is a debt with a named creditor,
  not a free lunch.
- `abortScenarios` is now a union. A game author reads two arms where they read one, and the
  optional discriminant is the kind of thing that is obvious in the type and invisible in an
  example. The reference subject in §Evidence is partly there to make the timer arm
  copy-pasteable.
- The harness's fire ordering and `pause` handling are now contract, so a change to them is a
  change to what every game's gate means.

**Discovered gap — filed, not fixed here.** `replay()` in the driver replays a log of
`{ sequence, seatId, action }` entries. A timer fire is a state mutation with **no action and
no seat**, so it cannot be expressed in that log — which means the determinism check's replay
would diverge from a live match the moment a timer mutates state, and, more seriously, that a
crash-recovery replay built on the same shape would too. This is not a defect introduced by
this ADR; it is one this ADR's queue makes visible for the first time. It belongs to the match
log and the room runner (M1.6), not to `abortScenarios`, and it is filed separately. **Version
pinning** and **blast radius** both apply: a match that cannot be replayed correctly after a
restart shows the player a lie.

**Committed to**

- The conformance driver reaches a timer-driven ending **only** by firing a timer the game
  itself asked for. No check may synthesise an `onTimer` call, now or later.
- `result-standings-well-formed` stays one check with one id.
- `TimerService` and the testkit queue agree by fixture, and the fixture is the thing that
  changes first.

**Cost to reverse:** cheap. `AbortScenario`'s timer arm is additive and testkit-local; deleting
it removes a scenario kind and breaks no game that did not declare one. The queue is internal.
Nothing here is persisted, versioned, or visible to a game's source.

## Revisit triggers

- **A game genuinely depends on `ctx.now` moving backwards across a late timer fire.** §2
  clamps; production does not. The fix is not to un-clamp the harness — it is to decide in the
  SDK whether `ctx.now` is monotonic per match, and say so in `timers.ts`. If we decide it is
  not, the harness needs a declared lateness to make the failure reproducible.
- **`m1.5/timer-service` lands with semantics the §4 fixture cannot express** — a hold scope, a
  `chess-clock` that only counts down for the seat to move. Then the harness is modelling a
  different machine, and the promotion of a shared reducer into `game-sdk` (alternative (d))
  comes back as the answer.
- **A second scenario kind is proposed** — a disconnect-driven unrecorded ending via
  `onDisconnect`, which is the obvious next one. Two arms is a union; four is a sign that
  `abortScenarios` wants to be "declare a route to a state" rather than "declare a trigger".
  Reopen before adding the fourth, not after.
- **`maxFires` default 1 turns out to be wrong for real games.** Cheap to change, recorded so
  the change is understood as maintenance rather than a contract break.
- **A second §4 divergence is found (rev 2).** One was evidence the fixture works. A second —
  especially one the table cannot express, as `#forceExpireDue` could not — means the two readings
  are drifting faster than a data table can hold them, and §4 alternative (d), promoting a shared
  timer reducer into `packages/game-sdk`, becomes the answer. Reopen on the second, not the third.
- **A game needs two timers to resolve a tie in an order other than `timerId` ascending (rev 2).**
  §4a is a total order chosen for determinism, not for game semantics. A game that needs "the match
  timer always wins a tie" is asking for a priority on `TimerSpec`, which is an SDK contract change
  and board-gated after M2. The answer is probably that it should not land on the same millisecond.
- **A game needs to assert the timer fired and the match stayed live** (a warning timer). That
  is not an abort scenario at all and must not be bent into one; it is the separate timer check
  the queue makes cheap.

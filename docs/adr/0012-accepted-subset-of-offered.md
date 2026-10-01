# ADR-0012: Accepted actions are a subset of offered actions

- **Status:** Accepted
- **Date:** 2026-10-01
- **Author:** CTO
- **Milestone:** M1 (rule + turn-based check); real-time half owed in M6
- **Issue:** [PER-203](/PER/issues/PER-203)

## Context

[PER-198](/PER/issues/PER-198) fixed a wire-boundary defect in chess. `chess.js` silently
drops a `promotion` letter on a move that cannot promote, so `{ from: 'a7', to: 'a8',
promotion: 'q' }` played a plain rook lift and `{ from: 'e2', to: 'e4', promotion: 'q' }`
played the double push. Every ordinary move had a **second wire spelling** that
`getLegalActions` never lists. The fix is merged (PR #101, on `main` at `15efe05`).

The guard is correctly game-local: only the game knows its own canonical spelling. But the
_rule_ is platform, and until this ADR it was written nowhere — not in
`packages/game-sdk/src/turn-based.ts`, not in the README, not in the testkit.

Three things make this worth a decision rather than a comment.

**It is general.** Applying the generality test: any game whose engine or parser tolerates a
field it then ignores has this hazard. It is not a chess quirk, it is what happens whenever a
permissive parser sits behind a schema that declares more than the rules consume.

**It is not cosmetic.** `getLegalActions` drives move hints, bot seats, and the conformance
fuzzer's own playouts. The match log and replays key off the action _as sent_. A spelling the
platform cannot enumerate is a spelling nothing tests, nothing hints, and no replay
reproduces — and under **determinism**, a match log that can contain a payload the generator
never produces is a log we cannot claim to replay.

**Real-time is more exposed, not less.** Prop Hunt's `inputSchema` sits on a binary encoding,
where padding bits, reserved flags, non-canonical varints and clamped enum discriminants each
multiply the spellings per input — and none of them are visible in the TypeScript type. Under
**real-time readiness**, the rule has to be written before the netcode kit exists, not after.

The question this ADR has to answer is not whether to state the rule. It is whether the
conformance gate can _prove_ it, because today it demonstrably cannot, and a gate that is
believed to cover something it does not is worse than an absent one.

### What the gate does today

`checkLegalActionsAgree` in `packages/game-testkit/src/checks/actions.ts` walks
`sampleIndexed(states, 6)` — six states per run — across at most twelve runs. Its reverse
direction (`accepted ⊆ offered`) draws its corpus from two places: the subject's declared
`probeActions`, and the actions `getLegalActions` offered to the _other_ seats at that state.

Both sources are sampling arguments, and they fail on exactly the inputs that matter.
`probeActions` are absolute payloads tried at whatever states a random playout happened to
reach. The chess subject probes `{ from: 'a7', to: 'a8', promotion: 'q' }` at every sampled
state, and the suite still passed 11/11 without the guard at 96 seeded playouts — random play
essentially never puts a white rook on a7 with a8 empty, so the probe never landed anywhere
the spelling was legal. The other-seats corpus can only contain spellings `getLegalActions`
already produces, so a spelling it omits _everywhere_ is invisible to it by construction.

## Decision

**1. State the rule in the contract.** An action a game validates as legal must be
byte-identical, after `actionSchema`, to one `getLegalActions` offered for that seat at that
state. _Accepted ⊆ offered_, not merely _offered ⊆ accepted_. One move has exactly one wire
spelling. Written on `getLegalActions` and `actionSchema` in
`packages/game-sdk/src/turn-based.ts`, mirrored onto `inputSchema` in
`packages/game-sdk/src/realtime.ts`, and as rule 5 in the README. The fix is always to reject
the extra spelling in `validateAction`, never to widen `getLegalActions` to enumerate both.

**2. Add a perturbation direction to `legal-actions-agree`.** Yes — the testkit can do better
than sampling, and the measured cost does not justify declining. At each state the check
already samples, take each _offered_ action, add one optional field that `actionSchema`
declares and the action does not carry, re-parse, and require the result to be rejected unless
it is itself in the offered set.

Three properties make this cheap and safe:

- It is **not a new assertion**. The existing reverse direction already asserts "accepted
  implies listed", with a `listedKeys` escape for actions that _are_ legitimately offered.
  Perturbation only supplies a better corpus to that same assertion, so it adds no new
  false-positive surface. A perturbation that happens to be another genuinely legal move
  (`promotion: 'q'` → `promotion: 'r'` on a real promotion) is in the offered set and is
  skipped, exactly as today.
- It is **reachable from every state**. Unlike `probeActions`, the corpus is built _relative
  to_ the position, from moves that are legal there. The a7-rook problem disappears: you do
  not need the playout to wander anywhere.
- A perturbation the **schema wall already rejects is not a finding** and is dropped before
  `validateAction` is called. The check measures exactly the gap between `actionSchema` and
  the offered set, which is precisely where this defect class lives.

**3. The absence of a corpus must be loud.** This is the condition on which approval rests.
If `actionSchema` is not an introspectable object schema, or declares an optional field whose
inner type the value sampler cannot read, the check must emit a note **naming the field**, and
must not report the perturbation direction as covered. We have been bitten by green
placeholders before (`passWithNoTests` overriding coverage thresholds; conformance checks that
opt out by omission). A perturbation direction that silently generates zero probes and reports
a pass would reproduce that failure exactly, on a check whose entire purpose is to stop a
silent pass.

**4. The real-time half is owed, not done.** `inputCodec` must round-trip canonically:
decoding a buffer and re-encoding the result must reproduce it byte for byte, and a
non-canonical buffer must be rejected rather than normalised. This is stated in the contract
now and is checked in M6 with the netcode kit, because there is no real-time conformance
driver to host it in M1. See **Revisit triggers**.

## Alternatives considered

### Accept sampling as it stands

Lost on measured evidence, below: a planted PER-198-shaped defect passes the suite at every
seed count tried, including 24 playouts per variant. The failure is not probabilistic — the
corpus cannot contain the payload, so more sampling converges on nothing. Leaving it would
also leave the contract's reverse direction asserted in the check's own docstring ("a
disagreement in either direction") while being unenforceable in practice, which is the
specific thing the **budget before optimisation** lens exists to stop: a claim with no number
behind it.

### Raise the seed count or the sampled-state count

Lost for the same reason, and it is worth being explicit because it is the obvious first
reach. The reverse corpus is `probeActions ∪ (actions getLegalActions already offers)`. No
value of "more seeds" adds a payload to a set that is closed under neither. PER-198 measured
this directly at 96 playouts. It also costs linearly in CI time, against a conformance suite
that already runs on every PR.

### Mandate `actionSchema.strict()`

Lost because it does not address this defect class at all, and believing it did would be
worse than knowing it does not. `.strict()` rejects _unknown_ keys. `promotion` is a _known,
declared, optional_ key — `.strict()` passes it through untouched. The testkit already emits a
`.strict()` note on unknown-key tolerance; that note is about client-version skew and is
unrelated. Keeping both and saying so is the point.

### Harvest the perturbation keys from the offered set instead of from the schema

That is: take the union of keys appearing on any action `getLegalActions` offered anywhere in
the run, and add the missing ones. Attractive because it needs no schema introspection and no
coupling to zod internals. Lost on coverage: for chess under random play, no offered action
anywhere in a playout carries `promotion`, so the harvested key set never contains it and the
motivating defect stays invisible. It reintroduces the reachability problem one level up. It
is cheap enough to keep as a _supplement_ — it also catches fields a schema types as required
on a variant — but it cannot be the primary source.

### Have the subject declare the perturbations

A new `TurnBasedConformanceSubject` field listing `{ key, values }` pairs. Lost as the primary
mechanism for the reason `probeActions` already disappoints: coverage you have to remember to
opt into is coverage that is missing precisely on the games nobody reviewed carefully. The
schema already contains the answer; asking the author to restate it is a second source of
truth that can drift. Retained only as the declared fallback for a schema the introspector
cannot read, and in that case the note from decision 3 fires, so the gap is visible.

### Make the extra spelling unrepresentable in the type

Model the action as a discriminated union — `{ kind: 'move', from, to } | { kind: 'promotion',
from, to, piece }` — so there is no optional field to tolerate. This is structurally the
strongest answer and we should prefer it where it is natural; it is now the recommendation in
the `actionSchema` doc comment. It lost as a _mandate_ on two counts. It would force a wire
format change on chess immediately after PER-198 shipped a working guard, buying a
reversibility cost for no new safety. And it does not generalise to the case that worries me
most: a binary real-time encoding has padding bits and non-canonical integer encodings that no
TypeScript type can exclude, so the check is needed regardless of how the type is shaped.

### Property-based testing with shrinking (fast-check or similar)

Lost on cost and on determinism. It introduces a new dependency into a gate that runs on every
PR, replaces a bounded, deterministic call count with a search whose runtime we would then
have to budget, and under **determinism** a shrinking search that finds a counterexample on
one CI run and not the next is a flaky gate. The perturbation corpus is enumerable and
bounded, which is the property that makes it safe to put in front of every PR.

## Evidence

Measured on `main` at `15efe05`, in a scratch worktree, against the `hidden-hand` reference
subject in `packages/game-testkit` (the only conformance subject on `main`; chess's SDK module
is still in flight on [PER-128](/PER/issues/PER-128)). zod is pinned at `^3.24.1` in
`game-sdk`, `game-testkit` and `games/chess`.

**The planted defect.** `hidden-hand`'s `actionSchema` gains `face: z.enum(['up','down'])
.optional()`. No reducer reads it, and `getLegalActions` lists only the bare spelling — PER-198's
exact shape on a game whose playouts are reproducible.

**Sampling is blind to it, at every seed count tried:**

| `playoutsPerVariant` | `legal-actions-agree` | suite |
| -------------------- | --------------------- | ----- |
| 1                    | pass                  | pass  |
| 3                    | pass                  | pass  |
| 12                   | pass                  | pass  |
| 24                   | pass                  | pass  |

**Perturbation catches it at zero seeds**, from the opening position alone: a corpus of 4
perturbed actions produced 4 findings, with no playout executed.

**No false positives on the clean subject.** Against unmutated `hidden-hand`, schema
introspection finds zero optional fields, so the corpus is empty and the direction produces
nothing. The 27 existing mutation tests in `packages/game-testkit/test/mutants.test.ts` pass
unchanged.

**Cost obeys an exact law.** Over the same grid the check already walks (6 sampled states ×
each seat × 12 runs), perturbed-corpus size equals forward-direction corpus size times the
number of declared optional fields:

```
[cost law] fields=1 forward=216 perturbed=216 ratio=1.000
```

So the cost is **`|optional fields declared by actionSchema|` × the `validateAction` calls the
forward direction already makes** — zero for a schema with no optional fields, 1× for chess
(`promotion`). Against the full suite run, that is +216 `validateAction` calls on a baseline of
1,083, i.e. **+20%** of the suite's `validateAction` calls.

Wall clock for those calls measured 0.6 ms, 1.3 ms and 0.6 ms on three consecutive runs
against a 63–78 ms baseline — under 2% either way, but the spread is as large as the quantity,
so **the call-count law above is the number to hold us to, not the milliseconds.** For a game
with an expensive `validateAction` — chess replays its move log through `chess.js` — the
honest statement is that this check at most doubles the cost of the forward direction, and the
forward direction is already in the budget.

> **Measurement owed.** The chess figure is a projection from the cost law, not a measurement:
> chess has no conformance subject on `main` yet. Platform Engineer re-measures against the
> chess subject on the implementation issue, and reports the real suite wall clock there. The
> law, not the projection, is what the acceptance criteria pin.

## Consequences

- **Easier:** the rule now has one statement, in the contract, that a review can cite. The
  tolerated-field class of bug is caught at zero seeds instead of never, and caught on the
  game that introduces it rather than in a chess-specific code comment.
- **Easier:** the check's own report distinguishes "covered, N probes" from "not covered,
  reason", so "the conformance suite is green" stops silently meaning "this direction never
  ran".
- **Harder:** `actionSchema` becomes load-bearing for _testing_, not just for parsing. An
  author who types an action loosely to keep the schema simple now pays for it in probes. That
  is the intended pressure.
- **Harder:** the testkit gains a dependency on zod v3 schema internals (`_def.typeName`,
  `.shape`). This is real coupling and I am accepting it with a named mitigation: the
  introspector's self-check from decision 3 doubles as the version canary — if a zod upgrade
  changes the internals, the suite reports "could not read `actionSchema`" rather than quietly
  generating nothing. A zod major is a stack change and is board-gated under ADR-0001
  regardless.
- **Committed to:** `inputCodec` canonical round-tripping, as a contract term, before the
  netcode kit is written. If the M6 encoding cannot satisfy it, that is an ADR amendment, not
  a quiet relaxation.
- **Not covered, and we should say so:** perturbation is a _key_-level technique. It will not
  find a value-level second spelling — a case-insensitive square parser accepting `'E2'`, a
  field accepting both `3` and `'3'`, a tolerated trailing space, or a redundant ordering in an
  array payload. It also does nothing for a game that does not implement `getLegalActions`
  (the check skips, as today). Those remain the game author's responsibility under the stated
  rule, which is why decision 1 is not contingent on decision 2.
- **Cost to reverse:** **cheap** (a day). The rule is a doc change; the check is one corpus
  generator behind an existing assertion, deletable without touching the contract.

## Revisit triggers

- A game needs an action type the introspector cannot read, and the declared fallback starts
  being used routinely rather than exceptionally — the schema is then the wrong source of
  truth and we should reconsider the subject declaration.
- A value-level second spelling ships to production. That is the limitation named above
  turning into a real defect, and it argues for a canonicalisation requirement on
  `actionSchema` (parse to a normal form, compare normal forms) rather than more probes.
- The M6 netcode kit cannot make `inputCodec` canonically round-trip within the < 30 KB/s
  down and < 5 ms p99 tick budgets. Then the trade is explicit and this ADR is amended.
- zod moves to v4 across the workspace, or a game's `actionSchema` stops being a zod object
  (a custom codec, a branded parser). The introspector's assumptions are then stale.
- Chess's measured suite wall clock with perturbation enabled exceeds the PR-gate budget. The
  cost law says it should not; a measurement that disagrees beats the law.

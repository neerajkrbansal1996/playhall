# ADR-0010: Seating declarations belong on the manifest

- **Status:** Accepted
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M1
- **Issue:** [PER-138](/PER/issues/PER-138)

## Context

The seats layer ([PER-13](/PER/issues/PER-13), PR #66) is built on a rule it states in its
own header: core takes a `SeatingPolicy`, never a manifest, a module or a game id, so no
function in `seats/` can reach for a rule that is not declared. `seatingPolicyFor` is the
single place a manifest field becomes a seating rule.

Three of the rules that policy carries have no manifest field behind them.

`lateJoin` and `rematchRotation` were declared in `packages/platform-core/src/seats/policy.ts`
as an optional `SeatingDeclarations` interface and read _structurally_ off the catalogue
entry. That was the right call at the time and for the right reason — the manifest is an SDK
contract the CTO owns, so a platform commit must not extend it. The header says the intent
plainly: "the day the ADR lands and the fields become part of the manifest, this projection
already honours them and no platform code changes at all."

The problem is that the intervening state is not "the rule is declarable but nobody declares
it yet". It is "the rule is undeclarable". `toCatalogEntry`
(`packages/game-sdk/src/manifest.ts`) is an explicit field-by-field projection, and
`registry.ts` stores exactly its output, so a field a game writes on its manifest cannot
reach the entry the policy reads. Measured on PR head `0375325`:

```
[probe] manifest.lateJoin=fill_empty_seats -> entry.lateJoin=undefined
[probe] policy.lateJoin=spectate_only  policy.rematchRotation=seats
[probe] mid-match join outcome = spectating (declared fill_empty_seats)
```

A game that declares `fill_empty_seats` is silently given `spectate_only`, and the
`fill_empty_seats` branch in `resolveJoin` is unreachable code. This is the exact failure mode
[ADR-0002](./0002-dependency-boundary-enforcement.md) exists to prevent, arriving from the
other direction: not a game reaching into the platform, but a game unable to reach the
platform at all through the contract that is supposed to be the only channel.

`startMode` is a different shape of the same problem. It is not read off the entry at all — it
is _derived_: `minPlayers === maxPlayers ? 'auto_when_full' : 'host_starts'`. The derivation is
good, and the reasoning behind it is sound: a fixed-size game has exactly one playable roster,
so "full" and "ready to go" are the same fact, and asking the host to confirm it is a tap for
nothing against the < 10 s zero-friction target. But it is a platform opinion about a game's
rules, hard-coded in the one layer whose stated principle is that it holds no platform
opinions, and it is the only seating rule a game cannot override.

## Decision

**1. Ratify `lateJoin` and `rematchRotation` onto `GameManifest`.**

Both become optional manifest fields, projected by `toCatalogEntry` onto `GameCatalogEntry`,
with the same value spaces the seats layer already defines:

- `lateJoin`: `spectate_only` | `fill_empty_seats`
- `rematchRotation`: `none` | `seats` | `teams`

Both are seat-level concerns only. Neither needs a server-contract surface: no new hook, no
change to `applyAction`, `getViewFor` or the real-time contract. A game declares the rule and
the platform enforces it; the game module is not called.

**2. Make `startMode` declarable, and keep the derivation as its default.**

`startMode`: `auto_when_full` | `host_starts`, optional. When a manifest omits it,
`seatingPolicyFor` keeps deriving it from `minPlayers === maxPlayers` exactly as it does
today. No existing game changes behaviour, and the derivation stops being the one rule a game
cannot disagree with.

This matters in both directions. A fixed-size game that wants the host to start anyway — a
2-player game where the host picks colours first — cannot say so today. And a variable-size
game that genuinely should start the moment it fills has to route the request through a
platform change, which is precisely the escalation this SDK exists to make unnecessary.

**3. Restrict `fill_empty_seats` to real-time turn models.**

`validateManifest` rejects a manifest that declares `lateJoin: 'fill_empty_seats'` with a
`turnModel` other than `realtime`. This is a validation rule, not a silent downgrade: the
manifest fails at registry load with a named problem rather than quietly resolving to
`spectate_only`, which is the behaviour this ADR exists to eliminate.

The reason is a gap in the turn-based server contract, not a product preference. The
real-time contract has `onPlayerJoin(ctx, world, seat)` — a newcomer arriving mid-match is a
first-class event the game is told about and can react to. The turn-based contract has
`onDisconnect` and `onReconnect` and **no join hook**. Seating a newcomer into a running
turn-based match would splice an occupant into a roster that `createInitialState` already
fixed, with no callback through which the game could initialise them: no hand to deal, no
starting position to assign, no way to decide whether it is even legal. `getViewFor` would be
called for a seat the state has never heard of.

Turn-based mid-match seat substitution is therefore a **separate contract change that needs
its own hook**, not something to smuggle in behind a seating flag. See Consequences.

## Alternatives considered

**Leave the declarations structural in `policy.ts` and teach `toCatalogEntry` to pass unknown
manifest fields through.** Rejected on two counts. It makes the catalogue entry an open bag,
so the JSON crossing the network stops being a reviewable contract and a typo in a game's
manifest becomes indistinguishable from a field the platform has not implemented yet — the
failure stays silent, which is the defect being fixed. It also contradicts
[ADR-0008](./0008-game-sdk-contract-v1.md): the manifest is the enumerated list of what the
platform may learn about a game without importing it, and "plus anything else you write" is
not an enumeration.

**Put the three rules in game-local config the platform fetches separately.** Rejected by the
generality test. Every one of them is a question the _lobby_ must answer — may this arrival
take a seat, does the rematch button rotate, does a full room start itself — before any game
code has been loaded. A second, unlike game needs the identical three answers. That makes them
platform surface, and the manifest is how platform surface is declared.

**Ratify `lateJoin` and `rematchRotation` but leave `startMode` derived.** This was the
narrow reading of the [PER-135](/PER/issues/PER-135) review, and it is what the issue was
almost written as. Rejected because it leaves a hard-coded platform opinion in `seats/`,
which costs the layer the property that makes it reviewable: today you can audit "does core
branch on a game?" by reading `SeatingPolicy`, and with one derived rule you cannot — you have
to know which fields are real. Adding it now is three lines and an optional field; adding it
after M2 costs an ADR plus a board gate.

**Allow `fill_empty_seats` on turn-based games and let each game cope.** Rejected under
server-authoritative and blast radius. There is no hook through which a turn-based game could
cope, so "coping" would mean the platform mutating a roster the game's state does not agree
with. The first symptom is a `getViewFor` call for an unknown seat; the honest outcomes are a
crash or a view that lies to a player about a match they are supposedly in.

**Make the three fields required.** Rejected under reversibility. Required fields force every
existing manifest and fixture to change in the same commit that introduces the contract
change, which makes the change expensive to revert and couples it to work owned by three other
engineers. Optional-with-documented-default gives identical behaviour for a game that declares
nothing, and the defaults are already written down in `policy.ts`.

## Evidence

The probe above is the measurement that motivates the ADR: on PR head `0375325`, a manifest
declaring `fill_empty_seats` produces `entry.lateJoin === undefined`, a policy of
`spectate_only`, and a mid-match arrival that spectates. Reachability was the claim under
test, and it failed.

There is no performance number owed here. All three fields are read once, at registry load,
into a `SeatingPolicy` that is already computed per game rather than per join; the change adds
three property copies to `toCatalogEntry` and no work to any request path.

The coverage owed is behavioural and is stated in Consequences: the existing
`entryWithDeclarations` fixture in the seats tests splices the fields onto an entry object by
hand, so it passes whether or not the projection carries them. That fixture cannot catch this
class of gap and its replacement is part of the work.

## Consequences

- **A game can now declare a seating rule and have it obeyed.** The `fill_empty_seats` branch
  in `resolveJoin` stops being dead code. This is the point of the ADR.

- **`GameCatalogEntry` grows three nullable fields.** They follow the existing convention for
  optionals on the entry (`teamCount`, `realtime`): projected as `null` when undeclared, not
  omitted. The JSON crossing the network is one enum value per field per game.

- **`SeatingDeclarations` in `policy.ts` is now redundant and must be deleted.** Its fields
  are on the entry, so `seatingPolicyFor` should take a plain `GameCatalogEntry`. Until PR #66
  does that, the intersection type `GameCatalogEntry & SeatingDeclarations` will narrow
  `lateJoin` to a non-nullable type and stop accepting a real entry — a compile error, which is
  the correct way for this to surface. The same commit adds the `startMode` default and
  corrects the header comment, which currently claims the fields are honoured today.

- **Turn-based mid-match seat substitution stays unavailable, deliberately.** A turn-based game
  cannot declare `fill_empty_seats` and will fail validation if it tries. Making it available
  is a _separate_ SDK contract change that must add a join hook to the turn-based contract —
  something with the shape of `onPlayerJoin(ctx, state, seat): TState`, deterministic, able to
  reject the arrival — and must answer what happens to turn order when the roster grows
  mid-match. That is a post-M2 contract change and therefore board-gated. It is not in scope
  here and must not be approximated by relaxing the validation rule.

- **No contract-major bump.** Three optional fields are additive: a game written against the
  current contract validates and behaves identically. `sdkContractVersion` stays at 1.

- **Pre-M2, so no board approval.** After M2 an equivalent change needs an ADR _and_ a board
  decision. This is the last cheap moment to add these fields, which is part of why `startMode`
  is included now rather than deferred.

- **A test must exercise the real path.** `createGameRegistry` → `entryById` →
  `seatingPolicyFor`, on a manifest that actually declares the fields. A hand-built entry
  object proves nothing about a projection, which is how the original gap survived review.

## Revisit triggers

- **A turn-based game has a real need to seat a substitute mid-match.** Chess with a takeover
  rule, or a party game where a kicked player's seat should not stay dead. That is the trigger
  to design the turn-based join hook, and it reopens decision 3 rather than this ADR as a
  whole.

- **A game needs a seating rule these three do not express** — a seat reserved for the host, a
  join window that closes N seconds in, a rotation that follows team rather than seat. Two such
  requests mean the answer is a seating _policy descriptor_ declared as data, in the shape
  [ADR-0007](./0007-settings-form-descriptor.md) uses for the settings form, rather than a
  fourth, fifth and sixth enum field on the manifest.

- **The `startMode` default turns out to be wrong for most games rather than a few.** If the
  majority of manifests end up declaring `startMode` explicitly to escape the derivation, the
  derivation is not a default — it is a guess, and it should be removed in favour of a required
  field.

- **`fill_empty_seats` proves insufficient for real-time games** — for instance if a game needs
  to distinguish "fill a seat vacated by a disconnect" from "fill a seat that was never taken".
  That splits the enum rather than reopening the decision to declare it.

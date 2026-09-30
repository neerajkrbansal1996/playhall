# ADR-0002: Dependency-boundary enforcement

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 — §2 gains `no-game-to-colyseus`. The board adopted Colyseus as the
  server framework ([ADR-0001](./0001-v1-stack.md) §4, rev 4), so the framework now has to be
  held out of `games/**` mechanically rather than by convention. [PER-72](/PER/issues/PER-72).
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-5](/PER/issues/PER-5) (epic [PER-3](/PER/issues/PER-3))

## Context

The one rule this platform is built on: **a game must never need a change outside its own
folder.** Everything else — a lobby that serves two unlike kinds of game, an SDK a third
party could write against, adding a game without touching another bundle — depends on that
rule holding.

A rule that holds because everyone remembers it does not hold. [PER-5](/PER/issues/PER-5)
asks for it to be mechanically enforced and leaves the tool choice to me. This ADR makes that
choice and, more importantly, **writes down the rule set itself** — because the tool is the
cheap part and the rule set is the contract.

## Decision

**dependency-cruiser is the enforcing gate**, run in CI as its own job (`pnpm boundaries`),
with the rule set in one committed, reviewable `.dependency-cruiser.cjs`. A narrow ESLint
`no-restricted-imports` layer inside `games/*` provides editor-time feedback but is **not**
the gate.

### 1. Why dependency-cruiser and not ESLint boundaries

| Requirement                                                                | dependency-cruiser       | `eslint-plugin-boundaries`  |
| -------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| Rules in one declarative file a reviewer can read end to end               | Yes                      | Spread across ESLint config |
| Error names the violated rule, so the failure is self-explaining           | Yes (`name` + `comment`) | Rule id only                |
| Sees **dynamic** `import()` edges                                          | Yes                      | Partially                   |
| Sees type-only imports                                                     | Yes                      | Yes                         |
| Can express "only _this one_ module may reach games"                       | Path-precise             | Awkward                     |
| Can validate declared `package.json` dependencies, not just source imports | Yes                      | No                          |
| Covers files ESLint does not lint                                          | Yes                      | No                          |

The deciding factor is the dynamic-import row combined with the allowlist row. Our registry
must load games via dynamic `import()` (ADR-0001 §3, so a game adds zero bytes to other
bundles) while every _other_ platform→game edge stays forbidden. That is one narrow
path-based exception, which dependency-cruiser expresses directly and ESLint does not.

**Alternatives considered.**

- **`eslint-plugin-boundaries` / `eslint-plugin-import` alone** — lost on the table above.
  Kept as a _second_ layer for editor feedback, because a violation caught while typing is
  worth more than one caught in CI. Defence in depth, not the gate.
- **TypeScript project references alone** — an illegal import would become a typecheck error,
  which is appealing because it needs no extra tool. It lost because it cannot express
  "forbidden" at all: it only expresses "not reachable." The moment a package is legitimately
  in the graph for one reason, every import from it is legal. It also cannot forbid
  `Date.now()` or a `node:fs` import.
- **pnpm workspace `dependencies` discipline alone** — catches an undeclared dependency, does
  not catch a declared-but-illegal one. Someone adding `@playhall/platform-core` to
  `games/chess/package.json` would sail through. Necessary, not sufficient — which is why
  rule 8 below checks `package.json` too.
- **Review-only, no tooling** — rejected. The required reviewer is the last line of defence,
  not the only one. Human review is where judgement goes; a mechanical rule is where
  "someone was in a hurry on a Friday" goes.

### 2. The rule set (this is the actual contract)

All rules are `severity: error`. Every rule carries a `comment` that states _why_, because the
CI output is where an engineer meets this rule for the first time.

| Rule name                     | From                   | To (forbidden)                                                | Why                                                                                                               |
| ----------------------------- | ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `no-game-to-platform`         | `^games/`              | `^packages/(platform-core\|netcode\|game-testkit\|ui)`        | A game talks to the platform **only** through `game-sdk`.                                                         |
| `no-game-to-colyseus`         | `^games/`              | `colyseus`, `@colyseus/*` (import **and** declaration)        | The server framework is a platform choice. A game may never learn which one was picked. See the note below.       |
| `no-game-to-app`              | `^games/`              | `^apps/`                                                      | A game may not reach into the web shell or the server.                                                            |
| `no-game-to-game`             | `^games/([^/]+)/`      | `^games/` **except** `^games/$1/` (see note)                  | Games are independent plugins. Chess is not a special case.                                                       |
| `no-game-to-shared-internals` | `^games/`              | `^packages/shared/src/(?!index)`                              | Deep imports bypass the published surface.                                                                        |
| `no-platform-to-game`         | `^(packages\|apps)/`   | `^games/`                                                     | The platform never imports a game. Exception in §3.                                                               |
| `no-sdk-to-platform`          | `^packages/game-sdk/`  | `^packages/(platform-core\|netcode\|ui)`, `^apps/`, `^games/` | The SDK is a contract, not a client of the platform. It must stay dependency-light and independently publishable. |
| `no-game-node-builtins`       | `^games/`              | `core` (`node:*`, `fs`, `net`, `crypto`, …)                   | Game modules are **pure**: no I/O. This is what makes replay and reproducible tests possible.                     |
| `no-illegal-declared-dep`     | `games/*/package.json` | any `@playhall/*` except `@playhall/game-sdk`                 | A declared dependency is as much a violation as an import.                                                        |
| `no-circular`                 | any                    | itself (cycle)                                                | Cycles make version pinning and incremental build unreliable.                                                     |

`no-orphans` runs at `warn`, not `error` — a temporarily unreferenced file during development
is not a boundary violation and failing the build on it trains people to ignore the tool.

**Note on `no-game-to-colyseus`:** this is the only rule in the set that names a third-party
package, so it needs its reason written down rather than assumed.

The board adopted Colyseus as the server framework (ADR-0001 §4). ADR-0001 §4.2's sharpest
objection to Colyseus survives that decision unchanged: Colyseus state sync wants game state
expressed as `@colyseus/schema` classes, and a game that _can_ reach that package will
eventually use it. The moment one does, the SDK contract is Colyseus-shaped, every game is
pinned to the platform's netcode framework, and the game's state is default-broadcast by a
framework whose safe path is opt-in — a hidden-information leak, which is a correctness bug.
ADR-0001 §4.5 answers that objection with six layers; **this rule is layer 4, and it is the
only one a game author can run into.** The guard is what makes "exactly one adapter file in
`apps/realtime` names Colyseus" a build failure instead of a convention.

**Enforced in both halves of the gate**, because either alone has a hole:

- dependency-cruiser catches the **import**, matching both the resolved path
  (`node_modules/colyseus/…`) and the bare specifier. The second alternation is not
  belt-and-braces: an import written before `pnpm install` has the package resolves to nothing,
  and a rule matching only the resolved form would pass on the first form a game author
  actually produces.
- `check-declared-deps.mjs` catches the **manifest declaration**, which under pnpm's strict
  `node_modules` is the only thing that would make the import resolve at all. Firing on the
  manifest line beats firing on the import three commits later.

**A prerequisite the new rule exposed, fixed with it.** `options.exclude` previously dropped
`node_modules` from the graph. `exclude` deletes a module _and every edge pointing at it_,
which meant **no rule in this set could constrain a game's third-party dependencies at all** —
`no-game-to-colyseus` would have been green and doing nothing on the case that matters most, a
game importing an installed `@colyseus/schema`. `doNotFollow` alone gives the same "we do not
audit inside libraries" behaviour while keeping the edge visible. Measured on the M0.1 graph:
48 → 53 modules, 55 → 61 dependencies, 0.46 s → 0.33 s wall clock — inside noise, and far
inside the 20 s budget below. This is stated here because a silently-blind gate is the worst
failure mode this ADR has, and it was one line of config away.

**This rule is a denylist of one framework, and that is deliberate.** Third-party dependencies
in games stay otherwise unrestricted (§2, `no-illegal-declared-dep`); games need libraries. The
generalisation is not "games may not use libraries", it is **"a game may not import the
platform's own infrastructure choices."** The next entry here would be a second such choice,
not a second library someone dislikes.

**Note on `no-game-to-game`:** dependency-cruiser supports _group matching_ — a capture group
in `from.path` is referenced as `$1` in `to.path` / `to.pathNot` (dependency-cruiser's own
syntax, not a regex backreference). So the rule reads "from any game, to any game that is not
this one":

```js
{
  name: 'no-game-to-game',
  severity: 'error',
  comment: 'Games are independent plugins. A game may not import another game.',
  from: { path: '^games/([^/]+)/' },
  to:   { path: '^games/', pathNot: '^games/$1/' },
}
```

One rule covers all present and future games. A per-game rule list would rot the first time a
game is added — the same failure mode as the convention we are replacing.

### 3. The one allowlisted platform→game edge

`no-platform-to-game` has exactly **one** exception, and it is narrow by construction:

- **Allowed:** a _generated_ registry module, matched by path
  `^apps/[^/]+/src/games\.generated\.ts$`, may `import()` game entry points **dynamically**.
- **Forbidden:** everything else, including any static import, and including any hand-written
  file.

Three properties make this safe rather than a loophole:

1. **It is generated, not written.** A script enumerates `games/*/` and emits the file. No
   engineer hand-writes a platform→game import, so the exception cannot be _used_ by someone
   trying to get around the rule — they would have to edit a generated file, which review
   catches.
2. **`packages/platform-core` gets no exception at all.** The platform core never references a
   game, not even dynamically. Composition happens at the app root.
3. **Dynamic-only keeps the bundle promise.** A static import would pull every game into the
   shared chunk and break "adding a game adds zero bytes to other bundles."

**Constraint this places on other issues:** the generated-registry script is a requirement on
[PER-4](/PER/issues/PER-4) (scaffold) and [PER-12](/PER/issues/PER-12) (registry + routing).
If the registry ends up hand-written, this ADR is violated and the boundary rule must fail the
build — not be relaxed. Platform Engineer: flag it to me rather than widening the allowlist.

### 4. Determinism is enforced here too

The boundary rules keep a game from reaching _outward_. Determinism keeps it from reaching
_upward_ into ambient state, and it is enforced by ESLint (already committed in
`eslint.config.mjs`), not by dependency-cruiser:

- `Date.now` → banned in `packages/**/src` and `games/**/src`. Use `ctx.now`.
- `Math.random` → banned in the same scope. Use `ctx.rng`, seeded server-side with the seed
  stored on the match.
- `node:*` builtins in `games/` → banned by `no-game-node-builtins` above.

Together these give the property the platform is built on: **same seed plus same inputs
reproduce the same outcome.** That is not tidiness — it is what buys us replays, crash
recovery and reproducible tests, and it is why an escape hatch here is never granted.

**Known gap, stated rather than hidden.** `no-restricted-properties` catches `Date.now()` and
`Math.random()` written literally. It does not catch `const n = Date; n.now()`, or
`new Date()`, or `performance.now()`. Closing that fully needs a custom lint rule.
**Decision: accept the gap for M0**, add `new Date()` and `performance.now()` to the banned
list on [PER-5](/PER/issues/PER-5) (both are cheap `no-restricted-syntax` / `no-restricted-properties`
entries), and treat aliasing as a review matter. A determined engineer can always defeat a
lint rule; the rule exists to stop the accident, and the conformance testkit
([PER-17](/PER/issues/PER-17)) is the real backstop — it runs a game twice with the same seed
and fails it if the outcomes differ.

### 5. The negative test (what [PER-5](/PER/issues/PER-5) must deliver)

PER-5 requires "a deliberately added illegal import in a game package fails CI with a readable
error naming the rule, and that negative case is committed as a test." A file that permanently
breaks the build is not acceptable. The committed form is:

- Fixtures live in `tools/boundary-fixtures/*.fixture` — **not** a `.ts` extension, so they are
  invisible to the normal module graph, typecheck and lint.
- A test copies each fixture into a scratch package under the workspace, runs
  dependency-cruiser against it, and asserts **both** that the exit code is non-zero **and
  that the expected rule name appears in the output**. Asserting the rule name is the point:
  it proves the _right_ rule fired, not merely that something failed.
- One fixture per rule in §2. A rule with no fixture is a rule we have not proven works.

This is also how we demonstrate epic acceptance criterion 3 to the board: the test output
_is_ the evidence, and it is repeatable rather than a one-off broken build.

## Evidence

> **Measurement owed.** dependency-cruiser's runtime on the full graph must be reported by the
> Platform Engineer on [PER-5](/PER/issues/PER-5). Budget: **< 20 s**, so it can run on every
> PR as a separate CI job. If it exceeds that, the fix is `--cache` plus scoping to changed
> packages, not dropping the gate.

The structural argument does not need a measurement: the table in §1 is about
_expressiveness_, and the dynamic-import and single-allowlist requirements are either
supported or not.

## Consequences

**Easier**

- "Games are plugins" becomes a build failure instead of an argument in review.
- The whole boundary contract is one file a new engineer — or a third-party SDK consumer — can
  read in two minutes.
- Review attention moves to design, because mechanics are covered.

**Harder**

- Two tools to keep in sync (dependency-cruiser gate, ESLint editor layer). Mitigated by the
  ESLint layer being deliberately narrow — it duplicates only the game-package rules.
- A legitimate new dependency edge requires a rule-set edit, which is a reviewed change. That
  friction is intentional: **an SDK contract change needs an ADR first, and after M2 it needs
  board approval too.** Widening a boundary rule is exactly such a change.

**Committed to**

- No CI bypass. The boundary job is required, like lint and typecheck.
- When an engineer needs a platform change so their game can work, that goes through an SDK
  ADR where I decide whether the need is **general** (platform) or **specific** (game). The
  answer is often "put it in the game," and the rule set is what makes that answer stick.
- One fixture per rule, kept in step with the rule set.

**Cost to reverse:** cheap. The rule set is the asset; the tool running it is swappable.

## Revisit triggers

- dependency-cruiser runtime exceeds 20 s on the full graph even with caching → scope it to
  changed packages, keep the rules.
- A second legitimate platform→game edge appears → **do not add it to the allowlist.** That is
  a signal the registry abstraction is wrong. Escalate to me for an SDK ADR.
- A game needs a `node:*` builtin → the game is doing I/O it should not. The capability belongs
  behind an SDK-provided `ctx` facility, decided by ADR, or it belongs nowhere.
- A game asks to import `colyseus` or `@colyseus/*` → **the answer is no, and the rule does not
  move.** The need is real but misplaced: the game wants a capability the SDK does not expose
  yet. Escalate to me, and the outcome is an SDK addition (an ADR) or "put it in the game" —
  never a widened denylist. The one thing that would reopen this rule is the board replacing
  Colyseus, in which case the rule's package list changes with ADR-0001 §4, not on its own.
- The server framework changes → ADR-0001 §4 is the deciding document; this rule's package list
  follows it in the same PR, and the fixtures follow the rule.

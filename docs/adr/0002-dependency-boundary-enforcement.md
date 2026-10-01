# ADR-0002: Dependency-boundary enforcement

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (rev 2) — **§2 gains one rule** forbidding a game from depending on the
  platform's server framework, drafted here as `no-platform-framework-in-games` and shipped as
  **`no-game-to-colyseus`** (see rev 3).
  [ADR-0001](./0001-v1-stack.md) §4 was decided the other way by the board (approval
  [15587c20](/PER/approvals/15587c20-53fb-499e-9b53-4718df50a5df), rejected 2026-09-30): Colyseus
  is the server framework. ADR-0001 §4.2 condition 2 forbids a game from depending on it, and
  rev 1's rule set could not express that — it denylists `@playhall/*` internals only, so
  `pnpm add colyseus` in a game package failed nothing. The rule closes that gap. Nothing else in
  this ADR changes.
- **Amended:** 2026-09-30 (rev 2.1) — the rev-2 row named **two** of Colyseus' three published
  packages. `colyseus.js`, the browser client, matches neither `^colyseus$` nor `@colyseus/*`,
  and it is the name a game's client code reaches for first. §2's row and §5's fixture
  obligation are corrected; the rule, its severity and its scope are unchanged. Found while
  reviewing [PER-75](/PER/issues/PER-75). The implementation on
  [PR #28](https://github.com/neerajkrbansal1996/playhall/pull/28) already denylists all three;
  the implementation on [PR #29](https://github.com/neerajkrbansal1996/playhall/pull/29) does
  not, because it is stacked on an older lineage. This row is the contract both must match.
- **Amended:** 2026-09-30 (rev 2.2) — **five rulings from the [PER-97](/PER/issues/PER-97) review
  of [PR #28](https://github.com/neerajkrbansal1996/playhall/pull/28)**, which merged as `c50da31`
  and made `boundaries` a live CI job. Implementing the rule set surfaced five places where this
  ADR and the config disagreed, and the implementer correctly refused to silently pick a side.
  Three are corrections to this document (§1 overstated dependency-cruiser; §2's
  `no-game-to-game` regex was wrong; §2 never stated the bare-specifier requirement that makes a
  rule enforceable). **Two change the rule set**: `@playhall/shared` becomes forbidden to games
  outright (tightening, §2.3), and `@playhall/game-testkit` becomes importable from a game's
  **test paths** under three constraints including a new `no-testkit-to-platform` rule
  (widening, §2.5). Both rule-set changes are decided here rather than deferred because we are
  pre-M2: after M2 the same two changes cost a board approval, and neither is a close call.
  The config work is [PER-139](/PER/issues/PER-139).
- **Amended:** 2026-09-30 (rev 3) — **naming correction, no decision changes.** Rev 2 drafted the
  game→framework rule as `no-platform-framework-in-games`. The implementation
  ([#28](https://github.com/neerajkrbansal1996/playhall/pull/28), `c50da31`) shipped it as
  **`no-game-to-colyseus`**, and revs 2–2.2 kept citing the drafted name in six places. So this
  ADR named a rule that does not exist in `.dependency-cruiser.cjs`: a reader checking whether
  ADR-0001 §4.2 condition 2 is enforced grepped for the name the ADR gave, found nothing, and
  could reasonably conclude it was unenforced. It is enforced. This rev makes the document
  describe the rule that is actually running, and §2.2 records **why the vendor-specific name was
  kept** rather than renaming the code to match the ADR. The rule, its severity, its scope and its
  fixtures are unchanged — only this document was wrong. Found on
  [PER-72](/PER/issues/PER-72).
- **Amended:** 2026-09-30 (rev 2.3) — **one clarification, no rule-set change.** §2.6 answers a
  question the rule set never covered: whether a game's PR may edit `pnpm-lock.yaml`. It may, if
  and only if the diff stays inside that game's own `importers:` stanza, and the manifest change
  and the stanza must land in the same PR. This is a clarification rather than a rule-set change
  because `no-illegal-declared-dep` already decides which dependencies are legal; §2.6 only says
  where the bookkeeping for that decision is allowed to live. It also records why
  `tsconfig.json` is **not** exempt on the same reasoning, and states the general test for the
  next generated file that raises this question. **Triggered on**
  [PER-24](/PER/issues/PER-24), where Game Engineer (Chess) stopped and asked rather than guess:
  declaring `@playhall/game-sdk` mechanically forces a root lockfile change, which reads as a
  violation of "a game must never need a change outside its own folder". Ruled there, then written
  up here on [PER-67](/PER/issues/PER-67) so the next game does not have to ask again.
- **Amended:** 2026-10-01 (rev 2.4) — **§2 gains one rule**, `no-package-to-app`, forbidding any
  `packages/**` module from importing an app. Shipped in `.dependency-cruiser.cjs` and named here
  in the same change, because §2's reconciliation ruling makes that mandatory
  ("Name the state when you add the rule"). Until now only two rules named `^apps/` as a target —
  `no-game-to-app` from `^games/` and `no-sdk-to-platform` from `^packages/game-sdk/` — so
  `platform-core`, `netcode`, `ui`, `game-testkit` and **every package's `test/` tree** could
  import an app and the gate said nothing. Measured, not inferred: a probe at
  `packages/platform-core/test/_probe-app-edge.ts` importing `apps/realtime/src/clock.ts`
  resolved (256 modules / 778 dependencies, up from 255 / 777) and `pnpm boundaries` reported
  **0 errors**. Found because a doc comment on `packages/platform-core/test/fixtures/real-clock.ts`
  asserted the edge was enforced; the comment was the only thing enforcing it. Direction is the
  substance, not tidiness: an app is a composition root, and `apps/web` and `apps/realtime` both
  import `platform-core` already, so the reverse edge inverts the dependency and is a cycle
  waiting to happen. Whether a package's `test/` tree deserves a narrower allowance (a type-only
  import of a server contract, say) was deferred to a CTO ruling rather than bolted on as a
  `pathNot`. That ruling is **no carve-out**, and it is written up in §2 beside the rule it
  constrains so it cannot be re-asked as an open question. Implemented on
  [PER-251](/PER/issues/PER-251); the stale comment was corrected on
  [PER-241](/PER/issues/PER-241); the §2 overlap note, the `test/` ruling and the reconciliation
  stamp were corrected in review on [PER-256](/PER/issues/PER-256).
- **Amended:** 2026-10-01 (rev 2.5) — **§2 gains one rule**, `no-app-to-app`, forbidding any
  `apps/<a>/**` module from importing a **different** app. Rev 2.4's justification for
  `no-package-to-app` — an app is a composition root, never a library, so importing one inverts the
  dependency and drags a whole Next.js or server app into anything that installs the importer —
  never mentions packages. It applies unchanged between two apps, and nothing forbade
  `apps/** -> apps/**`: `no-platform-to-game` is the only rule whose `from` includes `^apps/`, and
  its `to` is `^games/` only. Measured before the change, not inferred: a probe at
  `apps/web/src/lib/_probe-app-edge.ts` importing `apps/realtime/src/clock.ts` resolved
  (256 modules / 778 dependencies, up from 255 / 777) and `pnpm boundaries` reported **0 errors**.
  This is the more tempting of the two inversions, because the thing being reached for is usually
  plausible — a wire-protocol type or a room-code helper that happens to live in the realtime
  server — and §2's standing answer is the right one: move it down into `packages/shared` or a
  package and let both apps import it. A pure tightening, like rev 2.4: no such edge exists in the
  tree, so the rule lands at 0 errors with the module and dependency counts unchanged. The
  importing app's **own** directory is exempted via `$1` group matching, the same shape
  `no-game-to-game` uses (§2.4), so intra-app imports stay legal — §5 records the positive fixture
  that proves it, which is where this rule's precision actually lives. Numbered 2.5 and appended
  last per §2's revision-numbering note: these numbers are section-keyed, and this history's own
  order is the authority. Implemented on [PER-257](/PER/issues/PER-257).
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

**Rev 2.2 qualifies this.** The `pnpm boundaries` job runs two tools, not one:
dependency-cruiser owns the import edges, and `tools/boundaries/check-declared-deps.mjs` owns
the manifest declarations, which dependency-cruiser structurally cannot see. Both are the gate
and both are normative. See §1, "three tools".

### 1. Why dependency-cruiser and not ESLint boundaries

| Requirement                                                                | dependency-cruiser       | `eslint-plugin-boundaries`  |
| -------------------------------------------------------------------------- | ------------------------ | --------------------------- |
| Rules in one declarative file a reviewer can read end to end               | Yes                      | Spread across ESLint config |
| Error names the violated rule, so the failure is self-explaining           | Yes (`name` + `comment`) | Rule id only                |
| Sees **dynamic** `import()` edges                                          | Yes                      | Partially                   |
| Sees type-only imports                                                     | Yes                      | Yes                         |
| Can express "only _this one_ module may reach games"                       | Path-precise             | Awkward                     |
| Can validate declared `package.json` dependencies, not just source imports | **No** (see rev 2.2)     | No                          |
| Covers files ESLint does not lint                                          | Yes                      | No                          |

The deciding factor is the dynamic-import row combined with the allowlist row. Our registry
must load games via dynamic `import()` (ADR-0001 §3, so a game adds zero bytes to other
bundles) while every _other_ platform→game edge stays forbidden. That is one narrow
path-based exception, which dependency-cruiser expresses directly and ESLint does not.

#### Rev 2.2 correction: three tools, and which half of the gate each one owns

Rev 1 credited dependency-cruiser with validating declared `package.json` dependencies. **It
does not**, and that row above is corrected to `No`. Verified against dependency-cruiser 18.4.0:
every `dependencyTypes` value is derived from an import _edge_, so a dependency sitting in a
manifest that nothing has imported yet produces no edge and is invisible to the tool. The claim
was wrong in rev 1 and the rule set was built correctly anyway — which is the dangerous shape,
because it sends the next reader hunting for rule 8 in `.dependency-cruiser.cjs`, failing to
find it, and concluding the rule was never implemented.

The gate is **three** tools, not one, and the split is not arbitrary — each owns the half the
others cannot see:

| Surface                                    | Owns                                                                                                     | Is it the gate?                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.dependency-cruiser.cjs`                  | **Import edges.** Every rule in §2 whose violation is an `import`/`require`/dynamic `import()`.          | Yes                               |
| `tools/boundaries/check-declared-deps.mjs` | **Manifest declarations.** `no-illegal-declared-dep`, and the declaration half of `no-game-to-colyseus`. | Yes — same `pnpm boundaries` job. |
| `eslint.config.mjs` (`games/**` block)     | Editor-time feedback for the game rules, plus the determinism bans in §4.                                | No. Advisory mirror.              |

Two consequences that are easy to get wrong, so they are written down:

- **The first two are equally normative.** "The gate" is the `pnpm boundaries` job, which runs
  both. A rule enforced in `check-declared-deps.mjs` is not a lesser rule, and §2's table does
  not distinguish them — it states the contract, not the implementation.
- **The third is not, and must still be kept in step.** The ESLint block's own comment calls
  itself "the editor warning" for these rules. That is only true while it agrees with them. A
  carve-out landed in the gate and not in ESLint turns a correct import into a red squiggle and
  a failing `pnpm lint` — which trains people to disable the layer, and then it protects nothing.
  Rev 2.2's two rule-set changes therefore each name all three surfaces explicitly, and
  [PER-139](/PER/issues/PER-139) lands them together.

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
  rule 8 below checks `package.json` too, in `tools/boundaries/check-declared-deps.mjs` rather
  than in dependency-cruiser (rev 2.2).
- **Review-only, no tooling** — rejected. The required reviewer is the last line of defence,
  not the only one. Human review is where judgement goes; a mechanical rule is where
  "someone was in a hurry on a Friday" goes.

### 2. The rule set (this is the actual contract)

All rules are `severity: error`. Every rule carries a `comment` that states _why_, because the
CI output is where an engineer meets this rule for the first time.

| Rule name                 | From                                 | To (forbidden)                                                                                                       | Why                                                                                                                                         |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-game-to-platform`     | `^games/`                            | every package under `^packages/` **except** `game-sdk`; `game-testkit` is legal from game **test paths** only (§2.5) | A game talks to the platform **only** through `game-sdk`.                                                                                   |
| `no-game-to-app`          | `^games/`                            | `^apps/`                                                                                                             | A game may not reach into the web shell or the server.                                                                                      |
| `no-game-to-game`         | `^games/((?:_examples/)?[^/]+)/`     | `^games/` **except** `^games/$1/` (see note)                                                                         | Games are independent plugins. Chess is not a special case.                                                                                 |
| `no-package-to-app`       | `^packages/`                         | `^apps/`                                                                                                             | An app is a composition root, not a library. The reverse edge inverts the dependency and is a cycle waiting to happen. Added in rev 2.4.    |
| `no-app-to-app`           | `^apps/([^/]+)/`                     | `^apps/` **except** `^apps/$1/` (same `$1` group match as `no-game-to-game`, §2.4)                                   | Two composition roots, so the same inversion as `no-package-to-app` plus a cycle through the package both already import. Added in rev 2.5. |
| `no-testkit-to-platform`  | `^packages/game-testkit/`            | `^packages/(platform-core\|netcode\|ui)`, `^apps/`, `^games/`                                                        | The testkit is reachable from games (§2.5), so it must not be a tunnel to the internals games may not reach. Added in rev 2.2.              |
| `no-platform-to-game`     | `^(packages\|apps)/`                 | `^games/`                                                                                                            | The platform never imports a game. Exception in §3.                                                                                         |
| `no-sdk-to-platform`      | `^packages/game-sdk/`                | `^packages/(platform-core\|netcode\|ui\|game-testkit)`, `^apps/`, `^games/`                                          | The SDK is a contract, not a client of the platform. It must stay dependency-light and independently publishable.                           |
| `no-game-node-builtins`   | `^games/`                            | `core` (`node:*`, `fs`, `net`, `crypto`, …)                                                                          | Game modules are **pure**: no I/O. This is what makes replay and reproducible tests possible.                                               |
| `no-illegal-declared-dep` | `games/*/package.json`               | any `@playhall/*` except `@playhall/game-sdk`; plus `@playhall/game-testkit` in `devDependencies` **only** (§2.5)    | A declared dependency is as much a violation as an import.                                                                                  |
| `no-game-to-colyseus`     | `^games/` and `games/*/package.json` | `colyseus`, `colyseus.js`, `@colyseus/*`                                                                             | A game must not depend on the platform's choice of netcode framework. ADR-0001 §4.2 condition 2. Added in rev 2; renamed in rev 3.          |
| `no-circular`             | any                                  | itself (cycle)                                                                                                       | Cycles make version pinning and incremental build unreliable.                                                                               |

`no-orphans` runs at `warn`, not `error` — a temporarily unreferenced file during development
is not a boundary violation and failing the build on it trains people to ignore the tool.

**An app denial in a narrower row is a deliberate duplicate, not a bug (rev 2.4).** `^packages/`
in `no-package-to-app` includes every package that already has its own, narrower row naming
`^apps/` — and there are **two** of those, not one: `no-sdk-to-platform`, which is live, and
`no-testkit-to-platform`, which is contract-only until [PER-139](/PER/issues/PER-139). So a
`game-sdk → app` edge trips two rules and prints two lines today, and a `game-testkit → app` edge
will do the same once PER-139 lands. Both are intended. The alternative — excluding those
packages from `no-package-to-app` — would make the rule stop saying the thing it is named for,
"no package imports an app", and would leave the next reader checking two rows to answer one
question. A duplicated denial costs a line of CI output; a narrowed one costs the invariant. The
consequence for §5 is a constraint on fixtures, not a loosening of the rule: a fixture proving
`no-package-to-app` must be written from a package with no narrower row of its own, or it fires
two error rules and fails the suite's precision assertion.

**A package's `test/` tree gets no carve-out (rev 2.4 — normative, CTO ruling).** The question
rev 2.4 raised and deferred is answered: no. `no-package-to-app` covers `^packages/` including
every `test/` tree, with no `pathNot`, and the narrower allowance actually asked for — a
type-only import of an app's server contract — is **denied**. Two reasons, both checkable. First,
`pnpm --filter <pkg> test` has to be runnable against that package alone; an edge into an app
makes a package's test suite depend on a Next.js or server app resolving, which is the same
unpublishability the rule's `comment` objects to, arriving through `devDependencies` instead of
`dependencies`. Second, type-only is not a weaker edge here — dependency-cruiser sees it, and if
a package's test needs an app's contract type then the contract is in the wrong place: move it
into `packages/shared` or the package itself and let the app import it, which is the direction
that already works and the same answer §2 gives every other reach across this boundary. Revisit
only on a measured case where that move is impossible, and a `pathNot` then lands **after** the
ADR amendment that authorises it, never before.

**Reconciling this table against the config (rev 3 — normative).** This table is the contract, and
the contract is allowed to lead the config. But a reader must be able to tell which rows are live
**without** grepping, because not being able to is the exact defect rev 3 exists to fix. Every
`severity: error` rule in `.dependency-cruiser.cjs` must appear in exactly one line below, and
every row above must too. As of **2026-10-01** (rev 2.5 — the stamp is a date on purpose, see
below):

- **Live, and in this table** — `no-game-to-platform`, `no-game-to-app`, `no-game-to-game`,
  `no-package-to-app`, `no-app-to-app`, `no-platform-to-game`, `no-sdk-to-platform`,
  `no-game-node-builtins`, `no-game-to-colyseus`, `no-circular` are dependency-cruiser rules.
  `no-illegal-declared-dep`, and the manifest half of `no-game-to-colyseus`, are in
  `tools/boundaries/check-declared-deps.mjs` — equally normative (§1).
- **Live, but decided in another section or ADR** — not defects, listed so the config reconciles:
  `no-static-game-import-in-registry` is §3's dynamic-import requirement (the rule the prose there
  describes), and `no-zod-in-pure-settings` belongs to
  [ADR-0007](./0007-settings-form-descriptor.md) (Consequences), which owns the
  `settings-form.ts` / `settings.ts` split it enforces.
  `no-platform-core-node-builtins` (`^packages/platform-core/src/` → `core`, added in
  [PER-162](/PER/issues/PER-162)) belongs to
  [ADR-0011](./0011-platform-core-edge-importability.md) (§Decision part 4), not to this ADR's
  games boundaries. It does not enforce a package-wide edge-importability invariant — ADR-0011 §3
  shows a path denylist cannot express one — but the weaker, checkable claim that every Node
  builtin in `platform-core/src` is in the rule's exception list and that the list stays short
  enough to read. ADR-0011 governs its single permanent `pathNot` exception for
  `identity/guest-token.ts`, and defers re-keying the rule to a reachability assertion over the
  `/edge` graph. Listed here so the config reconciles.
  `no-orphans` and `not-to-unresolvable` run at `warn` by design.
- **Contract-only, not yet in the config** — `no-testkit-to-platform`, and the §2.3 retirement of
  `no-game-to-shared-internals`, which is still a live `error` rule in `.dependency-cruiser.cjs`
  even though §2.3 retires it and this table no longer lists it. Both are rev 2.2 decisions whose
  config work is [PER-139](/PER/issues/PER-139). Until that lands, "all rules are
  `severity: error`" above describes the **contract**, not the current config.

A rule added to either side without a line here is the drift rev 3 had to come back and correct.
**Name the state when you add the rule.**

**Revision numbers here are section-keyed, not chronological — never order them numerically
(rev 2.4 — normative).** A `rev 2.x` amends §2; `rev 3` was a whole-ADR naming correction across
the ADR. The two series run independently, so rev 2.3 was adopted **after** rev 3 (both
2026-09-30, and the revision history lists 2.3 below 3), and rev 2.4 is later still
(2026-10-01). A reader who compares revision numbers to decide whether the enumeration above is
current therefore gets the wrong answer: "as of rev 2.4" under a heading marked "rev 3" reads as
stale when it is in fact the newest state. Two consequences. **The stamp above carries a date**,
because a number cannot carry that information here. And **the authority for ordering revisions
is the revision history's own order** — read it top to bottom, the last entry wins — not the
number and not the date, since rev 3 and rev 2.3 share one. The convention stays as it is,
because a `2.x` number tells you which section moved and a monotonic counter would not, and
renumbering a revision already cited from the §2 table row, §5 and
`packages/platform-core/test/fixtures/real-clock.ts` costs more than it buys. The obligation that
comes with keeping it: the next §2 amendment is rev 2.5, is appended **last** in the revision
history, and **must re-stamp the date above** rather than only adding its name to a bucket.

#### 2.1 Every target above is matched three ways, not one (rev 2.2 — normative)

The `To (forbidden)` column is written as repo paths because that is how the contract reads. It
is **not** how the rule may be implemented. Any rule in this table whose target is a workspace
package must forbid **three alternations**, and a rule that forbids only the first is not a
rule:

1. `^packages/platform-core/` — the **resolved** path, reached through the pnpm workspace link.
2. `^@playhall/platform-core($|/)` — the **bare specifier** dependency-cruiser keeps as the
   module's path when the import does not resolve.
3. `(^|/)node_modules/@playhall/platform-core/` — resolved through an installed, non-linked copy.

This is the ruling with the widest blast radius of the five, and the only reason it is not
already obvious is that the path-only form _reads_ correct. Here is why it is not:
dependency-cruiser learns a module's repo-relative path only once the import **resolves**, and
pnpm's strict `node_modules` links a workspace package into a package only when that package
**declares** it. A game may never declare a platform package — `no-illegal-declared-dep` forbids
exactly that. So the realistic violation, `import { x } from '@playhall/platform-core'` written
inside a game with nothing added to its `package.json`, resolves to nothing, produces no path,
matches no path-based rule, and surfaces as a `not-to-unresolvable` **warning** with CI green.

Read that back: **a path-only rule is unenforceable precisely on the only state a game is
legally allowed to be in.** The form that looks right is silent on the likeliest violation and
loud on the one that cannot happen. This was found by planting a real illegal import, not by
reading the config.

Two obligations follow:

- **Package names are read from each package's own manifest, never typed as literals.** The npm
  scope is a brand string and the brand is still an open board decision; a hard-coded `@playhall`
  would make every rule here silently pass the day the scope is renamed. `.dependency-cruiser.cjs`
  derives the scope from `packages/game-sdk/package.json` and throws if it is unscoped — failing
  loudly beats passing quietly.
- **Every rule needs a fixture in the unresolved state** as well as the resolved one (§5).

`.dependency-cruiser.cjs` already implements this shape (`packageTargets`). Rev 2.2 changes no
code here; it states the requirement so the next rule written against this ADR is not written
path-only, shipped green, and believed.

#### 2.2 Note on `no-game-to-colyseus` (rev 2, renamed rev 3)

This is the only rule here that names a third-party package, and that asymmetry is deliberate
rather than an oversight to be tidied up later. `no-illegal-declared-dep` denylists `@playhall/*`, so it catches a game reaching for
_our_ internals and misses a game reaching for the framework _underneath_ them. Once ADR-0001 §4
put Colyseus in the tree as the server framework, `pnpm add colyseus` inside `games/chess` became
a change that fails nothing — an import boundary a reviewer has to remember, which is exactly
what this ADR exists to eliminate. These properties keep it honest:

- **It denylists, it does not allowlist.** Games may use any third-party library they like; the
  list names only packages whose presence in a game would mean the game had become coupled to a
  platform decision. Adding to the list is an ADR amendment, not a config tweak.
- **It covers the declaration and the import.** A game can couple itself either way, so both
  `from.path` and the `package.json` check are needed. This mirrors the split that already exists
  between `no-game-to-platform` and `no-illegal-declared-dep`.
- **It names all three npm packages, including the browser client.** Colyseus publishes under
  `colyseus` (server), `@colyseus/*` (`schema`, `core`, …) and `colyseus.js` (the browser
  client). `colyseus.js` matches neither of the other two patterns, and it is the one a game's
  _client_ code reaches for first — so a list written from the server package names leaves the
  likeliest violation green. Rev 1 of this row named two of the three; the omission was found by
  adding a real illegal import to `games/chess` on [PER-5](/PER/issues/PER-5), where it surfaced
  only as a `not-to-unresolvable` **warning**. The lesson generalises past Colyseus: when this
  list gains an entry, enumerate the package's **published names**, not the one the ADR happened
  to be arguing about.
- **The name is vendor-specific on purpose (rev 3).** `no-game-to-colyseus` reads worse as a
  _principle_ than the drafted `no-platform-framework-in-games`, and rev 3 kept the vendor name
  anyway rather than renaming the config to match this ADR. Three reasons. The pattern **is**
  vendor-specific — it matches `colyseus`, `colyseus.js` and `@colyseus/*` and nothing else — and
  a generic name over a specific pattern is precisely the failure mode where a reader assumes
  coverage the regex does not have. It matches the `no-<from>-to-<to>` convention every other rule
  in §2 follows. And it is the **reversible** direction: the rule is `severity: error`, green on
  `main`, and named by four fixture headers and the test harness's expectation map, so renaming
  the document costs a diff while renaming the gate risks a silent hole. **When a second platform
  framework appears, add a second sibling rule** — `no-game-to-<framework>` — rather than widening
  this one behind a generic name; the ADR amendment that admits the framework is where that
  decision belongs.

The behavioural half of the same condition lives in the testkit: a game module must pass
`packages/game-testkit` conformance with Colyseus **absent from the dependency tree**
([PER-17](/PER/issues/PER-17)). The boundary rule catches a declaration; the testkit catches a
reach the rule's patterns did not anticipate.

#### 2.3 `@playhall/shared` is forbidden to games outright (rev 2.2 — rule-set change, tightening)

**Decision: `no-game-to-shared-internals` is retired, and `shared` becomes an ordinary platform
internal covered by `no-game-to-platform`.** A game may not import `@playhall/shared` at all,
index or otherwise.

**The problem.** Rev 1 was internally inconsistent and the review caught it. §2's table let a
game import `shared`'s published index while rule 8 forbade a game from _declaring_ any in-scope
package but the SDK. Under pnpm's strict `node_modules` those two cannot both hold: a
permitted-but-undeclarable import does not resolve. One of them had to move.

**Why it moves toward the tighter reading.** _Games talk to the platform through exactly one
door._ A second importable platform package is a second contract surface with no ADR behind it,
and the **plugin-boundary** lens does not care that the package is named "shared" — it is
platform code, free to change under a game, with no version pinning and no conformance suite
holding it still. The **generality test** points the same way: anything a game genuinely needs
from `shared` is by definition general, so it gets re-exported by `game-sdk`, where the change
sits behind the SDK contract and, after M2, behind board approval. Routing it through the SDK
costs one re-export line. Routing it through `shared` costs us the ability to ever change
`shared` freely again.

**Alternatives considered.**

- **Widen rule 8 instead** — allow a game to declare `@playhall/shared`, making the import
  resolve. Rejected: it is the same change in the losing direction. It creates the second door
  by act of config, and the first game to use it makes the door permanent.
- **Leave the divergence and let the tools disagree** — rejected outright. A contract whose two
  halves contradict each other is worse than either half alone, because the next person picks
  whichever half suits them and both citations are honest.
- **Let `game-sdk` re-export the whole of `shared`** — rejected. That is the same second surface
  behind a rename, and it drags `shared`'s dependency weight into a package whose §2 obligation
  is to stay light and independently publishable. Re-export by item, on demand, with a reason.

**Cost to adopt: measured at zero.** On `9350947`: no game imports `@playhall/shared`, no game
declares it (`games/chess/package.json` declares `@playhall/game-sdk` and nothing else in scope),
and `game-sdk` does not import it either. This is a rule we can add for free today and would
have to buy back later.

**Already true in two of three surfaces.** `check-declared-deps.mjs` allows only the SDK, and the
ESLint `games/**` block already forbids `@playhall/shared` outright — carrying a comment that
states the divergence and asks the CTO to decide it. This section is that decision, in the
direction those two already implement. Only §2's import table and `.dependency-cruiser.cjs`'s
`PLATFORM_PACKAGE_DIRS` exclusion move.

**What would make us revisit.** A game needing something from `shared` that `game-sdk` cannot
sensibly re-export — for example a runtime value whose shape is genuinely platform-versioned
rather than contract-versioned. That is a signal the item is in the wrong package, not that this
rule is wrong. Bring it to me as an SDK ADR; the likely answer is that it moves into the SDK or
into the game.

#### 2.4 Note on `no-game-to-game` (corrected in rev 2.2)

dependency-cruiser supports _group matching_ — a capture group in `from.path` is referenced as
`$1` in `to.path` / `to.pathNot` (dependency-cruiser's own syntax, not a regex backreference).
So the rule reads "from any game, to any game that is not this one":

```js
{
  name: 'no-game-to-game',
  severity: 'error',
  comment: 'Games are independent plugins. A game may not import another game.',
  from: { path: '^games/((?:_examples/)?[^/]+)/' },
  to:   { path: '^games/', pathNot: '^games/$1/' },
}
```

**Rev 2.2 corrects `from.path`.** Rev 1 wrote `^games/([^/]+)/`, and against the layout the
workspace actually uses that is a bug, not a simplification. `games/_examples/<name>/` makes
`$1` the literal string `_examples`, so `pathNot` becomes `^games/_examples/` — which excuses
**every example game from importing every other example game**. The implementation on
[PR #28](https://github.com/neerajkrbansal1996/playhall/pull/28) already uses the corrected form;
this ADR is adopting it verbatim rather than the other way round, and the reason is recorded here
so that a later reader does not "tidy" the non-capturing group away and silently reopen the hole.

The generalisation, which outlives `_examples`: **a capture group used as `$1` must capture the
package, not a path segment that happens to sit at that depth.** Any future grouping directory
under `games/` needs the same treatment, and its fixture is what proves it.

One rule covers all present and future games. A per-game rule list would rot the first time a
game is added — the same failure mode as the convention we are replacing.

#### 2.5 `@playhall/game-testkit` is SDK-side surface, not a platform internal (rev 2.2 — rule-set change, widening)

**Decision: a game may import `@playhall/game-testkit` from its test paths, under three
constraints that are part of the decision and not softenable separately.**

**The problem.** Rev 1 put `game-testkit` in `no-game-to-platform`'s forbidden set. That is
wrong on this ADR's own reasoning. The boundary exists to stop a game coupling to code that is
free to change underneath it; the conformance testkit's entire purpose is the opposite — it is a
**stable assertion about the contract**, and a game that couples to it has coupled to the
contract, which is what we want. The **generality test** is unambiguous: every game uses it
identically, and no game uses it differently. And `games/_examples/README.md` already tells game
authors their game "must pass the `@playhall/game-testkit` conformance suite before it can
merge" — so rev 1's rule set forbade the workflow our own documentation requires. The first code
to hit this was [PER-128](/PER/issues/PER-128) making chess an SDK game module; the rule would
also have stopped [PER-17](/PER/issues/PER-17).

**The three constraints.**

1. **Test paths only** — `games/**/test/**` and `games/**/*.{test,spec}.{ts,tsx}`. Never from a
   game's shipped source. A game bundle must not grow by one byte because of a test harness, and
   "turn-based game bundle < 250 KB gzipped" is a target we are held to, not an aspiration.
2. **`devDependencies` only** — `no-illegal-declared-dep` allows `@playhall/game-testkit` there
   and nowhere else. The manifest section is the machine-checkable form of constraint 1: a
   testkit in `dependencies` is a statement that it ships.
3. **New `error` rule `no-testkit-to-platform`** — the testkit may import `game-sdk`, `shared`'s
   published index, and third-party, and nothing else. Its public surface may expose `game-sdk`
   types only; it may not re-export `shared`.

**Constraint 3 is why this is a rule addition and not merely an exemption.** Without it, ruling 4
hands every game a transitive path to every platform internal: the game imports the testkit
legally, the testkit imports `platform-core`, and the boundary that took this whole ADR to build
is gone through a door we opened for tests. The **blast radius** of getting this wrong is the
entire plugin boundary, which is why the constraint lands in the same change as the exemption
rather than being left as a follow-up.

**Measured, so the cost is known rather than assumed.** On `9350947`, `packages/game-testkit`
already satisfies constraint 3: across its 18 source files, every `@playhall` import is
`@playhall/game-sdk`. It declares `@playhall/shared` in `dependencies` and imports it zero
times. So the rule is **free to add today** and would be expensive to add once the testkit has
grown a reason to reach further — which is the argument for adding it in the same revision that
opens the door, not after.

`no-sdk-to-platform` gains `game-testkit` in the same change, for symmetry: the arrow runs
testkit → SDK and must never run back. `no-circular` would eventually catch a cycle; naming it
here makes the intent explicit rather than incidental.

**Alternative considered and rejected: a central generated conformance runner.** Instead of each
game importing the testkit, a generated file under `packages/` or `apps/` imports every game and
runs the suite against each. It keeps `game-testkit` in the forbidden set, so the boundary table
stays simpler. Rejected on the one rule this platform is built on: it is a **second generated
platform→game edge** (§3 exists to keep there being exactly one, and its revisit trigger says a
second one means the abstraction is wrong), and it means adding a game requires editing something
outside the game's folder — either the generated file's input list or its scaffolding. The test
harness is exactly where a game author should be able to work alone.

**Alternative considered and rejected: no constraint 1, testkit legal from anywhere in a game.**
Simpler to implement, one rule instead of a path-scoped pair. Rejected on bundle budget: nothing
would then stop a `games/chess/src/` import of the testkit except review, and this ADR exists
because "review will catch it" is not a mechanism.

**What would make us revisit.** Any of these:

- A game needs the testkit at runtime, not in tests → it is not a testkit need. The capability
  belongs in `game-sdk`, decided by an SDK ADR.
- `game-testkit` acquires a legitimate need for `platform-core`, `netcode` or `ui` → do **not**
  relax `no-testkit-to-platform`. Split the testkit: the part games import stays contract-only,
  the part that needs platform internals becomes a separate platform-side package that games
  cannot reach.
- The test-path carve-out starts being used to reach a _second_ package → that is the tunnel this
  section was written to prevent. Escalate to me, not to the config.

#### 2.6 Generated workspace metadata: when a game PR may touch `pnpm-lock.yaml` (rev 2.3 — clarification)

Rule `no-illegal-declared-dep` (§2) says which dependencies a game may _declare_. It says nothing
about the file that _records_ that declaration for the workspace, so the question "may a game PR
edit `pnpm-lock.yaml`?" has been answered by reviewer taste. It is answered here instead.

The question is not hypothetical: on [PER-24](/PER/issues/PER-24) the Game Engineer (Chess) hit it
and correctly stopped to ask, because declaring `@playhall/game-sdk` mechanically forces a root
lockfile change and this ADR gave no reading under which that was allowed. That round trip is the
cost of leaving it to taste, and it is paid once per game until the rule is written down.

**The rule.** A game package's PR may modify `pnpm-lock.yaml` **if and only if** the diff is confined
to that game's own `importers:` stanza.

The lockfile is a derived index of the workspace graph, not platform source. The stanza grants the
game nothing its `package.json` did not already grant: if the declared dependency is legal under
`no-illegal-declared-dep`, the lockfile entry is bookkeeping for a decision the gate has already
approved. Blocking it would mean a game cannot add a legal dependency without a platform PR — which
is the one rule this ADR exists to defend.

**Splitting the two across PRs is forbidden.** A `main` where the manifest declares a dependency the
lockfile cannot resolve is a `main` where `pnpm install --frozen-lockfile` is red for everyone,
including the engineers who touched neither file. The manifest change and its lockfile stanza land
together or not at all.

**Mechanics.** Regenerate with `pnpm install --lockfile-only`, never a full install, and show
`git diff -U0 pnpm-lock.yaml` in the PR description. Any _other_ importer moving, or any resolution
bumping, is workspace drift: it does not ride in on a game PR, and the required reviewer sends it
back.

**No other root-level file is exempt.** In particular `tsconfig.json` — the solution file — is
**not** on this list, and a game needs no entry in it. Measured on `9f0292b`:

1. `tsconfig.base.json` declares no `paths`, and `moduleResolution` is `"Bundler"`. A game resolves
   `@playhall/game-sdk` through the pnpm workspace symlink under `node_modules` — the same path Node
   and the bundler take. TypeScript config is not part of that resolution.
2. Root `tsconfig.json` lists six `packages/*` references and no game. That is deliberate: games are
   plugins, not members of the platform build graph. A game adding itself there would make the
   platform build depend on every game.
3. `games/chess` is the standing proof of both. It declares `@playhall/game-sdk: workspace:*`, has
   its own `importers:` stanza in `pnpm-lock.yaml`, appears nowhere in root `tsconfig.json`, and
   builds. The reference entry buys nothing, so the file needs no change.

**The generalisation**, for the next generated file that raises this question: a root file is exempt
only when it is **mechanically derived** from something the game already owns and legally declared,
**and** the game's slice of it is separable and reviewable in the diff. A file that requires a human
to make a judgement about the platform is not derived, and is not exempt. `pnpm-lock.yaml` passes
both tests; `tsconfig.json` fails the first.

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

**Rev 2: one fixture per _violation path_, not per rule.** `no-game-to-colyseus` is
the first rule where "one fixture per rule" is not enough, because the same rule is enforced
through several code paths and a fixture only proves the path it exercises. All four are
required:

1. **Declared** in a game's `package.json` — caught by `check-declared-deps.mjs`, not by
   dependency-cruiser, which sees no edge until something imports it. This is the half that is
   easiest to write by accident (`pnpm add colyseus`), so it is the half least acceptable to
   leave unproven. → `no-game-to-colyseus-declared.fixture`
2. **Imported and resolving** — the installed case, where the module's path in the graph is
   `node_modules/…`. → `no-game-to-colyseus.fixture`
3. **Imported but unresolved** — the same import written before `pnpm install`, where
   dependency-cruiser keeps the bare specifier as the path. A pattern matching only form 2 is
   green here, which is the worst failure mode a gate has: silent on the state an author is in
   while writing the violation. → `no-game-to-colyseus-unresolved.fixture`
4. **The browser client**, `colyseus.js` — the spelling that matches neither `^colyseus$` nor
   `@colyseus/*`. See the rev-2 note in §2. → `no-game-to-colyseus-client.fixture`

All four live in `tools/boundary-fixtures/` (rev 3 records the filenames so each form above is
greppable against the committed proof rather than taken on trust).

The generalisation: a fixture proves one path through one rule. Where a rule is enforced in more
than one tool, or over more than one package name, or against more than one resolution state,
it needs a fixture for each — and the fixture must assert the **rule name**, so a pass means the
right rule fired rather than something else failing nearby.

**Rev 2.4: `no-package-to-app`'s three fixtures, by violation path.** Same generalisation, three
paths, filenames recorded so each is greppable against the committed proof:

1. **Resolved, by package name** — `packages/netcode/src` imports `@playhall/realtime`, which
   links through `node_modules`, so the graph holds `apps/realtime/src/index.ts`. The importer is
   `netcode` and not `game-sdk` deliberately: `no-sdk-to-platform` already forbids game-sdk → app,
   so a fixture written from there would fire two error rules and fail the suite's precision
   assertion. → `no-package-to-app.fixture`
2. **Unresolved** — the same import with nothing linked, where only the bare specifier survives in
   the graph. Measured: with the bare-specifier alternation removed from the rule, this fixture's
   violation reappears as a `not-to-unresolvable` **warning** and the gate exits 0, which is §2.1's
   failure mode reproduced on this rule. → `no-package-to-app-undeclared.fixture`
3. **A package's `test/` tree, by relative path** — the case the rule was opened for, and the form
   a test author actually writes: an app is not a package a test can name, so nobody writes
   `@playhall/realtime` there; they count `..`s to the repo root. It shares alternation 1 with
   fixture 1 and exists anyway, because the regression it guards is a `pathNot` exempting `test/`,
   which no other fixture would catch. → `no-package-to-app-test-tree.fixture`

**Rev 2.5: `no-app-to-app`'s fixtures — two negative, and a positive one that carries the
precision.** Same generalisation again, with one difference that matters: this is the first rule in
§2 whose correctness is mostly a question of what it does **not** forbid, so the obligation below is
not satisfiable with negative fixtures alone.

1. **Resolved, by package name** — `apps/web/src` imports `@playhall/realtime`, which links through
   `node_modules`, so the graph holds `apps/realtime/src/index.ts`. Only one direction is written,
   because `from` is `^apps/([^/]+)/` rather than a named app: the reverse edge is the same rule and
   the same two alternations. → `no-app-to-app.fixture`
2. **Unresolved** — the same import with nothing linked, where only the bare specifier survives in
   the graph. Measured: with the bare-specifier alternation removed from the rule, the violation
   reappears as `warn not-to-unresolvable: apps/web/src/index.ts → @playhall/realtime` and the gate
   exits 0, which is §2.1's failure mode reproduced on this rule. It is the likelier state here than
   for a `packages/** -> apps/**` edge, since both apps are already in the workspace and
   `no-illegal-declared-dep` does not cover apps, so nothing notices the missing manifest entry
   either. → `no-app-to-app-undeclared.fixture`
3. **The exemption** — an app importing its own file (`apps/web/src/a.ts -> apps/web/src/b.ts`),
   which must stay **legal**. This goes in the positive control, `_legal.fixture`, for the reason
   rev 2.2 gives below: a negative fixture asserts the rule fired somewhere and is silent about
   whether the exemption held. It is not optional here. `^apps/` matches `apps/web/src/b.ts` exactly
   as readily as `apps/realtime/src/index.ts`, so the entire precision of this rule is the
   `pathNot: '^apps/$1/'` group match, and both negative fixtures above pass with it deleted.
   Measured: with `pathNot` removed, that one control is the only fixture in the directory that
   fails.

The positive case goes in `_legal.fixture` rather than a second `# expect: none` file on purpose —
the harness resolves the control with a `find`, so a second one would silently replace the first
instead of adding to it.

**Rev 2.2: a carve-out needs a _positive_ fixture too.** Every fixture obligation above is
negative — prove the rule fires. §2.5 introduces the first rule with a legal case sitting next to
an illegal one that differs only by path, and a negative fixture cannot tell those apart. A rule
that fires on both is as broken as one that fires on neither; it just fails in the direction that
gets it disabled. So the fixture set for rev 2.2's changes is:

| Fixture                                                         | Must | Proves                                             |
| --------------------------------------------------------------- | ---- | -------------------------------------------------- |
| Game **test path** imports `game-testkit`                       | pass | §2.5 constraint 1 does not over-forbid             |
| Game **`src/`** imports `game-testkit`                          | fail | the carve-out is not a tunnel into shipped code    |
| `game-testkit` in a game's `devDependencies`                    | pass | §2.5 constraint 2 does not over-forbid             |
| `game-testkit` in a game's `dependencies`                       | fail | the section, not just the name, is what is checked |
| `game-testkit` importing `platform-core`                        | fail | `no-testkit-to-platform` — §2.5 constraint 3       |
| Game imports `@playhall/shared`'s **index** (resolved and bare) | fail | §2.3, both alternations from §2.1                  |

The two "must pass" rows are the ones most likely to be skipped and the ones that will actually
bite: the failure they catch is an engineer being stopped from doing something this ADR says is
legal, which is how a gate loses its credibility.

The existing `no-game-to-shared-internals` fixtures retarget to `no-game-to-platform` rather than
being deleted — the import is still illegal, so the coverage is still owed; only the rule name in
the assertion changes.

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

- **Three** surfaces to keep in sync, not two (rev 2.2, §1): dependency-cruiser and
  `check-declared-deps.mjs` are both the gate, and the ESLint layer mirrors them for the editor.
  Mitigated by the ESLint layer being deliberately narrow — it duplicates only the game-package
  rules — but rev 2.2's experience is that a rule-set change touches all three or it is not
  finished. **A change to §2 is not landed until every surface it names agrees.**
- A game's test files now live under a _different_ rule from its source (§2.5). That is a real
  cost: two ESLint blocks where there was one, and a path-scoped pair in the gate where there was
  one rule. Accepted because the alternative was a platform→game edge (§2.5, rejected
  alternatives), which is a permanent cost against a bounded one.
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
- **A game needs something from `@playhall/shared`** (rev 2.2, §2.3) → re-export it from
  `game-sdk`. If it cannot sensibly be re-exported, the item is in the wrong package. Do not
  reopen the second door.
- **`game-testkit` needs a platform internal** (rev 2.2, §2.5) → split the testkit; do not relax
  `no-testkit-to-platform`. The rule is what keeps the test-path carve-out from being a tunnel.
- **A second package wants the §2.5 test-path carve-out** → that is the tunnel. Escalate to me
  for an SDK ADR; the carve-out is for the conformance contract, not for test convenience.
- **A game PR's `pnpm-lock.yaml` diff touches an importer that is not its own** (rev 2.3, §2.6) →
  that is workspace drift, not the game's bookkeeping. Send it back; it does not ride in on a game
  PR.
- **A second root-level generated file wants the §2.6 carve-out** → apply the two-part test in
  §2.6 (mechanically derived _and_ separably reviewable) before widening anything. If the file
  needs a human judgement about the platform, the answer is no.
- **A rule in §2 is proposed with a path-only target** (rev 2.2, §2.1) → reject it in review. It
  is green on the violation it exists to catch.
- **A game has a genuine need for something in `no-game-to-colyseus`** → the answer is
  not to allowlist it. Either the capability is general, in which case it belongs in
  `game-sdk` behind our own type (**generality test**), or it is specific, in which case the game
  finds another way. ADR-0001 §4.2 condition 2 is the constraint being enforced; relaxing the
  rule without amending that condition would make the condition decorative.

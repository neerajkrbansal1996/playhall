# CLAUDE.md

Guidance for agents working in this repository. Keep this file short — it is loaded into every
session. Put anything longer in `docs/` or in a skill under `.claude/skills/`.

## The repo

PlayHall: a pnpm workspace monorepo (`apps/`, `packages/`, `games/`). Start with
[`README.md`](README.md) for setup and [`docs/adr/README.md`](docs/adr/README.md) for the decisions
that constrain the code. CI gates are described in [`docs/ci-cd.md`](docs/ci-cd.md).

## Four rules CI and review will hold you to

**1. Dependency boundaries.** A package under `games/` may import `@playhall/game-sdk` and
third-party libs, and nothing else — never platform internals, never another game. The platform
never imports a game package; games are reached only through the registry. Every import must also be
declared in the importing package's own `package.json`. The `boundaries` gate (dependency-cruiser
plus `tools/boundaries/check-declared-deps.mjs`) fails the build on either violation — see
[ADR-0002](docs/adr/0002-dependency-boundary-enforcement.md). If a game appears to need a platform
change in order to work, that is an SDK ADR, not an import.

**2. Game modules are pure and deterministic.** No I/O, no `Date.now()`, no `Math.random()` under
`packages/*/src` or `games/*/src`. Read the clock as `ctx.now` — constant for the whole of one call
— and randomness as `ctx.rng`, derived from the match seed stored on the match. Same seed plus same
inputs must reproduce the same outcome; that is what buys replays, crash recovery and reproducible
tests, so a "just this once" ambient read is a correctness bug, not a style nit. `lint` catches
those two property accesses via `no-restricted-properties`, but it cannot see `new Date()`,
`performance.now()` or a clock captured at module scope — those are on you and on review.

**3. `zod` at every boundary.** Every JSON message and every HTTP input is parsed by a zod schema
before any other code reads it. A bare `await req.json()`, or a `JSON.parse` of a socket frame whose
result is used directly, is a review blocker regardless of what TypeScript claims the type is. On
the real-time path, inputs and snapshots are binary-encoded rather than JSON — do not add a
JSON-only wire format.

**4. Server-authoritative.** The server is the single source of truth for every action, position,
clock and result. A client sends intent and renders what it is told; it never decides a legal move,
an outcome or a deadline that it then reports back, because a modified client must not be able to
change what happened. Everything leaving the server for one player goes through `getViewFor` /
`getSnapshotFor`; hidden state that reaches the wrong client is a correctness bug, not polish.

## Paperclip control plane

Every agent on this board runs under Paperclip. Two control-plane behaviours have each cost a full
run of work, and both are written up in the
[`blocked-issue-and-blocker-edges`](.claude/skills/blocked-issue-and-blocker-edges/SKILL.md) skill —
read it before you set `blockedByIssueIds` on any issue, and read it in full if either of these
trips.

**1. An untethered run cannot comment.** `PAPERCLIP_TASK_ID` empty ⟺ every comment and status write
in that run returns `403 cross_issue_influence_run_context_required`, on every issue, including one
you check out — and resending `X-Paperclip-Run-Id` does not help. Take the document + interaction
exit in [§4 of that skill](.claude/skills/blocked-issue-and-blocker-edges/SKILL.md) instead, and
never exit a heartbeat silently because the API refused you.

**2. Blocker edges point up, never down.** Never give an issue a `blockedByIssueIds` edge to one of
its own descendants — a parent blocked by its child is redundant with `issue_children_completed`,
and a child blocked by its parent is a permanent deadlock. Never block an issue whose deliverable is
incrementally producible; model "cannot be finished yet" as an acceptance criterion instead.

# ADR-0001: The v1 stack

- **Status:** Accepted, **except §4.4 (real-time server framework) which is Board-gated**
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-8](/PER/issues/PER-8) (epic [PER-3](/PER/issues/PER-3))

## Context

We are building a browser-based multiplayer game platform (internal codename Atrium) where
**games are plugins**. Two unlike kinds of game — turn-based (Chess) and real-time 3D
(Prop Hunt, 4–12 players, 30 Hz) — must share one lobby, one invite flow, one seat model and
one result model. Most players arrive by tapping a link on a phone over mobile data.

The stack choices below are constrained by non-functional targets we are held to:

| Target                                                   | Constrains                               |
| -------------------------------------------------------- | ---------------------------------------- |
| Turn-based action round-trip < 150 ms p95 in-region      | transport, persistence, hosting region   |
| 30 Hz tick, < 5 ms p99 per tick for a 12-player room     | server framework, GC pressure, codec     |
| < 30 KB/s down per client in real-time                   | wire format — rules out JSON-only        |
| Landing LCP < 2 s on mid-range Android over 4G           | web framework, bundle budget             |
| Turn-based game bundle < 250 KB gzipped (excl. assets)   | ORM/client library footprint             |
| Adding a game adds **zero** bytes to other bundles       | dynamic imports, no static game registry |
| 2,000 concurrent turn-based rooms on one instance        | per-room memory, room runner design      |
| Turn-based games survive a server restart                | Redis + Postgres match log              |
| WCAG 2.1 AA on platform UI                               | component library                        |

Three of these ten are the load-bearing ones for this ADR: the **< 30 KB/s** real-time
budget, the **zero bytes to other bundles** rule, and **restart survival**.

Two decisions are deliberately **not** in this ADR:

- **Hosting provider** — board-gated, needs cost per 1,000 concurrent players. A later ADR.
- **The real-time netcode design** (room runner internals, snapshot codec, interest
  management, 3D stack) — that is [PER-21](/PER/issues/PER-21), design-only until the board
  opens M6. This ADR only fixes the seams so that ADR stays possible.

---

## Decision

### 1. Language, runtime, package manager

TypeScript everywhere. Node 22 LTS, pinned by `.nvmrc` and `engines.node`. pnpm workspaces,
pinned by `packageManager` and activated via corepack.

**Alternatives.** Bun was considered for `apps/realtime`: faster startup and a cheaper
`ws` path. It lost on **blast radius** — a runtime whose `node:` compatibility surface still
moves under us is the wrong place to put a server that must survive a restart with a
correct state. Deno lost for the same reason plus a smaller ecosystem for our Postgres and
observability choices. **Revisit** if a measured 30 Hz tick on Node misses the < 5 ms p99
budget by more than 2× in the M4 spike.

### 2. Monorepo layout and task running

The layout is fixed by the engineering standards: `apps/web`, `apps/realtime`,
`packages/{game-sdk,platform-core,netcode,game-testkit,ui,shared}`, `games/*`,
`games/_examples/*`.

Task orchestration: **plain `pnpm -r` / `--filter` for M0**, with TypeScript project
references (`composite: true`) for incremental typecheck.

**Alternatives.** Turborepo and Nx both give remote caching and a task graph, which we will
want once CI runtime becomes the bottleneck. Both lost *for now* on **reversibility**: they
are cheap to add later (a `turbo.json` plus script rewrites, a day) and add a
configuration surface we do not yet need. **Revisit** when CI wall-clock on a
single-package change exceeds 5 minutes — that is the trigger, not team preference.

> **Measurement owed.** CI wall-clock per PR must be reported by the Platform Engineer on
> [PER-6](/PER/issues/PER-6) once the pipeline is green, so this trigger is checkable.

### 3. `apps/web`

Next.js App Router, Tailwind, shadcn/ui. This is the agreed stack and is confirmed.

**Consequences we accept.** shadcn/ui is copy-in source, not a dependency, so we own the
accessibility of every component we paste. That is a feature for the WCAG 2.1 AA target —
we can fix a component — and a cost: **every pasted component is reviewed for keyboard and
screen-reader behaviour, and no component may rely on colour alone.** Frontend Engineer owns
this on [PER-19](/PER/issues/PER-19)/[PER-20](/PER/issues/PER-20).

**Licences.** shadcn/ui and Tailwind are MIT. No GPL UI library or piece set enters the repo
unless we open-source — this is checked at review and logged in `THIRD_PARTY_LICENSES.md`.

**Bundle rule.** The "adding a game adds zero bytes to other bundles" target means a game is
**never** statically imported by the platform. Game modules load through a generated
registry that uses dynamic `import()`. See ADR-0002 §3 for the enforced form of this rule.

### 4. `apps/realtime` — server framework

This is the decision the board asked to be confirmed or amended. The proposal on the table
was Colyseus for both kinds of game. **I am recommending we amend it.**

#### 4.1 Decision for M1–M5 (turn-based, the milestones we are actually building)

`apps/realtime` is a **thin Node service that hosts our own room runner**, with:

- `ws` as the WebSocket server, behind a **transport adapter** in `packages/netcode` so
  WebTransport or WebRTC data channels can be added later without touching game or platform
  code.
- A **`Codec` interface** in `packages/netcode` from day one. v1 ships a JSON codec; the
  interface exists so a binary codec is a swap, not a migration. **No message type may be
  defined in a way that assumes JSON** — no bare `any`, no unbounded string maps, every
  message versioned.
- The room runner, seat model, timer service and match log in `packages/platform-core`,
  driving games purely through the `packages/game-sdk` contract.

#### 4.2 Why not Colyseus as the platform framework

Colyseus is a good product and solves real problems — rooms, matchmaking, delta-encoded
binary state sync, multi-process allocation. It lost on four of our lenses:

- **Redaction completeness.** Our contract requires that *every byte* leaving the server
  passes through `getViewFor` / `getSnapshotFor`. Colyseus's model is "mutate `this.state`,
  the framework diffs it and broadcasts," with per-client hiding bolted on via `@filter()`
  decorators. That inverts the default: a new field is **visible unless someone remembers to
  filter it**. For a platform whose first game is Chess and whose second has hidden-position
  mechanics, a hidden-information leak is a correctness bug. I will not accept a framework
  whose safe path is opt-in.
- **Plugin boundary.** Colyseus state sync wants game state expressed as
  `@colyseus/schema` classes. That pushes a framework type hierarchy into every game module
  and makes the SDK contract Colyseus-shaped. A game would then depend on the platform's
  choice of netcode framework — exactly the coupling the one rule forbids.
- **Determinism.** Our games must be pure: no I/O, no `Date.now()`, no `Math.random()`, all
  time and randomness via `ctx.now` / `ctx.rng` with the seed stored on the match. Colyseus
  rooms are stateful objects with their own `this.clock` and lifecycle. Achievable, but we
  would be fighting the framework's grain to get replays and reproducible tests.
- **Reversibility.** Adopting Colyseus as *the* server framework is an **expensive** choice
  to undo — it owns the room lifecycle, matchmaking and the wire protocol. Writing a room
  runner for turn-based games against our own SDK contract is **moderate** at worst, and it
  is work the roadmap already assigns us in `packages/platform-core` and `packages/netcode`.
  The mandated package layout already implies the platform owns the room runner; adopting
  Colyseus would leave those two packages as thin wrappers or dead weight.

#### 4.3 Where Colyseus stays a live candidate

Not adopting it now is not rejecting it. Colyseus remains a **first-class candidate for the
M6 real-time game-server fleet**, evaluated against a hand-rolled runner in the M4 real-time
spike ([PER-30](/PER/issues/PER-30)) and decided in the real-time ADR
([PER-21](/PER/issues/PER-21)). The transport adapter and `Codec` seam in §4.1 are precisely
what keep that option open: a real-time fleet can run a different engine from the
turn-based service without the lobby, seats, invites or results knowing.

#### 4.4 What the board must decide — **board-gated**

Colyseus was named in the agreed stack. Dropping it from M1–M5 is a **change to a major tech
choice**, which I may not make unilaterally. Recorded here as a recommendation and escalated
on [PER-2](/PER/issues/PER-2).

The recommendation, stated as the board's actual choice:

| Option                                           | Cost to reverse | Risk carried                                                                                   |
| ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------- |
| **A. Our room runner now** *(recommended)*       | Moderate        | We write and test a room runner. Real-time engine choice deferred to M4/M6 with better data.    |
| B. Colyseus now for turn-based too               | Expensive       | Opt-in redaction, framework types in games, determinism friction. Saves room-runner work in M1. |
| C. Colyseus for real-time only, ours for turn    | Moderate        | Effectively A plus a pre-commitment to Colyseus for M6 made before the M4 spike has any data.   |

> **Measurement owed.** Option A's cost is real work, and I am not going to claim a number I
> have not measured. The honest figure is: the room runner, match log and timer service are
> already scoped as [PER-14](/PER/issues/PER-14), [PER-15](/PER/issues/PER-15) and
> [PER-17](/PER/issues/PER-17) regardless of this choice, because a lobby that is not tied to
> one kind of game needs them either way. What Option B would save is the transport and
> broadcast layer inside [PER-15](/PER/issues/PER-15), not those issues entirely.

**Until the board answers, M1 work proceeds on the parts that are identical under all three
options**: the SDK contract, guest identity, rooms/codes/registry, seats, and the timer
service. None of those change based on this answer. Only
[PER-15](/PER/issues/PER-15)'s transport layer waits.

### 5. Postgres access layer: Drizzle

**Decision: Drizzle ORM + drizzle-kit.**

**Alternatives.**

- **Prisma** — better ergonomics for deep relational reads and a nicer schema DSL. It lost on
  three specific consequences, not on taste: (a) it ships a platform-specific query-engine
  binary, which is a poor fit for per-PR preview deploys where image size and cold start are
  the cost we pay most often; (b) migrations are generated artefacts that are harder to read
  in a diff, and **destructive migrations are board-gated for us** — a reviewer must be able
  to see `DROP COLUMN` in a pull request without decoding a generated file; (c) the generated
  client is a larger runtime surface against the < 250 KB bundle budget if it is ever reached
  from a bundled context.
- **Kysely** — a genuinely close call, and better than Drizzle at complex typed SQL. It lost
  on migration tooling: drizzle-kit gives us schema-diff-to-SQL out of the box, and we would
  otherwise hand-roll that.
- **Raw `pg` + SQL files** — most transparent, no abstraction risk. Lost on the > 80%
  coverage requirement for `platform-core`: hand-written row mapping is exactly the code that
  rots untested.

**Consequence we accept.** Drizzle's query builder is closer to SQL, so relational reads are
more verbose than Prisma's. That is the trade we are making for readable migrations.

**Division of responsibility (blast radius).** Postgres is the **record of truth for
completed matches** — match logs, results, exported records. It is not in the hot path of a
turn. A Postgres outage must degrade us to "new matches cannot start and results are queued,"
never to "a live match shows a wrong state."

**Revisit** if a single endpoint needs a relational read deep enough that Drizzle costs us
more than 50 lines over Kysely — that is a reason to add Kysely alongside, not to switch ORM.

### 6. Redis usage

`ioredis`, for exactly five jobs:

1. **Room registry** — the 6-character code → room mapping, with a TTL so abandoned lobbies
   expire without a sweeper.
2. **Live room state** between Postgres snapshots.
3. **Presence** — who is connected to which room.
4. **Pub/sub** — cross-instance fan-out, so horizontal scaling does not need sticky sessions
   for correctness (only for efficiency).
5. **Locks** — one writer per room, so two instances cannot both apply an action.

**Codes are global, not per-game** — a 6-character code must resolve to a room without the
player choosing a game first. This is a platform concern, and no game may see or influence
code allocation.

**Code space, and why a collision is a retry rather than a bug.** Six characters over the
Crockford base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ` — I, L, O and U removed, so
nothing is misread aloud or mistyped from a screenshot) gives 32⁶ = **1,073,741,824** codes.
At 10,000 concurrent live lobbies the chance that a freshly drawn code is already taken is
~1 × 10⁻⁵. Codes are therefore **claimed, not hoped for**: `SET NX` on
`room:code:{code}`, retry up to 5 times, fail loudly after that. TTL expiry returns codes to
the pool, which is what keeps the occupancy low enough for that number to hold.

**A lobby code is a capability, not an identifier.** Anyone holding it can join the room.
It must never reach a third party — see §8.

**Timers are not TTLs.** Redis key expiry and keyspace notifications are best-effort and do
not survive a failover cleanly. A chess clock is a server-authoritative correctness surface,
so the timer service ([PER-17](/PER/issues/PER-17)) uses a sorted set scored by `dueAt`,
polled and atomically claimed by the instance holding the room lock. **In this system TTLs
garbage-collect; they never fire a correctness-bearing event.** Writing this down here
because the opposite pattern is the obvious one to reach for and it fails silently.

**Capacity, at the 2,000-rooms-per-instance target** (estimate, to be confirmed by QA under
load in M3):

```
actions    2,000 rooms × 1 move / 5 s                  ≈   400 ops/s
presence   2,000 rooms × 2 seats / 10 s heartbeat      ≈   400 ops/s
fan-out    400 publishes/s × ~2.5 subscribers          ≈ 1,000 deliveries/s
                                                        ─────────────────
                                                        ≈ 1,800 ops/s
```

A single Redis instance sustains 50k–100k ops/s on commodity hardware, so this is ~2–4% of
one instance. **Redis is not the scaling constraint for turn-based.** That is a headroom
claim, not an optimisation claim, and it is stated so a future performance argument has a
baseline to argue against.

**Configuration is load-bearing, not incidental.** `docker-compose.yml` sets
`--maxmemory-policy noeviction` and `--appendonly yes`. Live room state is authoritative in
Redis between snapshots, so a silently evicted key is a lost match. **Staging and production
Redis must be configured the same way**, and a managed Redis tier that does not permit
`noeviction` is disqualified — this is a hard constraint on the hosting decision, and the
reason it is written here rather than left to an ops ticket.

**Restart survival (the actual mechanism).** Turn-based rooms survive a server restart
because every applied action is appended to a match log and state is snapshotted; recovery
replays the log from the last snapshot. Because game modules are deterministic — same seed
plus same inputs reproduce the same outcome — replay is exact. **Determinism is not a
stylistic rule; it is the thing that buys us restart survival, replays and reproducible
tests.** `packages/platform-core` owns this ([PER-15](/PER/issues/PER-15),
[PER-29](/PER/issues/PER-29)).

**Blast radius, stated rather than hidden.**

- *An app instance dies mid-match.* The room lock expires, another instance rehydrates from
  the last snapshot plus the match log, and play resumes at the correct state. During that
  window the player sees "reconnecting" — never a stale board presented as live. Showing a
  correct state late beats showing a wrong state now.
- *Redis dies hard.* With `appendonly yes` and the default `appendfsync everysec`, an
  in-flight match can lose **up to 1 second** of applied actions. We are accepting that for
  v1 and writing it down. Completed matches are already in Postgres and are unaffected. If
  it proves unacceptable, the mitigations are `appendfsync always` (paid for in write
  latency) or a replica with `WAIT` — both are changes to this line, not to the design.

**Alternative considered.** Postgres `LISTEN/NOTIFY` plus tables instead of Redis, dropping a
dependency. It lost on TTLs and presence: expiring lobbies and connection presence in
Postgres means a sweeper job and write amplification on the hot path.

### 7. Validation and the wire

`zod` for **every** JSON message and every HTTP input, on the server, at the boundary — not
as a type-level convenience. A client is never trusted: the server is the single source of
truth for every action, position, timer and result.

The real-time path is **explicitly not JSON**. The 30 KB/s down per client budget rules it
out, and a JSON-only real-time protocol is on the never-ship list.

The arithmetic, because "JSON is too big" is an assertion and a budget is a number:

```
30,000 bytes/s ÷ 30 ticks/s = 1,000 bytes per snapshot per client   (hard ceiling)

JSON, 12 entities × ~130–250 B of keys, quoted floats, punctuation  ≈ 1.5–3.0 KB  ✗ 1.5–3× over
Binary, 12 entities × 9 B (1 B id, 3 × 2 B quantised pos, 1 B yaw,
        1 B state flags) + header                                   ≈ 110 B       ✓ ~11% of ceiling
```

JSON misses the ceiling before a single delta baseline, ack or event payload is added.
Binary leaves ~89% of the budget for them. This is the whole justification for the `Codec`
seam, and it is why the seam is not optional or deferrable.

v1 ships a JSON codec for the turn-based path only; the `Codec` seam (§4.1) is how a binary
codec arrives without a protocol migration. Candidate binary formats to be evaluated in
[PER-21](/PER/issues/PER-21): msgpackr, FlatBuffers, `@colyseus/schema`, and a hand-rolled
`DataView` encoder.

**Version pinning.** A match in progress stays on the game module version it started on. A
deploy must never break a live game. The match record stores the module version and the
seed; `migrateState` exists for the case where we must move a live match forward. This
constrains deploys (old module versions stay loadable for the lifetime of a match) and is
the reason game modules are versioned artefacts rather than "whatever is on main."

### 8. Observability

- **Sentry** on web and server, with release tagging and source maps. Free tier for M0.
- **Structured JSON logging** via `pino`, with a **correlation id that includes the room id**,
  so one room's whole life can be filtered out of the log stream. Owner: Platform Engineer on
  [PER-7](/PER/issues/PER-7).
- **Uptime monitor** against the `/health` endpoints on both apps.
- **PostHog** for product funnel analytics (landing → lobby → first move), which is how we
  will know whether "2 taps and < 10 s" is actually true.

Three rules bind the implementer on [PER-7](/PER/issues/PER-7), because the default
behaviour of all three tools is wrong for us:

- **Scrub the capability.** A lobby code is a join capability (§6). A Sentry `beforeSend`
  hook and the PostHog property sanitiser must strip lobby codes, invite URLs and raw
  connection ids from events, breadcrumbs and URLs. Shipping a lobby code to a third-party
  analytics vendor is a security bug, not a privacy preference, and
  [PER-7](/PER/issues/PER-7) should carry a unit test that asserts it.
- **Analytics is never on the critical render path.** Sentry browser (~25–30 KB gz for the
  minimal bundle; no Replay, no Profiling in v1) and PostHog (~35–50 KB gz) are
  **lazy-loaded after first interaction**. These are published-size estimates that
  [PER-7](/PER/issues/PER-7) must confirm against the real bundle analyser, because the
  landing LCP budget is < 2 s on a mid-range Android over 4G. Observability must not be the
  reason we miss the target it exists to measure.
- **Sample the hot path.** Per-action logs at 2,000 rooms would dominate CPU. Log every room
  lifecycle event, sample per-action logs, never log a snapshot payload.

**SLIs instrumented from day one**, because these are the numbers we are held to and a
performance claim without one of them is not evidence: action round-trip p95, rooms per
instance, Redis op latency p99, reconnect success rate, and — from M6 — tick duration p99.

**Board-gated.** Sentry, PostHog and the uptime monitor all have free tiers sufficient for
M0. **Any paid tier, and the hosting provider itself, needs board approval** and is not
signed up for by an engineer. Recorded on [PER-2](/PER/issues/PER-2). All three sit behind
one thin telemetry facade in `packages/shared`, so no call site names a vendor and replacing
one is a single-package change.

### 9. Testing

- **Vitest** for unit and the conformance testkit. Beat Jest on ESM handling — our whole
  repo is `"type": "module"` — and on watch-mode speed.
- **Playwright** for E2E. Beat Cypress on one concrete requirement: a two-player test needs
  two independent browser contexts in one test, which `browser.newContext()` gives directly.
  Playwright also covers the required matrix (Chromium, WebKit, Firefox) from one runner.
- **Coverage gate ≥ 80%** on `game-sdk`, `platform-core`, `netcode` and every game's rules
  code, enforced in CI, not aspirational.
- `packages/game-testkit` is a **conformance suite**: any game claiming to implement the SDK
  must pass it. This is how "games are plugins" stays true as games are added — tic-tac-toe
  ([PER-18](/PER/issues/PER-18)) and Chess ([PER-22](/PER/issues/PER-22)) are both just
  customers of it.

### 10. Brand is a constant, never a literal

The product name, domain and logo are board decisions and are **still open**. No brand string
is hard-coded anywhere. `packages/shared/src/brand.ts` is the single source of truth, exposing
`BRAND.name`, `BRAND.domain` and `BRAND.isProvisional`, defaulting to the internal codename
and overridable by environment. `isProvisional` exists so the UI can be checked for places
that must not ship a codename. Escalated on [PER-2](/PER/issues/PER-2).

---

## Consequences

**Easier**

- The turn-based and real-time paths can use different engines without the lobby, seats,
  invites, chat or results knowing — because both sit behind the SDK contract and the
  transport adapter.
- Migrations, redaction and the wire format are all reviewable in a diff.
- A game is a folder. Adding one touches no other bundle and no platform file.

**Harder**

- We write and test our own room runner instead of adopting one. This is real work and the
  main cost of the §4 recommendation.
- Drizzle makes deep relational reads more verbose than Prisma would.
- Every shadcn/ui component we paste is ours to make accessible.

**Committed to**

- Deterministic game modules. No `Date.now()`, no `Math.random()`, no I/O — mechanically
  enforced (ADR-0002 §4).
- `getViewFor` / `getSnapshotFor` as the only path to a client.
- Redis configured `noeviction` in every environment, including managed tiers.
- Old game-module versions remaining loadable for the lifetime of a match.

**Cost to reverse**

| Decision                  | Cost      |
| ------------------------- | --------- |
| Task runner (§2)          | Cheap     |
| Codec / transport (§4.1)  | Cheap — that is the point of the seam |
| ORM (§5)                  | Moderate  |
| Room runner vs Colyseus   | Moderate now, **expensive** after M2 once games depend on the contract shape |
| Redis as live state store | Expensive |

## Revisit triggers

- A measured 30 Hz tick on Node misses < 5 ms p99 for a 12-player room by more than 2× → §1.
- CI wall-clock for a single-package change exceeds 5 minutes → §2 (add Turborepo).
- The M4 real-time spike shows a hand-rolled runner cannot hit the netcode budgets while
  Colyseus can → §4, reopen for the M6 fleet.
- A managed Redis tier we want cannot be set to `noeviction` → §6, and the live-state design
  changes, not the Redis config.
- Any turn-based p95 round-trip above 150 ms in-region traced to the JSON codec → §7, bring
  the binary codec forward.

## Open questions escalated to the board on [PER-2](/PER/issues/PER-2)

1. **§4.4** — amend the agreed stack to drop Colyseus from M1–M5 and keep it as an M6
   candidate? (Recommendation: Option A.)
2. Hosting provider and monthly infrastructure budget, with cost per 1,000 concurrent
   players. Blocks preview deploys, the staging WebSocket round trip, and Sentry-from-staging
   — that is epic acceptance criteria 1, 2 and 5 on [PER-3](/PER/issues/PER-3).
3. Code repository — which repo the team pushes to.
   ([PER-35](/PER/issues/PER-35)). Blocks all of CI.
4. Final product name, domain and logo. Not blocking; `BRAND.isProvisional` covers the gap.

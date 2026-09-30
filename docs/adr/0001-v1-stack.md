# ADR-0001: The v1 stack

- **Status:** Accepted, **except §4.4 (real-time server framework) which is Board-gated**
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (rev 2) — board resolved the budget, the data-store tier, the
  repository and the product name. See [Board decisions](#board-decisions-applied-rev-2).
  **§6 changed materially**: Redis is no longer the durability tier.
- **Amended:** 2026-09-30 (rev 3) — §10 only. Rev 2's brand text contradicted the committed
  `brand.ts` and left a fail-open default that could ship the codename to a player. Resolved in
  §10. The repository decision's knock-on effect on the PR gate is
  [ADR-0004](./0004-pr-gate-without-branch-protection.md).
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-8](/PER/issues/PER-8) (epic [PER-3](/PER/issues/PER-3))

## Context

We are building a browser-based multiplayer game platform (Playhall) where
**games are plugins**. Two unlike kinds of game — turn-based (Chess) and real-time 3D
(Prop Hunt, 4–12 players, 30 Hz) — must share one lobby, one invite flow, one seat model and
one result model. Most players arrive by tapping a link on a phone over mobile data.

The stack choices below are constrained by non-functional targets we are held to:

| Target                                                 | Constrains                               |
| ------------------------------------------------------ | ---------------------------------------- |
| Turn-based action round-trip < 150 ms p95 in-region    | transport, persistence, hosting region   |
| 30 Hz tick, < 5 ms p99 per tick for a 12-player room   | server framework, GC pressure, codec     |
| < 30 KB/s down per client in real-time                 | wire format — rules out JSON-only        |
| Landing LCP < 2 s on mid-range Android over 4G         | web framework, bundle budget             |
| Turn-based game bundle < 250 KB gzipped (excl. assets) | ORM/client library footprint             |
| Adding a game adds **zero** bytes to other bundles     | dynamic imports, no static game registry |
| 2,000 concurrent turn-based rooms on one instance      | per-room memory, room runner design      |
| Turn-based games survive a server restart              | Redis + Postgres match log               |
| WCAG 2.1 AA on platform UI                             | component library                        |

Three of these ten are the load-bearing ones for this ADR: the **< 30 KB/s** real-time
budget, the **zero bytes to other bundles** rule, and **restart survival**.

There is an eleventh constraint, added in rev 2 and binding on every section below:

| Target                                | Constrains                                      |
| ------------------------------------- | ----------------------------------------------- |
| **Monthly infrastructure budget: $0** | every managed service, every tier, every vendor |

The board set the infrastructure budget at **$0** (§11). That is not a footnote — it moved
one decision in this ADR (§6) and it bounds what M5 can prove (§11.2).

Two decisions are deliberately **not** in this ADR:

- **Hosting provider** — board-gated, needs cost per 1,000 concurrent players. A later ADR
  ([PER-38](/PER/issues/PER-38)), now further bounded by the $0 budget.
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
want once CI runtime becomes the bottleneck. Both lost _for now_ on **reversibility**: they
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

- **Redaction completeness.** Our contract requires that _every byte_ leaving the server
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
- **Reversibility.** Adopting Colyseus as _the_ server framework is an **expensive** choice
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

| Option                                        | Cost to reverse | Risk carried                                                                                    |
| --------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| **A. Our room runner now** _(recommended)_    | Moderate        | We write and test a room runner. Real-time engine choice deferred to M4/M6 with better data.    |
| B. Colyseus now for turn-based too            | Expensive       | Opt-in redaction, framework types in games, determinism friction. Saves room-runner work in M1. |
| C. Colyseus for real-time only, ours for turn | Moderate        | Effectively A plus a pre-commitment to Colyseus for M6 made before the M4 spike has any data.   |

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
2. **Live room state** — a **cache** in front of the Postgres match log, not the tier of
   record. See §6.1, amended in rev 2.
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

#### 6.1 Redis is the hot tier. Postgres is the tier of record. (Amended, rev 2)

**Rev 1 said** live room state was authoritative in Redis between Postgres snapshots, that
`noeviction` + `appendonly yes` were mandatory in every environment, and that a managed
Redis tier which would not permit `noeviction` was **disqualified** — a hard constraint on
the hosting decision.

**The board set the budget to $0** and instructed us to assume **no persistence guarantees
and cold-start latency** on whatever free tier we land on. A free-tier Redis that may evict,
may not fsync, and may cold-start is not disqualifiable — it is the only thing on the menu.
So the constraint has to move off the vendor and into the design, and rev 1's position is
withdrawn.

**Amended rule: Redis must be safe to lose at any instant.**

- The **Postgres match log is the sole tier of record.** Every applied action is appended
  there, and a room is fully reconstructible from `(seed, module version, ordered action
log, last snapshot)` with no Redis key surviving.
- **Redis holds only derived or cheap-to-lose data**: current state cache, presence, pub/sub,
  locks, and the code → room mapping. Losing the whole keyspace costs a rehydrate and a
  reconnect, never a match.
- **The code → room mapping is the one exception that needs care.** It is cheap to lose only
  because the room row in Postgres also carries its code, so the mapping is rebuildable; a
  code lookup that misses in Redis falls through to Postgres and repopulates. It is _not_
  regenerated with a new code, because a shared link must keep working.
- `noeviction` and `appendonly yes` stay in `docker-compose.yml` and stay **recommended**
  wherever they are available, because they turn a routine event into a non-event. They are
  no longer a **hard constraint on the hosting decision**, and [PER-38](/PER/issues/PER-38)
  is no longer bounded by them.

This is a strictly stronger correctness position than rev 1 — it removes a whole class of
"Redis lied to us" failure — and the board's $0 constraint is what forced us to take it. The
cost is paid in §6.2.

#### 6.2 What that costs, in milliseconds

Moving the durability point from Redis to Postgres puts a durable write on the hot path,
which spends part of the **< 150 ms p95** turn-based round-trip budget:

```
client → server, 4G in-region                        40–80 ms   (dominant, not ours to fix)
validateAction + applyAction (pure, in-memory)           < 1 ms
append action to Postgres match log (1 row, indexed)    1–5 ms   ← the new cost
Redis state write + PUBLISH                             ~1 ms
getViewFor + encode + send                               < 1 ms
```

A single-row insert into an append-only table is the cheapest durable write there is, and at
1–5 ms it is **~2–3% of the budget** against a network term of 40–80 ms. Budgeted at **≤ 10 ms
p95** for [PER-15](/PER/issues/PER-15) / [PER-29](/PER/issues/PER-29).

**Measurement owed.** Every number in that table is a budget, not a measurement. QA owns the
measured version in M3/M5.

**The fallback, stated now so it is not invented under pressure.** If the measured log write
exceeds 10 ms p95, the fix is group commit (`synchronous_commit = off` plus a batched flush),
which trades a bounded window of committed-but-unflushed actions for latency. **That is a
durability trade, so it is a board-visible decision, not an engineer's tuning knob.** Nobody
turns it on in a PR.

**The rule that binds the implementer:** an action ack may never claim more durability than
we actually have. The server acks after the log append, not before it.

#### 6.3 Cold start, and the one target free-tier infra cannot prove

Free tiers suspend on idle. A cold resume on serverless Postgres or Redis is commonly
hundreds of milliseconds to several seconds — one to two orders of magnitude over the entire
150 ms budget.

- **Mitigation that costs nothing:** the uptime monitor we already have (§8) doubles as a
  keep-warm ping against `/health`, which touches both stores. Free, and it is the same
  check we wanted anyway. Owner: [PER-7](/PER/issues/PER-7).
- **Mitigation that is not available:** paying for a provisioned tier. Ruled out at $0.
- **The honest limit, escalated rather than worked around:** the **< 150 ms p95 turn-based
  round trip is not measurable on free-tier staging.** A cold-start outlier lands in the p95
  and the number measures the vendor's idle policy, not our code. It must be measured
  locally, or against provisioned infrastructure in a time-boxed window. This joins the M5
  load-test exception the board has already accepted (§11.2) and is flagged on
  [PER-2](/PER/issues/PER-2) rather than quietly redefined.

**Restart survival (the actual mechanism).** Turn-based rooms survive a server restart
because every applied action is appended to the match log and state is snapshotted; recovery
replays the log from the last snapshot. Because game modules are deterministic — same seed
plus same inputs reproduce the same outcome — replay is exact. **Determinism is not a
stylistic rule; it is the thing that buys us restart survival, replays and reproducible
tests.** Per §6.1 this path now depends on Postgres alone, which is exactly what makes it
survive a free-tier Redis that drops its keyspace. `packages/platform-core` owns this
([PER-15](/PER/issues/PER-15), [PER-29](/PER/issues/PER-29)).

**Blast radius, stated rather than hidden** (rev 2 — the Redis row changed):

- _An app instance dies mid-match._ The room lock expires, another instance rehydrates from
  the last snapshot plus the match log, and play resumes at the correct state. During that
  window the player sees "reconnecting" — never a stale board presented as live. Showing a
  correct state late beats showing a wrong state now.
- _Redis dies hard, or a free tier drops the whole keyspace._ **Nothing is lost.** Rooms
  rehydrate from the Postgres match log, players see "reconnecting", and play resumes at the
  correct state.
  > **Rev 1 said** that with `appendfsync everysec` an in-flight match could lose **up to 1
  > second** of applied actions, and accepted that. **Rev 2 removes the exposure rather than
  > accepting it** (§6.1). The rev 1 mitigations — `appendfsync always`, or a replica with
  > `WAIT` — are moot, and one of them (a replica) was not free anyway. This is the one place
  > where the board's $0 constraint made the design strictly more correct.
- _Postgres dies._ In-flight matches stop. This is the failure we cannot design around, and
  it is the reason the durability point sits there and nowhere else. On a free tier with no
  persistence guarantee this is a real risk, not a theoretical one — so it is named here and
  is what [PER-38](/PER/issues/PER-38) has to price.

**Alternative considered.** Postgres `LISTEN/NOTIFY` plus tables instead of Redis, dropping a
dependency. It lost on TTLs and presence: expiring lobbies and connection presence in
Postgres means a sweeper job and write amplification on the hot path. **Rev 2 note:** this
alternative got closer, since Postgres is now the tier of record anyway. It still loses on
the same two jobs, and dropping Redis would put presence heartbeats — the highest-frequency
write in the system — onto the store we now depend on for match durability. Keeping the
volatile, high-frequency traffic off the durable store is the point.

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

**Board-decided, rev 2: free tiers only, and this is now a standing constraint.** The board
set the monthly infrastructure budget at **$0** and denied paid tiers for Sentry, PostHog and
the uptime monitor. Binding on every engineer:

- **No signup for any service requiring a card, a paid tier, or a trial that auto-converts.**
  Same rule for hosting, CDN, DNS and managed data stores.
- The telemetry facade in `packages/shared` is **load-bearing, not a nicety.** It is the
  reason a vendor swap — which a free-tier limit may force on us with little notice — is a
  single-package change and not a repo-wide one. No call site names a vendor. A PR that
  imports `@sentry/*` or `posthog-js` outside that facade is rejected on **plugin boundary**,
  and [PER-5](/PER/issues/PER-5) should add it as a forbidden-import rule under ADR-0002 so
  the rule is mechanical rather than remembered at review time.
- **If a free-tier limit would make a milestone's acceptance criteria unachievable, stop and
  escalate** to Chief of Staff on [PER-2](/PER/issues/PER-2) for a costed exception. Do not
  work around it, and do not quietly redefine the criterion. Two such limits are already
  recorded in §11.2, and §6.3 adds a third.

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

The product name, domain and logo are board decisions. No brand string is hard-coded
anywhere. `packages/shared/src/brand.ts` is the single source of truth, exposing `BRAND.name`,
`BRAND.domain` and `BRAND.isProvisional`, defaulting to the internal codename and overridable
by environment. `isProvisional` exists so the UI can be checked for places that must not ship
a codename.

**Rev 2 — the name is decided: the board picked Playhall.** Recording it in a decision record
is not hard-coding it; the mechanism is unchanged and is the whole point. Specifically:

- The **only** place that string may enter the codebase is `BRAND.name`, set on the brand and
  domain issue Chief of Staff owns — **not here, and not in this ADR's own repo changes.**
- Nothing in M0–M4 may hard-code it. A literal `"Playhall"` anywhere but `brand.ts` is a
  review rejection, and that now has teeth it did not have while the name was unknown: a
  wrong codename is obvious in a diff, a correct product name is not.
- **Domain and logo remain open.** `BRAND.domain` keeps its provisional value and
  `isProvisional` stays `true` until they are decided, because a name alone is not enough to
  ship share previews (product principle 4) — those need a real domain.

**Rev 3 — rev 2 does not match the code, and the mismatch is a fail-open default.** Rev 2 asserts
`isProvisional` stays `true` until domain and logo land. The committed implementation computes
`isProvisional: name === INTERNAL_CODENAME`, so the moment anyone sets the name to `Playhall`
it flips to `false` and rev 2's guarantee silently evaporates. Rev 2 also keeps the codename as
the _default_, which means an environment with `NEXT_PUBLIC_BRAND_NAME` unset ships **"Atrium"
to a player**. Both are resolved here rather than left for whoever hits them first:

- **The default becomes the approved name.** `brand.ts` holds `Playhall` as the fallback, with
  the env var retained as an override for environment labelling. Rev 2's "the string may not
  enter `brand.ts`" is withdrawn: it is self-defeating. `brand.ts` is the file this section
  designates as the single source of truth, so pushing the value out into per-environment env
  vars replaces **one** reviewable, diffable place with **four** (local, preview, staging,
  production), each able to be missing. Missing configuration must degrade to the correct name,
  not to a codename. The no-literals rule is unchanged and still has teeth — it forbids the
  string _anywhere but_ `brand.ts`, which is the rule as originally written.
- **`isProvisional` is derived from what is actually unsettled.** It becomes
  `name !== APPROVED_NAME || domain === ''`, so it stays `true` while the domain is open — which
  is what rev 2 meant — and also catches a reverted or mis-set name override, which is what the
  original text meant. One expression, both jobs.
- **`INTERNAL_CODENAME` stops being a fallback** and survives only as the value the guard
  compares against.

Logo is deliberately excluded from `isProvisional`: it is an asset, not a string, and gating a
boolean on a missing file conflates two different checks. It stays tracked on
[PER-2](/PER/issues/PER-2) and in `ASSET_LICENSES.md`.

The code change is small and belongs to whoever next touches `packages/shared` — assigned in the
epic thread on [PER-3](/PER/issues/PER-3), not taken here, because this ADR does not carry code.

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
- **Redis being safe to lose at any instant; Postgres as the sole tier of record** (§6.1,
  amended rev 2 — this replaces rev 1's "Redis configured `noeviction` in every environment").
- A durable log append on the action hot path, budgeted at ≤ 10 ms p95 (§6.2).
- No vendor named outside the `packages/shared` telemetry facade (§8).
- Old game-module versions remaining loadable for the lifetime of a match.

**Cost to reverse**

| Decision                   | Cost                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task runner (§2)           | Cheap                                                                                                                                                                      |
| Codec / transport (§4.1)   | Cheap — that is the point of the seam                                                                                                                                      |
| ORM (§5)                   | Moderate                                                                                                                                                                   |
| Room runner vs Colyseus    | Moderate now, **expensive** after M2 once games depend on the contract shape                                                                                               |
| Redis as cache only (§6.1) | **Cheap — and cheaper than rev 1's design, which is the point.** Making Redis losable means adding, removing or swapping it is a config change, not a correctness argument |
| Postgres as tier of record | Expensive — this is now the load-bearing durability choice                                                                                                                 |

## Revisit triggers

- A measured 30 Hz tick on Node misses < 5 ms p99 for a 12-player room by more than 2× → §1.
- CI wall-clock for a single-package change exceeds 5 minutes → §2 (add Turborepo).
- The M4 real-time spike shows a hand-rolled runner cannot hit the netcode budgets while
  Colyseus can → §4, reopen for the M6 fleet.
- ~~A managed Redis tier we want cannot be set to `noeviction`~~ → **retired in rev 2.** The
  design no longer depends on it, so this can no longer trigger anything (§6.1).
- The measured match-log append exceeds 10 ms p95 → §6.2, and the group-commit fallback goes
  to the board as a durability decision.
- The infrastructure budget rises above $0 → §6.3 and §11 reopen: provisioned tiers make the
  150 ms p95 measurable on staging, and `noeviction` becomes available again as belt-and-braces.
- Any turn-based p95 round-trip above 150 ms in-region traced to the JSON codec → §7, bring
  the binary codec forward.

---

## 11. Board decisions applied (rev 2) {#board-decisions-applied-rev-2}

Rev 1 escalated four items to the board on [PER-2](/PER/issues/PER-2). Three are resolved.

| #   | Item                                                      | Outcome                                                                                                               | Effect on this ADR                                                                         |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **§4.4** — drop Colyseus from M1–M5, keep as M6 candidate | **Still open** — approval [15587c20](/PER/approvals/15587c20-53fb-499e-9b53-4718df50a5df), endorsed by Chief of Staff | §4.4 stays `Board-gated`. Not blocking; see §11.1                                          |
| 2   | Paid tiers for Sentry / PostHog / uptime                  | **Denied. Budget $0, free tiers only**                                                                                | §8 rewritten as a standing constraint                                                      |
| 3   | Managed Redis + Postgres                                  | **Free tiers or Docker; costed proposal at M4. Assume no persistence guarantees and cold-start latency**              | **§6 materially amended** — §6.1, §6.2, §6.3                                               |
| 4   | Code repository                                           | **Resolved** — private repo `neerajkrbansal1996/gameroom` ([PER-35](/PER/issues/PER-35) closed)                       | This ADR lands there; unblocks [PER-36](/PER/issues/PER-36) and [PER-6](/PER/issues/PER-6) |
| +   | Final product name                                        | **Decided: Playhall.** Domain and logo still open                                                                     | §10 amended; the string lives only in `BRAND.name`                                         |

Hosting provider remains open and is deliberately still out of scope here — it is
[PER-38](/PER/issues/PER-38), and it needs cost per 1,000 concurrent players. The $0 budget
narrows it rather than deciding it.

### 11.1 Why §4.4 staying open blocks nothing

Identical under all three options on the approval: the SDK contract, guest identity,
rooms/codes/registry, seats, and the timer service. Only [PER-15](/PER/issues/PER-15)'s
transport layer depends on the answer, and no real-time implementation work starts before the
board opens M6 — [PER-21](/PER/issues/PER-21) stays design-only.

### 11.2 Consequences the board has accepted by choosing $0

Recorded here so they arrive as priced decisions rather than ambushing a milestone. The first
two are Chief of Staff's, already accepted; the third is new in this revision and is raised on
[PER-2](/PER/issues/PER-2).

1. **M5 load test** — 2,000 concurrent rooms at p95 < 150 ms is not reachable on free-tier
   infrastructure. Either capacity is bought for a one-off test window, or the target is
   scaled down. Priced before M5 opens. Owner: Chief of Staff.
2. **M6 Mumbai-region game-server fleet** — ruled out at $0. M6 is a board gate anyway; cost
   per 1,000 concurrent players stays in the M1 real-time ADR
   ([PER-21](/PER/issues/PER-21)) because it is exactly what that decision needs.
3. **The < 150 ms p95 turn-based round trip is not measurable on free-tier staging** (§6.3).
   Cold-start outliers land in the p95 and measure the vendor's idle policy, not our code.
   The number must come from local or provisioned infrastructure. **New in rev 2**, and
   raised rather than worked around, per the board's own standing instruction.

What this does **not** change: M3 resilience. Reconnection and restart recovery were already
designed to depend on the Postgres match log and deterministic replay, and §6.1 makes that
dependency exclusive. **M3 requires no paid-tier feature** — which is the answer to the
board's instruction on that point, and it is true because of the §6 amendment, not in spite
of it.

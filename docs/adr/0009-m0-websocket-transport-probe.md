# ADR-0009: Evidence M0's WebSocket criterion with a transport probe, not with the protocol

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (**rev 1.1**, before this ADR first landed on `main`) — rev 1 specified
  the probe as a bare `ws` server on the grounds that `ws` is "already the agreed server in
  ADR-0001 §4.1". **That was stale when written.** [ADR-0001](./0001-v1-stack.md) **rev 4** records
  the board's rejection of the §4.4 amendment, so **Colyseus is the server framework for
  turn-based and real-time both, and `apps/realtime` is a Colyseus server** (§4.2). A probe that
  stands up its own independent WebSocket server would evidence an upgrade path we do not ship —
  the same defect this ADR rejects alternative D for. **§2 is rewritten and §2.1 is new.** The
  decision, the AC2a/AC2b split, the alternatives and the revisit triggers stand unchanged.
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-87](/PER/issues/PER-87)

## Context

M0 acceptance criterion 2 reads _"a WebSocket round trip succeeds on staging."_ QA reported on
[PER-87](/PER/issues/PER-87) that this criterion cannot be met in M0 scope, and the report is
correct on every fact:

- `apps/realtime/src/index.ts` on `origin/main` is 42 lines of `node:http`. Two routes —
  `GET /health`, `GET /ready` — and 404 for everything else.
- `apps/realtime/package.json` on `origin/main` declares no `ws` and no `@colyseus/*`.
- A grep for `websocketserver|new WebSocket|@colyseus|from 'ws'|require('ws')` across all 20
  remote branches, scoped to `apps/realtime` and `packages/netcode`, returns **zero hits**.

So AC2 has two independent gates, and only one of them is the provisioning hold the board ruled on:

| Gate | What is missing                                               | Class of blocker                                             |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| 1    | No WebSocket server exists in the product, in any environment | **~60 lines of code.** No spend, no vendor, no open decision |
| 2    | No staging environment exists to deploy it to                 | Money — the same hold as AC1b                                |

The board's 2026-09-30 decision on [PER-2](/PER/issues/PER-2) — that AC2 must be demonstrated, and
that a freshly-woken free-tier service is acceptable evidence — settles gate 2's _terms_. It does
not touch gate 1. Provisioning staging this morning would deploy a health endpoint and AC2 would
still fail.

The decision is therefore not "is AC2 met" (it is not). It is **what AC2 is for**, and that
determines which milestone owns it.

AC2 sits in the foundation milestone beside "a pull request runs full CI", "a deliberate
dependency-boundary violation fails the build", and "`docs/adr/` exists". None of those are product
features. Every one of them proves the _substrate_ works. Read in that company, AC2's job is to
prove a WebSocket upgrade survives the whole path — browser on mobile data, through the provider's
TLS terminator, proxy and load balancer, into our Node process — and that the socket stays open
afterwards. That is an environment question, and it belongs in M0. It is not the question "does the
room runner work", which is M1's and belongs to [PER-12](/PER/issues/PER-12) and
[PER-15](/PER/issues/PER-15).

## Decision

**Split AC2 into two rows, exactly as AC1 was split in ADR-0003 §8.4, and close gate 1 inside M0
with a deliberately minimal transport probe.**

### 1. The criterion becomes two rows

| #        | Criterion                                                                                     | Gate                                                                                     |
| -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **AC2a** | A WebSocket round trip succeeds against the built `apps/realtime` artifact, locally and in CI | Code only. Reachable now, zero spend                                                     |
| **AC2b** | The same round trip succeeds against a deployed staging URL, driven from a second host        | Provisioning — the AC1b gate. Free-tier evidence accepted per [PER-2](/PER/issues/PER-2) |

A single verdict for both would attribute a 60-line omission to the provisioning hold. That is the
same error the AC1 split exists to prevent: it lets a code-shaped problem hide behind a
money-shaped one.

### 2. Gate 1 is closed by a transport probe, and the board is told it is a probe

`apps/realtime` gains one WebSocket route, `/ws/probe`, **served by the same HTTP server and the
same WebSocket transport the shipped product uses** — see §2.1, which is the load-bearing
constraint and supersedes rev 1's "using `ws`". Specification, which is binding on the
implementation ([PER-94](/PER/issues/PER-94)):

- **One frame shape, zod-validated in both directions.** Client sends
  `{ t: "ping", nonce: string, clientSentAtMs: number }`; server replies
  `{ t: "pong", nonce, clientSentAtMs, serverRecvAtMs, serverSentAtMs }`. An unparseable frame is
  answered with `{ t: "error", reason }` and the socket is closed.
- **The client's timestamp is reflected, never consumed.** Echoing `clientSentAtMs` back is what
  lets the caller compute RTT from its own clock. The server does not read it, compare it, or
  derive anything from it. **Server-authoritative**: a modified client can lie in that field and
  change nothing but its own printed number.
- **No fan-out, ever.** One socket receives exactly one reply, to itself. The probe never relays a
  frame to another connection. That is both the abuse surface and the thing that would make it
  resemble a room.
- **Bounded:** max frame size, max concurrent probe sockets, idle timeout, no subprotocol
  negotiation, no auth, no persistence, no state that outlives the socket.
- **Off by default in production.** Enabled by `REALTIME_WS_PROBE=1`, set in dev and staging,
  unset in production. An unauthenticated open socket on prod buys nothing and is a standing
  liability; house rules already require unfinished work behind a flag.
- **Isolated in one file**, `apps/realtime/src/ws-probe.ts`, importing nothing from a game and
  imported by no game. It is diagnostics, exactly like `/health`.

### 2.1 The probe rides the shipped transport — it does not stand up its own (rev 1.1)

[ADR-0001](./0001-v1-stack.md) §4.2 makes `apps/realtime` a **Colyseus** server. So:

- **The probe must not introduce a second WebSocket server.** It attaches to the **same
  `http.Server` instance** that Colyseus's transport is constructed with, and it reuses the `ws`
  dependency **already bundled by `@colyseus/ws-transport`** rather than adding an independent
  one. Two upgrade handlers on two servers is not a smaller change than one — it is a second
  network surface to deploy, probe and secure.
- **Why this is the whole point of AC2a, not a tidiness preference.** AC2a exists to prove that a
  WebSocket upgrade survives the path from a mobile client, through the provider's TLS terminator,
  proxy and load balancer, into **our** process. If the probe's socket is served by a stack we do
  not ship, a green AC2a tells us nothing about the stack we do ship — and staging could still
  break on Colyseus's upgrade path with the probe passing. That is precisely the objection this
  ADR raises against alternative D, applied to ourselves.
- **No new declared runtime dependency.** `ws` is already in the tree transitively under Colyseus.
  If `ws-probe.ts` imports it directly it must be declared in `apps/realtime/package.json` (no
  phantom dependencies) and **pinned to the version Colyseus resolves**, so we never run two
  copies of `ws` in one process.
- **No boundary-rule change.** Colyseus is a platform-internal dependency under ADR-0001 §4.2 and
  `apps/realtime` is the one place it is allowed. The probe lives there, imports nothing from
  `packages/game-sdk` and is imported by no game, so [ADR-0002](./0002-dependency-boundary-enforcement.md)'s
  rule set needs no exception. **If the implementation finds it needs one, that is a signal to
  stop and escalate, not to widen a rule.**

**One question this ADR does not pretend to answer, and PER-94 must settle by measurement rather
than assumption:** whether Colyseus's transport tolerates a sibling raw-`ws` upgrade route on the
same server, path-routed on `/ws/probe`. It may not — Colyseus's transport binds the `upgrade`
event itself. If it does not, the fallback is a Colyseus room with **exactly one message type**,
and the "no rooms" revisit trigger in this ADR is **not** violated by that: that trigger forbids
the probe growing a _semantic_ room — players, seats, matches, fan-out — not the use of the
framework's own class as a mount point. Whichever path PER-94 takes, it reports **which one and
why**, because the answer is itself a fact about our transport that [PER-15](/PER/issues/PER-15)
needs.

### 3. What the probe deliberately does not do

It defines **no** part of the wire protocol: no `room:*`, no `game:action` / `game:view`, no
`timer:sync`, no framing, no codec, no heartbeat, no reconnection, no sequence numbers, no binary
path. Those are [PER-15](/PER/issues/PER-15)'s and they are unprejudiced by this file. If the probe
starts growing a second message type, that is the signal it has stopped being a probe — see the
revisit triggers.

### 4. The board is told which of the two it is watching

QA's caveat is the operative one and I am adopting it verbatim as a reporting requirement: **a ping
endpoint evidences a socket, not the platform.** The M0 demo and
[PER-86](/PER/issues/PER-86)'s acceptance report must say so in those terms. The board is being
shown that our hosting path does not break `Upgrade` — a real and load-bearing fact — and is _not_
being shown a working game. No AC5 recording may be captioned in a way that implies otherwise.

## Alternatives considered

### A. Record AC2 as not met and let the board sign off with two unmet criteria (QA's option 1)

QA is right that this is the honest record _today_, and honesty is not what it loses on. It loses on
consistency with our own treatment of AC3. The same report argues AC3 must not be waived because it
"costs nothing and waits on no held decision" — and I agreed. Gate 1 of AC2 is in that identical
class: ~60 lines, no spend, no vendor, no open decision. I cannot hold AC3 to that standard and
waive AC2's code gate in the same document. What survives from this option is the AC2b row, where
the blocker genuinely is external.

### B. Move AC2 to M1's acceptance, where the room runner lands (QA's option 3)

The tidiest option on paper, and the most expensive one in practice. It defers the highest-blast-
radius unknown in the stack — _does a socket survive our provider's edge, and for how long_ — past
the point where changing provider is cheap. Providers that strip `Upgrade`, cap idle connections,
or bill connection-minutes are common, and ADR-0003 has just picked one. Finding this out in M1,
after [PER-15](/PER/issues/PER-15) has fixed the transport contract and games depend on its shape,
converts a cheap decision into an expensive one. **Reversibility** and **real-time readiness** both
say the same thing: buy this information now, while it is still information rather than a rewrite.

### C. Pull enough of PER-15's real protocol into M0 to make AC2 literally true as written

Rejected as the worst of both. It would fix framing, codec and message names before the M4 spike has
produced a single number, under board-demo time pressure — precisely the conditions under which a
contract gets decided badly. ADR-0008 fixed the SDK contract at v1 deliberately and with evidence;
the wire protocol deserves the same and must not be back-doored through an acceptance criterion.

### D. Prove WebSocket support with a third-party echo service or a provider sample app

Evidences the provider's demo, not our artifact, our Node version, our Dockerfile, or our health
and readiness wiring. AC2's value is end-to-end through **our** deployment path; anything less is a
green tick over an untested path.

## Evidence

> **Measurement owed.** The probe's purpose is to produce numbers this ADR cannot yet contain.
> Platform Engineer owes, on [PER-94](/PER/issues/PER-94) for AC2a and
> [PER-7](/PER/issues/PER-7) for AC2b, before the M0 demo:
>
> 1. **Round-trip RTT** for one `ping`/`pong`, measured from a second host, reported as a number
>    against the < 150 ms p95 in-region turn-based target — labelled as a transport floor, not as a
>    measurement of that target, because no game logic is in the path.
> 2. **Cold-start wake time**, reported as a **separate** number from RTT. The board ruled a woken
>    free-tier service is acceptable evidence provided the wake is stated, not hidden.
> 3. **Idle-socket survival time** against the chosen provider — how long a silent connection stays
>    open before the edge closes it. This is the number that sets the heartbeat interval in
>    [PER-15](/PER/issues/PER-15), and the reason to buy it in M0 rather than M1.
>
> Until those exist this decision rests on the structural argument above, not on data. Nothing here
> may be reported as met on the strength of this ADR.

Facts that are measured, as of 2026-09-30, re-run by QA on [PER-86](/PER/issues/PER-86):
42-line HTTP-only `apps/realtime` entrypoint on `origin/main`; no `ws` or `@colyseus/*` dependency
declared; zero WebSocket hits across all 20 remote branches.

## Consequences

**Easier.** AC2a is reachable in M0 with no spend and no board input. The provider's socket
behaviour — upgrade, idle timeout, cold start — becomes a measured number before
[PER-15](/PER/issues/PER-15) fixes the transport contract, and before the hosting choice in
ADR-0003 is expensive to unwind. CI gains a real WebSocket integration test, which is the harness
the room runner's tests will extend.

**Harder.** The repo now contains a WebSocket path that is _not_ the protocol, and that is a
standing invitation to mistake one for the other. Mitigated three ways: one file, a feature flag
that is off in production, and a deletion trigger below. It adds **one env var** and, per §2.1, **no
new declared runtime dependency** — `ws` is already transitive under `@colyseus/ws-transport`. It
also pulls forward the first real Colyseus wiring in `apps/realtime`, which no branch has yet: the
probe cannot ride the shipped transport until a shipped transport exists. That is work M1 would do
anyway, but M0 now depends on a slice of it.

**Committed to.** Reporting AC2 as two rows in [PER-86](/PER/issues/PER-86) and in the M0 demo, and
to describing the probe to the board as evidence of a socket rather than of the platform. Also to
**Colyseus as the host of the probe's socket**, which is a restatement of ADR-0001 §4.2 rather than
a new commitment. Rev 1 said `ws` here and was wrong; see the amendment note.

**Cost to reverse: cheap** (a day). One file, one dependency, one env var, one CI test. The
acceptance-criterion split is a documentation change.

## Revisit triggers

- **The probe grows a second message type, or any notion of a room, player, seat or match.** It has
  stopped being a probe and become an unreviewed protocol. Delete the addition and move it to
  [PER-15](/PER/issues/PER-15).
- **[PER-15](/PER/issues/PER-15)'s transport adapter lands.** `ws-probe.ts` is then deleted or
  absorbed into the adapter's own conformance test, and `REALTIME_WS_PROBE` is removed. The probe
  is scaffolding with a scheduled demolition date, not a feature.
- **Measured idle-socket survival is short enough to need application-level keepalive** — this
  changes [PER-15](/PER/issues/PER-15)'s heartbeat design and ADR-0005's netcode assumptions, and
  the numbers belong in both.
- **The board rules that AC2 must be met as originally worded, as one row.** Then AC2 is not met in
  M0 and alternative A applies; the probe still earns its keep as the AC2b harness.
- **Gate 2 is never lifted before the M0 demo.** AC2b is then recorded not met alongside AC1b, with
  the same reason and the same owner. AC2a stands on its own.

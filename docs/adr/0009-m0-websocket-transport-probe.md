# ADR-0009: Evidence M0's WebSocket criterion with a transport probe, not with the protocol

- **Status:** Accepted (rev 2)
- **Date:** 2026-09-30
- **Amended:** 2026-09-30 (**rev 2**) — QA found on [PER-170](/PER/issues/PER-170) that **AC2a
  named an artifact this repo cannot produce**: `apps/realtime`'s `build` is `tsc --noEmit`, so
  there is no build output and `start` runs TypeScript source under `tsx`. **AC2a is re-worded to
  name what actually runs and deploys**, and new **§5** records why the alternative — making the
  build emit — is not the cheap half of the choice it looks like. No criterion is weakened and no
  evidence already gathered is invalidated. The AC2a row, **§5** and the Evidence section changed.
  See [What changed in rev 2](#what-changed-in-rev-2).
- **Author:** CTO
- **Milestone:** M0
- **Issue:** [PER-87](/PER/issues/PER-87), amended on [PER-170](/PER/issues/PER-170)

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

| #        | Criterion                                                                                                                  | Gate                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **AC2a** | A WebSocket round trip succeeds against `apps/realtime` **as it actually runs and deploys**, locally and in CI (rev 2, §5) | Code only. Reachable now, zero spend                                                     |
| **AC2b** | The same round trip succeeds against a deployed staging URL, driven from a second host                                     | Provisioning — the AC1b gate. Free-tier evidence accepted per [PER-2](/PER/issues/PER-2) |

A single verdict for both would attribute a 60-line omission to the provisioning hold. That is the
same error the AC1 split exists to prevent: it lets a code-shaped problem hide behind a
money-shaped one.

### 2. Gate 1 is closed by a transport probe, and the board is told it is a probe

`apps/realtime` gains one route, `GET /ws/probe`, using `ws` — already the agreed server in
ADR-0001 §4.1, so this commits us to nothing new. Specification, which is binding on the
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

### 5. AC2a names what runs, not a build output (rev 2) {#ac2a-names-what-runs}

Rev 1 worded AC2a against _"the built `apps/realtime` artifact"_. There is no such artifact. QA
established on [PER-170](/PER/issues/PER-170) that `apps/realtime`'s `build` script is
`tsc --noEmit` — it type-checks and emits nothing — while `start` is `tsx src/index.ts`. The probe
QA measured, the one `test/ws-probe.integration.test.ts` exercises, and the one a staging deploy
would answer are all the same path: **source under `tsx`**. The criterion described a fourth thing
that does not exist.

**AC2a is re-worded rather than the build made to emit.** The two are not a wording fix versus a
one-line fix; only the first is small.

- **What runs is what deploys, and that is the property AC2a is for.** `start` runs
  `src/index.ts`. A `build` that emitted to `dist/` while `start` kept running source would give us
  an artifact **nothing executes** — and would move the probe off the deployed path onto a shadow
  one. Against **blast radius**, that is a downgrade: the round trip would stop evidencing the thing
  that serves players.
- **Dropping `--noEmit` does not produce a runnable artifact today.** Measured 2026-09-30 on
  `fa0833f` under Node v24.21.0: `tsc --outDir dist` exits 0 and emits `dist/index.js` and
  `dist/env.js`, then `node dist/index.js` **fails to boot** with `ERR_MODULE_NOT_FOUND`, while
  `tsx src/index.ts` on the same tree serves (`[realtime] listening on http://localhost:8791`).
  The cause is structural, not local: the emitted `import … from '@playhall/shared'` resolves
  through that package's `exports` map to `./src/index.ts`, whose own relative imports are
  extensionless (`export { … } from './brand'`), which Node's ESM resolver rejects. All three of
  those facts hold on `main` at `7d16885` — `apps/realtime/src/index.ts` imports
  `@playhall/shared` and `@playhall/platform-core`; both declare
  `"exports": { ".": "./src/index.ts" }`; `packages/shared/src/index.ts` re-exports
  extensionlessly — so `main` fails the same way for the same reason. The measurement was taken on
  `fa0833f` rather than `main` because that checkout is the one with an install; it differs from
  `main` in the package scope and unrelated files, not in any of the three facts above.
- **So option 1's real scope is the monorepo's module strategy, not this app's `build` script.**
  Every workspace package publishes `"exports": { ".": "./src/index.ts" }`. Making `apps/realtime`
  genuinely runnable from `dist/` means converting `packages/shared`, `packages/platform-core` and
  their siblings to built, extensioned output with declaration emit, then re-pointing every
  consumer, the vitest configs, `apps/web`'s transpile, and the dependency-boundary rules — whose
  regexes match **resolved** paths ([ADR-0002](./0002-dependency-boundary-enforcement.md)) and
  would need re-fixturing. That is a real decision with a real blast radius, and doing it in M0
  under demo pressure to make a sentence true is the wrong order of operations.
- **Reversibility** picks the same way. Re-wording costs this amendment. If and when we adopt a
  compiled deploy artifact — see the revisit trigger below — AC2a's wording follows the artifact,
  because the criterion tracks the deployed path by construction rather than naming a build step.

**This does not mean the packaging question is closed.** Shipping a Node service that runs
TypeScript through `tsx` is fine for M0 and is not a launch posture: `tsx` is a **devDependency**,
so any production install that omits dev dependencies breaks `pnpm start`, and
[ADR-0003](./0003-hosting-and-cost-model.md) fixes no build or start command for the provider.
That belongs to the first real deploy and is tracked on [PER-184](/PER/issues/PER-184), which owes
an ADR with measured boot time and image size before any of the three options is chosen. It is
called out here so AC2b ([PER-7](/PER/issues/PER-7)) does not rediscover it as a surprise.

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

**Rev 2 (AC2a wording).** QA measured [PR #84](https://github.com/neerajkrbansal1996/playhall/pull/84)
end to end on [PER-170](/PER/issues/PER-170) and it passes every clause of §2: RTT p50 0.231 ms /
p95 0.965 ms over 200 round trips — **a transport floor, not a measurement of the < 150 ms p95
target**, exactly as required above — idle-socket survival 30.0 s, and 20 of 20 adversarial frames
rejected with typed errors and correct close codes. Those numbers were taken against source under
`tsx`, which after rev 2 is what AC2a asks for. The build-emit measurement that decided the wording
is in §5. Item 2 of the measurement owed above (cold-start wake time) is an AC2b number and remains
outstanding on [PER-7](/PER/issues/PER-7).

## Consequences

**Easier.** AC2a is reachable in M0 with no spend and no board input. The provider's socket
behaviour — upgrade, idle timeout, cold start — becomes a measured number before
[PER-15](/PER/issues/PER-15) fixes the transport contract, and before the hosting choice in
ADR-0003 is expensive to unwind. CI gains a real WebSocket integration test, which is the harness
the room runner's tests will extend.

**Harder.** The repo now contains a WebSocket path that is _not_ the protocol, and that is a
standing invitation to mistake one for the other. Mitigated three ways: one file, a feature flag
that is off in production, and a deletion trigger below. It also adds one dependency (`ws`) and one
env var to `apps/realtime` ahead of M1.

**Committed to.** Reporting AC2 as two rows in [PER-86](/PER/issues/PER-86) and in the M0 demo, and
to describing the probe to the board as evidence of a socket rather than of the platform. Also to
`ws` as the M1 server — though ADR-0001 §4.1 already committed us to that, so this is a
restatement, not a new commitment.

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
- **`apps/realtime` gains a compiled deploy artifact** — because the packaging question in §5 gets
  answered, or because the provider's build/start contract forces it. AC2a's wording then follows
  the deployed path onto that artifact, and rev 2's premise ("what runs is source") no longer
  holds. This is a wording consequence, not a re-decision: the criterion always tracks what runs.

## What changed in rev 2 {#what-changed-in-rev-2}

| Section         | Change                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status / header | Marked rev 2; amendment bullet added; [PER-170](/PER/issues/PER-170) recorded as the amending issue                                                                      |
| §1, AC2a row    | _"against the built `apps/realtime` artifact"_ → _"against `apps/realtime` as it actually runs and deploys"_                                                             |
| **§5 (new)**    | Why the criterion moved rather than the build script, with the measurement that shows an emitting build does not boot, and the packaging debt that stays open regardless |
| Evidence        | QA's rev-2 measurements against PR #84 recorded; the still-outstanding cold-start number attributed to AC2b                                                              |
| Revisit         | New trigger for the day a compiled artifact exists                                                                                                                       |

Nothing in §2 (the probe's binding specification), §3, §4, or the alternatives moved. No criterion
was weakened: AC2a still requires a real WebSocket round trip, locally and in CI, against our own
service. It no longer requires it against an artifact that does not exist.

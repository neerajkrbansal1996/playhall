# ADR-0011: `platform-core` is edge-importable per entrypoint, not per package

- **Status:** Accepted
- **Date:** 2026-10-01
- **Author:** CTO
- **Milestone:** M1
- **Issue:** [PER-164](/PER/issues/PER-164) (gate: [PER-162](/PER/issues/PER-162); origin:
  [PER-11](/PER/issues/PER-11) / [PER-65](/PER/issues/PER-65), PR #14, merged as `9f180cf`)
- **Review:** [PER-185](/PER/issues/PER-185) — Platform Engineer, non-author. §3's mechanism and §5's
  delta were independently re-measured there and this document reflects the corrected versions.

## Context

Two statements landed on `main` in the same merge and they contradict each other.

`packages/platform-core/src/runtime.ts` says, of `webCryptoRandomSource()`:

> Deliberately not `node:crypto` — this package has to stay importable from an edge runtime.

`packages/platform-core/src/identity/guest-token.ts` opens with:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
```

One of the two is wrong. Which one is wrong is not a style question, because the claim in
`runtime.ts` is the reason a port exists instead of a direct call, and because the failure mode of
getting it wrong is invisible to every gate we had at the time of the merge: the unit tests run on
Node, `tsc` is clean, and nothing in CI evaluated the package under an edge runtime at all.

The obvious fix — swap `createHmac` for WebCrypto — is not mechanical. WebCrypto's HMAC is
`crypto.subtle.sign`, which is **async**. That turns `signGuestToken` and `verifyGuestToken` into
`Promise`-returning functions, which turns `GuestIdentityService.issue()` and `.authenticate()`
async, and those two methods are the entry points every request will go through.

So the decision has three parts, and the order matters:

1. Is the constraint real? "Edge" is not one runtime; the answer differs between Next.js Edge
   middleware and Cloudflare Workers, and we have committed to both.
2. If it is real, does an edge runtime need to **verify** a guest cookie, or only **read** one?
   `readGuestCookie` is already pure. If middleware only needs "is there a cookie", the constraint
   might dissolve without any signature change.
3. What does each option cost, in measured numbers, against the **turn-based action round-trip
   < 150 ms p95** target that guest-token verification sits on.

§Evidence answers all three empirically. Two of the answers are not what the framing in
[PER-164](/PER/issues/PER-164) assumed, and they are what decides this ADR.

## Evidence

All measurements taken 2026-09-30 on the development host: Apple M4 Pro, 12 cores, Node v24.21.0,
darwin/arm64. Reproduction commands are in §6.

### 1. `node:crypto` under Cloudflare Workers: **fully supported.** Not a constraint.

Cloudflare's own runtime reference
([developers.cloudflare.com/workers/runtime-apis/nodejs/crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/),
retrieved 2026-09-30 via the board's Cloudflare connection) states:

> All `node:crypto` APIs are fully supported in Workers with the following exceptions: …
> `generateKeyPair`/`generateKeyPairSync` do not support DSA or DH key pairs; `argon2` and
> `argon2Sync` are not supported; `ed448` and `x448` curves are not supported; FIPS mode cannot be
> toggled.

`createHmac` and `timingSafeEqual` are in none of the four exceptions. Further, for compatibility
dates of **2026-08-04 or later, `nodejs_compat` is enabled by default** — so on a Worker created
today the flag is not even something we have to remember to set.

**The Cloudflare half of the constraint does not exist.** This matters because ADR-0003 §13.7 is the
one carved exception to the board's provisioning hold, and Cloudflare Pages is the only deployment
target `apps/web` has today.

### 2. Next.js Edge middleware: **a real, build-time constraint**, with a misleading diagnostic

Next 15.5.26's edge polyfill allowlist, read from the installed
`next/dist/build/webpack/plugins/middleware-plugin.js:584`:

```js
const SUPPORTED_NATIVE_MODULES = ['buffer', 'events', 'assert', 'util', 'async_hooks']
```

`crypto` is not in it. A middleware importing `node:crypto` fails `next build`:

```
Failed to compile.

node:crypto
Module build failed: UnhandledSchemeError: Reading from "node:crypto" is not handled by
plugins (Unhandled scheme).
```

Three things about that message are worth recording, because each one is a place this could have
been misdiagnosed:

- **It does not say "edge runtime".** Next has a friendly message for this —
  `The edge runtime does not support Node.js 'crypto' module.` (error code `E394`) — but
  `handleWebpackExternalForEdgeRuntime` only substitutes its `globalThis.__import_unsupported`
  proxy when the specifier **fails to resolve** (middleware-plugin.js:601–609, "allows user to
  provide and use their polyfills, as we do with buffer"). `node:crypto` resolves fine under Node,
  so the fallback never fires and raw webpack reports an unhandled URI scheme instead.
- **A dynamic `import()` of a Node builtin is only a _warning_** —
  `compilation.warnings.push(...)` at middleware-plugin.js:334–343. A static import is what fails
  the build.
- The `__import_unsupported` proxy throws on property access, i.e. **at request time**, not build
  time. We do not hit that path, but anyone who reaches it gets a 500 from a green build.

So the constraint is real, it is caught at build time, and the error will not tell the next engineer
what they actually did wrong.

### 3. No bundler setting rescues this: importing **only** `readGuestCookie` still fails.

This is the finding that decides the ADR, and it is the opposite of what
[PER-164](/PER/issues/PER-164)'s framing hoped for. A middleware that imports nothing but the pure
cookie reader:

```ts
import { readGuestCookie } from '@playhall/platform-core'
```

fails `next build` with this import trace:

```
node:crypto
../../packages/platform-core/src/identity/guest-token.ts
../../packages/platform-core/src/identity/index.ts
../../packages/platform-core/src/index.ts
```

`packages/platform-core/package.json` exports exactly one path (`"." : "./src/index.ts"`), so every
consumer enters through the barrel, the barrel re-exports `identity/index.ts`, and that re-exports
`guest-token.ts`. **"Read the cookie, never verify it" does not dissolve the constraint**, because
there is no import path that reaches `cookie.ts` without reaching `guest-token.ts`.

**Tree-shaking is not the mechanism, and declaring `sideEffects` does not fix it.** This was
re-measured under review ([PER-185](/PER/issues/PER-185)) against this exact graph shape, compiled
with Next 15.5.26's own bundled webpack targeting `webworker` with `sideEffects` and `usedExports`
both on:

| Variant                                         | Result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| no `sideEffects` field (today)                  | `UnhandledSchemeError` · `guest-token.ts` built |
| `"sideEffects": false`                          | **same `UnhandledSchemeError`** · still built   |
| deep import `…/identity/cookie.js`, today's map | `Module not found: … is not exported`           |
| same deep import + `"./src/*": "./src/*"` added | ✓ 0 errors · `guest-token.ts` **not** built     |

The barrel _is_ tree-shaken — a control with the `node:crypto` import swapped for a benign function
has the unused export dropped from the output in both of the first two variants. Tree-shaking is
simply irrelevant to this failure, because it removes dead code from the **bundle**, not modules
from the **build**: `SideEffectsFlagPlugin` rewrites re-export connections in `optimizeDependencies`,
after the module graph is complete, whereas `UnhandledSchemeError` is thrown during module build
while the graph is still being walked. Webpack cannot know `guest-token.ts`'s export names without
building it, and building it means resolving `node:crypto`.

So the invariant is not "we happen not to have declared `sideEffects`" — it is **no bundler setting
can reach this**. Only a different _entry_ into the graph can, which is what the fourth row shows
and what §4 builds on.

The consequence for the invariant is sharper than the wording in `runtime.ts` admits:
edge-importability is a property of an **entrypoint's reachable module graph**, not of a package and
not of a file. A single-entrypoint package is edge-importable only if _every_ module it re-exports
is.

### 4. A second entrypoint fixes it. Measured, not assumed.

Adding `"./edge": "./src/edge.ts"` to the exports map, with `src/edge.ts` re-exporting only
`cookie.ts` and the `runtime.ts` ports — and deliberately **not** `./identity/index.js` — and
pointing the same middleware at `@playhall/platform-core/edge`:

```
✓ Compiled successfully in 4.5s
```

(The build then failed in the subsequent `tsc` pass on `test/setup.ts`, an unrelated missing
`@testing-library/react` link in the throwaway symlink farm used for the experiment. The webpack
compile — the phase that failed in §2 and §3 — is green.)

### 5. The cost of async: **indistinguishable from sync.** |delta| < 1 µs, under 0.001 % of the budget.

169-byte signing input, 213-byte token — the real shape produced by `GuestClaimsSchema` with a
16-byte `gid`, 16-byte `sid` and a suggested display name. 60 rounds × 2000 calls per case, cases
measured **round-robin** so load drift lands on all of them equally, 20,000 warmup iterations each.

The host is a shared development box running many concurrent agent worktrees, so wall time is
contaminated by scheduler contention. Contention only ever _adds_ time, so the **minimum** batch is
the least-contaminated estimate; the p50 is reported beside it as the loaded-machine figure. Treat
the absolutes as an upper bound and the **differences** as the load-invariant result.

| Case                                       |      min |       p50 |        p95 |
| ------------------------------------------ | -------: | --------: | ---------: |
| `createHmac` (sync, `node:crypto`)         |  8.30 µs |  22.58 µs |  201.89 µs |
| `subtle.verify`, key imported once (async) |  8.48 µs |  90.70 µs |  419.94 µs |
| `subtle.sign`, key imported once (async)   |  9.79 µs | 112.69 µs |  501.57 µs |
| `subtle.sign`, `importKey` **every call**  | 14.74 µs | 139.42 µs | 1275.61 µs |
| `timingSafeEqual` (sync, `node:crypto`)    |    32 ns |     37 ns |     300 ns |
| hand-rolled XOR compare (sync)             |    10 ns |     11 ns |      39 ns |
| bare `await` on an empty async fn          |    53 ns |     69 ns |    1.03 µs |

Per-verify totals, min estimator:

| Path                                   |                  Per verify | vs the 150 ms p95 round-trip |
| -------------------------------------- | --------------------------: | ---------------------------: |
| sync: `createHmac` + `timingSafeEqual` |                     8.33 µs |                     0.0056 % |
| async: `subtle.verify`, key cached     |                     8.48 µs |                     0.0057 % |
| **delta**                              | **< 1 µs, sign unresolved** |                **< 0.001 %** |
| async: `importKey` + `sign` every call |                    14.74 µs |                     0.0098 % |

**The delta is reported as a bound, not a value, and that is deliberate.** This methodology was
re-run independently under review ([PER-185](/PER/issues/PER-185)) on a second host — same
round-robin ordering, same min-of-batches estimator, 40 × 2000 calls, four separate runs — and
async measured _faster_ every time, by 0.5–1.1 µs. Both hosts agree the two paths sit at ~8–10 µs;
neither can resolve the **sign** of the difference. A point estimate here would be spurious
precision: round-robin and min-of-batches control for drift, but they do nothing about a quantity
smaller than the run-to-run dispersion (~580 ns), and `min` carries no confidence interval. The
floor for any async conversion is a bare `await` on a resolved promise — 53 ns here, 66–75 ns there
— so anything this harness reports under ~1 µs is at or below the floor by construction and should
not be printed as a measurement. Measuring it properly means paired samples (A and B in the same
batch, reporting the distribution of per-batch differences), which nothing in this decision needs.

Three readings:

- **The async hop is free at this resolution.** The two paths are indistinguishable: whatever the
  delta is, it is under 1 µs against a 150 ms budget, i.e. under 0.001 %, and both hosts bound it
  there. **Performance is not a reason to reject option 1**, and this ADR does not use it as one —
  note that this cuts both ways, since the same data cannot be used to claim async is cheap _or_
  that it is costly.
- **Key caching is not optional.** Importing the `CryptoKey` per call costs 6.4 µs — a 77 % penalty
  and 4× worse than the entire sync path. Any WebCrypto implementation must import each keyring
  entry once at service construction. The naive port is the slow one.
- **`timingSafeEqual` is a 32 ns line item**, and the hand-rolled XOR loop is 10 ns. Option 4 was
  never going to be justified on speed, and it is not.

### 6. Reproduction

```bash
# §5 — benchmark (the script is throwaway; it is not committed)
node bench-hmac.mjs

# §2, §3, §4 — the build experiments
#   write apps/web/src/middleware.ts importing, in turn:
#     (a) node:crypto directly
#     (b) { readGuestCookie } from '@playhall/platform-core'
#     (c) { readGuestCookie } from '@playhall/platform-core/edge'   # + exports-map entry
#   add '@playhall/platform-core' to transpilePackages for (b) and (c), then:
cd apps/web && TMPDIR=/tmp ./node_modules/.bin/next build

# §2 — the allowlist, read from the installed Next
sed -n '584,592p' \
  node_modules/next/dist/build/webpack/plugins/middleware-plugin.js
```

### 7. Who would actually have to change, by grep rather than by reasoning

| Call site                                                             | Kind       | Would go async under option 1 |
| --------------------------------------------------------------------- | ---------- | ----------------------------- |
| `platform-core/src/identity/guest-token.ts:123` `signGuestToken`      | definition | yes                           |
| `platform-core/src/identity/guest-token.ts:142` `verifyGuestToken`    | definition | yes                           |
| `platform-core/src/identity/service.ts:230` (inside `issue()`)        | caller     | yes → `issue()` async         |
| `platform-core/src/identity/service.ts:243` (inside `authenticate()`) | caller     | yes → `authenticate()` async  |
| `platform-core/src/identity/index.ts:51–53`                           | re-export  | no                            |
| `platform-core/test/guest-token.test.ts`                              | tests      | ~30 call sites                |

**There are zero production callers of `issue()` or `authenticate()` outside `platform-core`.** No
route handler, no app, no game calls either method yet. The entire blast radius of option 1 today is
two functions, two methods and one test file.

And the runtimes we actually ship to today:

- `apps/web` has **no `middleware.ts`** — none exists on `main`, on any branch.
- `apps/web`'s only reference to `platform-core` is `import type { GameRegistration }` in
  `src/games.generated.ts`. Type-only, erased at compile time, no runtime edge. `platform-core` is
  not even in `next.config.ts`'s `transpilePackages`.
- The Cloudflare Pages target of ADR-0003 §13.7 is a **static export**
  (`PLAYHALL_STATIC_EXPORT=1` → `output: 'export'`). A static export has no server runtime at all,
  so it cannot be a consumer of anything in `platform-core`.
- The only value-level importer of `platform-core` in the repo is `apps/realtime` — plain Node.

So today the edge constraint binds **nothing**. That is a fact about today, not a licence: §Decision
is about what happens the first time somebody writes a `middleware.ts`.

## Decision

**Edge-importability is a property of an entrypoint, and `platform-core` gets a second one when it
needs it. `signGuestToken` and `verifyGuestToken` stay synchronous.**

Four parts.

### 1. The default entrypoint may use `node:crypto`. The claim in `runtime.ts` is corrected, not upheld.

Both runtimes that consume `platform-core` at value level today — Node in `apps/realtime`, and
Cloudflare Workers if we ever put a server there — support `node:crypto` in full (§1). The sentence
"this package has to stay importable from an edge runtime" is rewritten to state what is true and
enforceable:

> `@playhall/platform-core` (the default entrypoint) targets Node and Cloudflare Workers, both of
> which support `node:crypto`. Next.js Edge middleware does not, and `src/index.ts` re-exports the
> whole package, so the default entrypoint is **not** importable from Edge middleware — see
> ADR-0011 §3. Edge consumers import `@playhall/platform-core/edge`.

`webCryptoRandomSource()` keeps its reason to exist — it is the package's **documented default**
`RandomSource` and the thing the `/edge` entrypoint exports — but its doc comment stops asserting a
package-wide invariant that §3 disproves. "Documented" rather than "wired": today every `RandomSource`
is injected at the call site (`rooms/code.ts`, `rooms/service.ts`) and the one module that wants sync
random bytes reaches for `node:crypto` instead. Part 4's `service.ts` port is what makes the sentence
true in code as well as in prose.

### 2. When the first edge consumer appears, it gets `@playhall/platform-core/edge`. Not async.

The mechanism is §4's, which is measured working, not hypothesised: a second `exports` entry whose
module graph reaches no Node builtin. It does **not** re-export `identity/index.js`.

Its surface is **least-privilege, and narrower than "everything in `cookie.ts`"**: `readGuestCookie`,
`GUEST_COOKIE_NAME`, `GUEST_TOKEN_TTL_SECONDS`, `clearGuestCookie`, and the `runtime.ts` ports.
`serializeGuestCookie` is deliberately **excluded**, because its `token` parameter is an arbitrary
string — exporting it would let middleware mint `Set-Cookie: guest_token=<anything>`, a write
capability at precisely the boundary part 3 restricts to reading. Clearing a cookie grants no
authority, so `clearGuestCookie` stays for a logout-redirect UX. This enumeration is the contract
whoever builds `/edge` implements; removing a public export after it ships is a breaking change,
so the narrow version is the one that gets written down.

It is **not built today.** No edge consumer exists (§7), and a second public entrypoint maintained
for a hypothetical caller is a thing to keep in sync with no test exercising it. The decision
recorded here is the _shape_, so that whoever writes the first `middleware.ts` implements this and
does not rediscover the question — and so that they are not tempted to make the identity API async
under deadline because the build went red.

### 3. Edge middleware may read the cookie. It may not verify it.

This is the design consequence, and it is the part that must survive being read out of context.
Verification stays server-side in a Node handler. Middleware's legitimate use of the `/edge`
entrypoint is _presence_: is there a `guest_token` cookie, so an unauthenticated visitor can be
redirected to the name prompt without a round trip to an origin.

A presence check is not an authorisation decision and must never be treated as one. Middleware that
redirects on "no cookie" is a UX optimisation; a forged or expired cookie sails past it and is
rejected by `authenticate()` in the handler that actually does something. **Server-authoritative**:
the only code that may turn a cookie into an identity is the code that checks the MAC.

### 4. `guest-token.ts`'s dependency-cruiser exception becomes permanent and documented — and stays at exactly one file.

[PER-162](/PER/issues/PER-162)'s `no-platform-core-node-builtins` rule is kept, and its single
`$`-anchored exception for `guest-token.ts` is **converted from a temporary carve-out owned by this
ADR into a permanent one governed by it**. The rule's comment is rewritten to say what it now
enforces: not "platform-core reaches no Node builtin" (which §1 shows we do not want and §3 shows
the rule cannot express), but **"every Node builtin in `platform-core` is in this list, and the list
is short enough to read"**.

**There is a second `node:crypto` importer on `main`, and it is ported rather than excepted.**
`c08050e` landed `identity/service.ts:14` (`import { randomBytes as nodeRandomBytes }`) after
[PER-162](/PER/issues/PER-162)'s branch was cut, so that rule goes red on rebase. The correct fix is
a port, not a second exception: `service.ts:187` uses `randomBytes` **synchronously**
(`config.randomBytes ?? ((size) => nodeRandomBytes(size))`), and `webCryptoRandomSource()` in
`runtime.ts` already provides a sync `randomBytes(length): Uint8Array` over
`crypto.getRandomValues` with a structurally identical signature. That is a one-line change with no
async contagion, no contract change and no measurable cost — exactly the "take the capability as a
port" path the rule's own comment prescribes, and it is what makes part 1's "documented default"
sentence true.

This matters beyond tidiness: the policy above ("the list is short enough to read") is only
defensible while the list is one entry. Adding `service.ts` to it instead would convert a documented
one-file carve-out into a growing allowlist and trip revisit trigger #2 by accident. **Owner:
Platform Engineer, on [PER-162](/PER/issues/PER-162)**, which owns both the rule and `service.ts`;
the port lands with the gate so the gate is green when it merges. It must also land **before** any
`/edge` work, because the re-keying below is only expressible once the Node-builtin set in
`platform-core/src` is one file you can reason about.

When the `/edge` entrypoint lands (part 2), the rule should be re-keyed from a path denylist to a
reachability assertion over the `/edge` graph — dependency-cruiser can express that, and it is the
only form that actually enforces the invariant rather than approximating it. That re-keying is
`Deferred`, not skipped; see §Consequences.

## Alternatives considered

### 1. Async WebCrypto everywhere — **rejected: it does not deliver edge-importability, and it is the least reversible option. Not rejected on speed.**

Make `crypto.subtle.sign`/`verify` the implementation. `signGuestToken`/`verifyGuestToken` become
`Promise`-returning; `issue()` and `authenticate()` follow.

What the evidence says _for_ it: the performance objection is dead. Sync and async verification are
indistinguishable at under 1 µs apart (§5), against a 150 ms budget — and note that the same data
cannot be used in the other direction either, so performance is simply not evidence here. Next.js
middleware is already async, so the call-site
ergonomics are fine there. And today the change is astonishingly cheap — two functions, two methods,
one test file, **zero production callers outside the package** (§7). This is the cheapest moment
this option will ever have, and that argument was taken seriously.

Why it still loses:

- **It would not actually make the default entrypoint edge-importable — not even today.** Option 1
  converts `guest-token.ts` only. But `identity/service.ts:14` imports `node:crypto` as well (§Decision
  part 4), and it sits in the same barrel subtree, so it fails identically. Ship option 1 unchanged and
  `platform-core`'s default entrypoint is _still_ not importable from Edge middleware. On the
  edge-importability axis the swap buys **nothing at all**, while permanently making `issue()` and
  `authenticate()` async. This is a stronger objection than reversibility and it is the one to lead
  with: the option does not deliver the property it is named for.
- **It is the least reversible option, and it buys a consumer that does not exist.** Async is
  contagious in one direction only. Once `authenticate()` returns a promise, every route handler,
  every test, and every future caller is shaped by it, and unwinding that later means touching all
  of them. Option 2 is a single line in an exports map and can be deleted. **Reversibility** says
  put the cheap-to-undo choice in first when both work, and both work.
- **It treats a symptom whose cause is the single entrypoint.** It removes `node:crypto` from
  `guest-token.ts`, but the invariant it is supposed to restore — "the package is edge-importable" —
  is a property of the entrypoint graph (§3). Any other module in that subtree re-breaks it and the
  async signature does nothing to prevent that.
- **It trades a sync primitive for an async one at the wrong layer.** `verifyGuestToken` is a pure
  function over bytes: same input, same output, no I/O. An async signature on a pure function is a
  lie about what the function does, and it forecloses using it anywhere a synchronous predicate is
  wanted.

Revisit if part 2's `/edge` entrypoint ever needs to _verify_ rather than read — at that point async
is forced and this ADR is wrong. §Revisit triggers.

### 2. Split the entrypoint — **accepted as the mechanism** (§Decision parts 2–3)

Barrel stays as-is; edge-safe surface moves behind `@playhall/platform-core/edge`. Proven working in
§4. Cheapest to undo. Its stated cost — "a careless import reintroduces the problem silently" — is
real, and it is exactly what [PER-162](/PER/issues/PER-162)'s gate exists to catch; the two decisions
are complementary, which is why the gate is kept rather than removed (part 4).

The honest residual cost is that two entrypoints are two things to keep straight, and an engineer
who imports the default barrel into middleware gets §2's misleading `UnhandledSchemeError` rather
than a sentence telling them to use `/edge`. Mitigated by the rewritten `runtime.ts` comment naming
the `/edge` path, and by the rule comment in part 4.

**A wildcard subpath export is the cheaper-looking variant, and it is rejected.** §3's fourth row
shows that adding `"./src/*": "./src/*"` and deep-importing `cookie.ts` also compiles clean, and it
is what an engineer under deadline will reach for because it is one line and needs no curation. It
loses on two counts: it makes **every** internal module public API, so any file in `src/` becomes
something a consumer can pin and we must not move; and it defeats part 4's re-keying, because a
reachability assertion cannot be written over an entrypoint set that is "any file". A curated
`/edge` is a surface we chose; a wildcard is every surface we did not.

### 3. Keep sync `node:crypto` and amend the claim to "edge-importable except the token module" — **rejected as unwritable**

The cheapest option today, and the one this ADR is closest to in its _current_ state — but the
amendment cannot be written in the form proposed, because §3 proves there is no per-module import
path. "Except the token module" would describe an exception nobody can take advantage of: an edge
consumer cannot import around `guest-token.ts`. The only true version of the sentence is
"`platform-core` is not edge-importable", full stop, which is a larger retreat than the framing
anticipated and abandons the invariant rather than scoping it.

Its diagnosis of the real risk is right, though, and is adopted: **a conditional invariant is the
kind people get wrong.** Part 1 answers that by making the condition an entrypoint name rather than
a module exception — `@playhall/platform-core/edge` is edge-clean unconditionally, and the default
barrel is Node/Workers unconditionally. Two unconditional claims beat one conditional one.

### 4. Hand-rolled constant-time compare plus a small sync-HMAC dependency — **rejected**

Recorded so the rejection is on file. Two independent reasons, either sufficient:

- **We would be adding a dependency to hand-roll cryptography.** A third-party sync HMAC is
  unaudited code on the only thing standing between a player and someone else's seat, replacing two
  functions that ship in the platform. `guest-token.ts`'s own header explains why the token is not a
  JWT — we do not want to inherit somebody else's crypto bugs. Same argument, same answer.
- **There is no performance case.** §5: `timingSafeEqual` costs 32 ns and the XOR loop 10 ns, so the
  whole exercise is worth 22 ns against a 150 ms budget. And the hand-rolled loop's constant-timeness
  is a property of a JIT we do not control, which `timingSafeEqual` guarantees and a `for` loop over
  a `Buffer` does not.

Note that the XOR compare would become _necessary_ under option 1, since `timingSafeEqual` is also
`node:crypto` — a cost of option 1 that its framing did not price.

## Consequences

- **`runtime.ts`'s package-wide invariant is corrected in this same change.** The old comment
  asserted something §3 disproves; the replacement text is §Decision part 1's, and it ships in this
  commit rather than as follow-up work, so the file and this document do not disagree at any point.
  Recorded per `docs/adr/README.md`'s rule that an amendment contradicting the code must say which
  one is wrong.
- **`platform-core` cannot be imported from Next.js Edge middleware today**, and will fail
  `next build` with an error that does not mention the edge runtime (§2). Anyone who hits
  `UnhandledSchemeError: Reading from "node:crypto"` should read §3 first — though the path there
  starts one step earlier: `platform-core` is not in `apps/web`'s `transpilePackages` (only
  `game-sdk`, `shared` and `ui` are) and it ships TypeScript source via `exports: { ".":
"./src/index.ts" }`, so the first engineer to import it from middleware hits a parse failure
  _before_ they ever reach `UnhandledSchemeError`.
- **The dependency-cruiser rule approximates the invariant rather than enforcing it.** A path
  denylist answers "which files import a Node builtin", not "is the edge graph clean". It is the
  right approximation while there is one entrypoint and it is wrong once there are two. Re-keying it
  is `Deferred` and rides with part 2.
- **The gate cannot see a Node _global_.** `guest-token.ts`, `cookie.ts` and `service.ts` all use
  `Buffer` as a global rather than importing `node:buffer`, so no import edge exists and
  dependency-cruiser sees nothing. This is benign today — `buffer` is in Next's
  `SUPPORTED_NATIVE_MODULES` (§2) and Workers supports it — but the general hole is real: a global
  `process`, or any Node global with no edge equivalent, would pass the gate and fail at build or
  request time. An ESLint `no-restricted-globals` rule scoped to `platform-core/src` is the shape
  that closes it, and nothing today needs it.
- **No SDK-facing signature changes.** The decision keeps `signGuestToken`/`verifyGuestToken` sync
  and adds no public type, so the Game SDK contract is untouched and `GameViewProps` and friends are
  unaffected. Recorded explicitly because the alternative would have been a contract change: we are
  **pre-M2, so the board gate on Game SDK contract changes does not bind yet — after M2 it does**,
  and an option-1-shaped change made after M2 would need an ADR _and_ board approval.
- **Real-time readiness (M6).** A guest token is verified **once, at connection handshake**, not per
  tick. ADR-0005's room runner authenticates on the WebSocket upgrade and thereafter addresses the
  player by a connection-scoped id. So even option 1's async verify would sit in the handshake path
  and never inside the 33.3 ms tick budget — and a sub-microsecond delta is under 0.003 % of a tick
  in any case. This ADR does
  **not** sign us up for an async verify inside a tick loop, and if a future design puts one there,
  that design is wrong for reasons that have nothing to do with this decision.
- **Blast radius.** Getting this wrong is a red build, not a bad deploy — but only because
  [PER-162](/PER/issues/PER-162)'s gate fires first and in CI. Without it the failure surfaces in
  whichever pipeline first bundles for an edge target, which is why that issue lands before any
  `/edge` work.

## Revisit triggers

- **An edge consumer needs authenticated claims, not cookie presence.** The moment a legitimate
  design needs `verifyGuestToken` inside Next.js Edge middleware, §Decision part 3 is wrong and
  option 1 becomes the answer — async is then forced, and §5 says it costs nothing. Reopen rather
  than smuggling a verify into the `/edge` entrypoint.
- **A second module in `platform-core/src` needs a Node builtin with no WebCrypto-shaped port.** Two
  entries in the exception list means the list is becoming a policy, and the rule should be re-keyed
  to the `/edge` reachability assertion (part 4) at that point rather than growing.
- **Next.js adds `crypto` to `SUPPORTED_NATIVE_MODULES`**, or we drop Next.js Edge middleware from
  the stack. Either removes the only runtime that makes this a question at all, and the whole ADR
  collapses to "use `node:crypto`".
- **`apps/web` moves from static export to a Worker runtime** (`@cloudflare/next-on-pages` or
  equivalent). §1 says `node:crypto` is fine on Workers, but `next-on-pages` compiles through the
  _Edge_ runtime, not the Node one, so the §2 constraint would then apply to route handlers as well
  as middleware — a much larger surface than this ADR assumes. Re-measure before assuming §1 carries
  over.
- **A measured p95 regression on the action round-trip that fingers token verification.** §5 says
  8.33 µs sync and 8.48 µs async on an M4 Pro. Production hardware will be slower; if verification
  ever shows up as a non-trivial share of the 150 ms budget, the number to re-measure is
  `importKey` caching (§5's 6.4 µs finding), not the sync/async choice.

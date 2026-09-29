# Atrium

> **Atrium is an internal codename.** The product name, domain and logo are a board
> decision and are still open. Nothing in this repo may hard-code a brand string —
> read it from `packages/shared/src/brand.ts` (`BRAND.name`), which falls back to the
> codename and can be overridden with `NEXT_PUBLIC_BRAND_NAME`.

A browser-based multiplayer game platform. Anyone can open a lobby for any game, share a
link or a 6-character code, and play live with friends. No downloads, no sign-up, guests
only in v1.

## One-command local setup

Requires **Node 22+**, **pnpm 10+** and **Docker**.

```bash
pnpm install && docker compose up -d && pnpm dev
```

Or, equivalently:

```bash
pnpm setup   # install + start Redis and Postgres
pnpm dev     # start both apps
```

| What             | Where                                              |
| ---------------- | -------------------------------------------------- |
| Web app          | http://localhost:3000                              |
| Realtime service | http://localhost:3001 (`/health`)                  |
| Postgres         | `postgresql://atrium:atrium@localhost:5432/atrium` |
| Redis            | `redis://localhost:6379`                           |

`cp .env.example .env` if you need to change ports or point at a different
Redis/Postgres. Defaults match `docker-compose.yml`, so the copy is optional.

## Checks

```bash
pnpm typecheck    # tsc project references across every workspace package
pnpm lint         # eslint, flat config, whole repo
pnpm format       # prettier --write
pnpm test         # per-package tests (added from M1)
```

## Layout

```
apps/
  web/              Next.js App Router + Tailwind + shadcn/ui. Landing, lobby, room.
  realtime/         Node service. Wire protocol, room runner, timers.
packages/
  shared/           Cross-cutting constants and types. Brand config lives here.
  game-sdk/         The ONLY package a game may import. Contracts owned by the CTO.
  platform-core/    Identity, rooms, seats, chat, presence, persistence. Game-agnostic.
  netcode/          Real-time transport kit. M6, board-gated. Skeleton only.
  game-testkit/     Conformance suite every game must pass in CI.
  ui/               Shared presentational primitives.
games/
  _examples/        Reference games. tic-tac-toe lands in M1, before Chess.
docs/adr/           Architecture decision records.
```

## Rules that the build enforces

1. **Games are plugins.** A game package imports `@atrium/game-sdk` and third-party
   libraries — never platform internals, never another game. The platform never imports
   a game directly; games load through the registry. Enforced in CI from M0.2.
2. **Determinism.** No `Date.now()`, no `Math.random()`, no I/O inside game modules or
   the reducers that run them. Use `ctx.now` and `ctx.rng` (seeded server-side, seed
   stored on the match). ESLint flags the ambient calls inside `packages/` and `games/`.
3. **Server-authoritative.** The server is the single source of truth for every action,
   position, timer and result. Never trust a client-supplied one.
4. **Every message is validated.** `zod` for every JSON message and HTTP input.
5. **Conventional commits.** `commitlint` runs on `commit-msg`; see `CHANGELOG.md`.

## Licences

Code licences are logged in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md);
art, audio and 3D assets in [`ASSET_LICENSES.md`](./ASSET_LICENSES.md). No GPL UI
libraries or piece sets unless we open-source. Assets must be CC0 or commercially
licensed, and logged before they are committed.

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are generated from
[Conventional Commits](https://www.conventionalcommits.org/) at release-tag time.

## [Unreleased]

### Added

- pnpm workspace monorepo with TypeScript project references and a shared
  tsconfig / ESLint / Prettier baseline.
- Package skeletons: `apps/web`, `apps/realtime`, `packages/shared`,
  `packages/game-sdk`, `packages/platform-core`, `packages/netcode`,
  `packages/game-testkit`, `packages/ui`, `games/_examples`.
- `docker-compose.yml` for Redis + Postgres, with health checks and a
  `noeviction` Redis policy so live room state is never silently dropped.
- One-command local setup (`pnpm install && docker compose up -d && pnpm dev`).
- Conventional-commit enforcement via commitlint on the `commit-msg` hook.
- ESLint rule banning `Date.now()` and `Math.random()` inside `packages/` and
  `games/`, ahead of the full dependency-boundary rules in M0.2.
- Licence ledgers: `THIRD_PARTY_LICENSES.md`, `ASSET_LICENSES.md`.
- `@playhall/platform-core`: game registry, rooms with global 6-character codes,
  the join matrix, room lifecycle timers, rate limits including a per-IP cap on
  failed room-code joins, the route table, sitemap/`robots.txt`, and feature
  flags. See `packages/platform-core/README.md`.
- `pnpm registry:generate` / `pnpm registry:check`: generates the one allowlisted
  platform→game module (`apps/*/src/games.generated.ts`, ADR-0002 §3) from each
  game's declared `playhall.gameEntry`, and fails CI when it is stale.

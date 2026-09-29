# Example games

Reference implementations that prove the Game SDK works, and that double as the
worked examples in the SDK docs.

- **tic-tac-toe** — the first consumer of `@playhall/game-sdk`, built in M1 _before_
  Chess. If tic-tac-toe cannot be written against the SDK without reaching past it,
  the SDK is wrong and the contract changes before Chess starts.

Rules for anything in this directory:

- Import `@playhall/game-sdk` and third-party libraries. Nothing else. Not
  `@playhall/platform-core`, not another game. CI enforces this (M0.2).
- Pure and deterministic: no I/O, no `Date.now()`, no `Math.random()`. Use `ctx.now`
  and `ctx.rng`.
- Must pass the `@playhall/game-testkit` conformance suite before it can merge.

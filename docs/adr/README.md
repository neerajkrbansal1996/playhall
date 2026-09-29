# Architecture Decision Records

Every architectural decision that is expensive to reverse, or that constrains what a game
or an engineer may do, is recorded here. The CTO owns this directory.

## What an ADR must contain

An ADR with no alternatives and no numbers is not an ADR. Each one states:

1. **Context** — the forces that make this a decision rather than a preference.
2. **Decision** — what we are doing, in the imperative.
3. **Alternatives considered** — each with the reason it lost. "We didn't look" is not a reason.
4. **Evidence** — measured numbers against a stated target, or an explicit note naming who
   owes the measurement and by when. Never an unsourced assertion dressed as a fact.
5. **Consequences** — including the ones we dislike.
6. **Revisit triggers** — the observation that would make us reopen this. A decision with no
   revisit trigger is a belief, not a decision.

## Status values

| Status        | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `Proposed`    | Drafted, not yet agreed. Do not build against it.                    |
| `Accepted`    | Agreed and binding. CI and review enforce it.                        |
| `Board-gated` | Agreed by the CTO, waiting on a board decision before it is binding. |
| `Superseded`  | Replaced. Must name the ADR that replaces it.                        |
| `Rejected`    | Considered and declined. Kept so we do not re-litigate it.           |

A single ADR may carry `Accepted` for most of its decisions and `Board-gated` for one. Say
so per decision rather than downgrading the whole document.

## Process

- New ADR: copy `0000-adr-template.md` to `NNNN-kebab-title.md`, next free number.
- ADRs are reviewed in a pull request like code. The CTO is the required reviewer.
- **After M2, any change to a Game SDK contract needs an ADR first and then board approval.**
  See `0002-dependency-boundary-enforcement.md` for what counts as a contract change.
- A decision that costs money, picks a vendor, or is outward-facing is escalated to the
  board on [PER-2](/PER/issues/PER-2). The ADR records the recommendation; the board decides.

## Index

| ADR                                               | Title                           | Status                                     |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------ |
| [0001](./0001-v1-stack.md)                        | The v1 stack                    | Accepted, except §4.4 which is board-gated |
| [0002](./0002-dependency-boundary-enforcement.md) | Dependency-boundary enforcement | Accepted                                   |
| [0003](./0003-game-sdk-contract-v1.md)            | Fix the Game SDK contract at v1 | Accepted                                   |

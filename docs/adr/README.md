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

| ADR                                                 | Title                                           | Status                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [0001](./0001-v1-stack.md)                          | The v1 stack                                    | Accepted (rev 4)                                                                                            |
| [0002](./0002-dependency-boundary-enforcement.md)   | Dependency-boundary enforcement                 | Accepted (rev 2)                                                                                            |
| [0003](./0003-hosting-and-cost-model.md)            | Hosting + cost per 1,000 concurrent players     | Accepted as to the choice (Fly.io); spend suspended, provisioning held, free-tier signups permitted (rev 5) |
| [0004](./0004-pr-gate-without-branch-protection.md) | Enforcing the PR gate without branch protection | Accepted                                                                                                    |
| [0005](./0005-the-real-time-path.md)                | The real-time path (design only, M6)            | Mixed — see its own status table; §9 board-gated                                                            |
| 0006                                                | Empty standings for a match that did not count  | Reserved — drafting on [PER-42](/PER/issues/PER-42)                                                         |
| [0007](./0007-settings-form-descriptor.md)          | Settings-form descriptor contract               | Accepted                                                                                                    |
| [0008](./0008-game-sdk-contract-v1.md)              | Fix the Game SDK contract at v1                 | Accepted                                                                                                    |

Numbers are reserved as soon as an ADR is assigned, so two people drafting concurrently cannot
collide on one. A reserved row with no file means someone is writing it.

## Amending an ADR that has landed

An ADR is a dated record of a decision, not a description of the current code, so the two kinds
of edit are handled differently and by different people:

- **A mechanical identifier sweep** — a package name, a path, a rule literal quoted in the ADR
  text — travels with the refactor that renames it. A stale identifier in an ADR is a wrong
  instruction to whoever reads it next, and ADR-0002's rule table in particular is the spec CI
  is keyed on, so it must match reality.
- **A change to what the ADR records** — the decision, its alternatives, its status, a
  consequence — is an amendment, and the CTO writes it. Add a `**Rev N —**` note in place and a
  dated `**Amended:**` line in the header, rather than editing the original text to look like it
  always said the new thing. The superseded reasoning is the most useful part of the file in six
  months, and an amendment that contradicts the text above it without saying so is how ADR-0001
  ended up needing a rev 3.
- **When an amendment contradicts the code**, the ADR is not automatically right. Say which one
  is wrong and name the issue that fixes it; do not leave the two disagreeing.

When one commit would do both to the same file, the CTO takes the whole file and the refactor
excludes `docs/adr/**`. One owner per file beats a merge conflict in a decision record.

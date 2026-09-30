# CLAUDE.md

Guidance for agents working in this repository. Keep this file short — it is loaded into every
session. Put anything longer in `docs/` or in a skill under `.claude/skills/`.

## The repo

PlayHall: a pnpm workspace monorepo (`apps/`, `packages/`, `games/`). Start with
[`README.md`](README.md) for setup and [`docs/adr/README.md`](docs/adr/README.md) for the decisions
that constrain the code. CI gates are described in [`docs/ci-cd.md`](docs/ci-cd.md).

## Paperclip control plane: run this preflight first

Every agent on this board runs under Paperclip, and two control-plane behaviours have each cost a
full run of work. Both are written up in the
[`blocked-issue-and-blocker-edges`](.claude/skills/blocked-issue-and-blocker-edges/SKILL.md) skill.
Read it before you set `blockedByIssueIds` on any issue, and read it in full if either check below
trips.

**1. Confirm your run is task-bound before doing work whose only record would be a comment.**

```bash
if [ -z "$PAPERCLIP_TASK_ID" ]; then
  # Every comment and status write in this run will 403, on every issue,
  # including one you check out. Take the document + interaction exit instead.
  # See .claude/skills/blocked-issue-and-blocker-edges/SKILL.md §4.
fi
```

`PAPERCLIP_TASK_ID` empty ⟺ every comment and status write in that run returns
`403 cross_issue_influence_run_context_required`. Checking the issue out does **not** fix it, and
the error's advice to resend `X-Paperclip-Run-Id` does not work. Write a `heartbeat-log` document
(documents always succeed) and raise decisions as interactions (those always succeed). Never exit a
heartbeat silently because the API refused you.

**2. Blocker edges point up, never down.** Never give an issue a `blockedByIssueIds` edge to one of
its own descendants — a parent blocked by its child is redundant with `issue_children_completed`,
and a child blocked by its parent is a permanent deadlock. Never block an issue whose deliverable is
incrementally producible; model "cannot be finished yet" as an acceptance criterion instead.

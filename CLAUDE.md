# CLAUDE.md

Guidance for agents working in this repository. Keep this file short — it is loaded into every
session. Put anything longer in `docs/` or in a skill under `.claude/skills/`.

## The repo

PlayHall: a pnpm workspace monorepo (`apps/`, `packages/`, `games/`). Start with
[`README.md`](README.md) for setup and [`docs/adr/README.md`](docs/adr/README.md) for the decisions
that constrain the code. CI gates are described in [`docs/ci-cd.md`](docs/ci-cd.md).

## Paperclip control plane: run this preflight first

Every agent on this board runs under Paperclip, and two control-plane behaviours have each cost a
full run of work. If either check below trips, read the skill that owns it in full:
[`paperclip-run-binding`](.claude/skills/paperclip-run-binding/SKILL.md) for check 1 — the write
matrix and the compliant exit — and
[`blocked-issue-and-blocker-edges`](.claude/skills/blocked-issue-and-blocker-edges/SKILL.md) for
check 2, which you also read before setting `blockedByIssueIds` on any issue.

**1. Confirm your run is task-bound before doing work whose only record would be a comment.**

```bash
if [ -z "$PAPERCLIP_TASK_ID" ]; then
  # Every comment and status write in this run will 403, on every issue,
  # including one you check out. Take the document + interaction exit instead.
  # See .claude/skills/paperclip-run-binding/SKILL.md §4.
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

# CLAUDE.md

Guidance for agents working in this repository. Keep this file short — it is loaded into every
session. Put anything longer in `docs/` or in a skill under `.claude/skills/`.

## The repo

PlayHall: a pnpm workspace monorepo (`apps/`, `packages/`, `games/`). Start with
[`README.md`](README.md) for setup and [`docs/adr/README.md`](docs/adr/README.md) for the decisions
that constrain the code. CI gates are described in [`docs/ci-cd.md`](docs/ci-cd.md).

## Paperclip control plane: run this preflight first

Every agent on this board runs under Paperclip, and the control-plane behaviours below have each
cost a full run of work. If any check trips, read the skill that owns it in full:
[`paperclip-run-binding`](.claude/skills/paperclip-run-binding/SKILL.md) for check 1 — the write
matrix and the compliant exit — and
[`blocked-issue-and-blocker-edges`](.claude/skills/blocked-issue-and-blocker-edges/SKILL.md) for
checks 2 and 3, which you also read before setting `blockedByIssueIds` on any issue and before
delegating work you intend to resume on.

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
its own descendants — it freezes the parent and buys no sequencing — and never give a child an edge
to its parent, which is a permanent deadlock. Never block an issue whose deliverable is incrementally
producible; model "cannot be finished yet" as an acceptance criterion instead.

**3. When you delegate a review, the reviewer's comment on your issue is the only wake path.**
`issue_children_completed` did **not** fire on PER-269 when its review child PER-273 was marked
`done`, and an upward edge from your own issue to the review issue is worse than useless: an
unresolved blocker 422s your own checkout and then 403s every write for the run. So carry no edge in
either direction, stay `in_progress`, and state in the delegation body that the reviewer must comment
on your issue as well as closing theirs. Details and the measured alternatives are in the skill, §1.

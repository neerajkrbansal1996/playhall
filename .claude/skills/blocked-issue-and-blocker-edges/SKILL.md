---
name: blocked-issue-and-blocker-edges
description: >-
  Board rules for blocker edges, for writing on a blocked issue, and for a heartbeat run with no
  task binding. Read at the START of any heartbeat where PAPERCLIP_TASK_ID is empty or the
  scratch dir is named paperclip-run-unassigned-*; before setting blockedByIssueIds on any
  issue; and whenever a comment or status write on an issue you were woken for is refused with
  403 cross_issue_influence_run_context_required or 409 unresolved blockers.
---

# Blocker edges and writes on a blocked issue

Board rule for this company, ratified on PER-122 (2026-09-30). Two rules. Both were
learned from live incidents on this board, and both cost an agent a whole run of work.

## 1. Blocker edges point up, never down

Never put a `blockedByIssueIds` edge on an issue that is an **ancestor of its blocker**.

- A **parent blocked by its own child** is redundant: `issue_children_completed` already
  stops the parent completing first. The edge buys no sequencing and only freezes the parent.
- A **child blocked by its own parent** is a **deadlock**: the parent cannot complete until
  the child does, so neither can ever move. It presents as an agent that has simply gone
  quiet. This was PER-47.

Never block an issue whose deliverable is **incrementally producible** — an acceptance
report, a living test plan, a milestone container. Model "cannot be finished yet" as an
acceptance criterion instead, or have the deliverable block the milestone it gates.

Correct uses of a blocker edge: milestone-to-milestone ordering, and genuine technical
predecessors in a different subtree.

### Auditing this

The write field is `blockedByIssueIds`, but `GET /api/issues/{id}` returns the edges as
**`blockedBy`** (an array of objects), and the list route
`GET /api/companies/{id}/issues` **omits both**. An audit that greps the list route, or
looks for `blockedByIssueIds` on the detail route, reports zero edges board-wide and looks
clean when it is not. Use `blockedBy` from the per-issue `GET`, and compute the full
**transitive** descendant and ancestor sets — checking direct children only misses
grandchildren.

A `200` on a blocker-graph `PATCH` is **not** proof the change persisted. Always re-read
with a fresh `GET` after writing.

## 2. On a blocked issue the status write freezes — the comment usually does not

Blockedness by itself does **not** silence you. What silences you is a run with no task
binding (§4), and the two are independent: task binding is read off the run's dispatch
`context_snapshot` and checkout never writes it. So a run that was dispatched _for_ a
blocked issue is bound, and can comment on it.

With a bound run on a blocked issue:

- `POST /api/issues/{id}/comments` → `201`. **Post the comment.** Do not downgrade it to a
  document — a comment reaches people, a document reaches nobody.
- `PATCH /api/issues/{id}` changing `status` → `409`, and it takes any bundled `comment`
  down with it atomically. That atomicity is what makes a status freeze look like a comment
  freeze. Post the comment as its own `POST /comments` call instead of bundling it.
- `POST /api/issues/{id}/checkout` → `422`.

Only when your run is **unbound** (§4) is every comment and status write refused with
`403 cross_issue_influence_run_context_required`, including writes to the very issue you
were woken for. The advice in that error to send `X-Paperclip-Run-Id` does not help; the run
has no task binding to attribute the write to. In that case, and only then:

1. Put the content the comment would have carried into a `heartbeat-log` document on that
   issue. `PUT /api/issues/{id}/documents/{key}` **succeeds regardless**, with or without a
   bound run, and discharges the "never exit a heartbeat silently" rule.
2. Raise the blocker with your manager on an issue you _can_ write to.

Never exit a heartbeat silently because the API refused you.

### Verified write matrix on a blocked issue

| Call                                                             | Result                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /issues/{id}/checkout`                                     | `422` — blocked by unresolved blockers                             |
| `PATCH /issues/{id}` with a **different** `status`               | `409` — and it takes any bundled `comment` down with it atomically |
| `PATCH /issues/{id}` re-asserting `blocked`                      | `200`                                                              |
| `PATCH /issues/{id}` with `blockedByIssueIds` only, no `comment` | `200`                                                              |
| `POST /issues/{id}/comments` **with** a bound run                | `201`                                                              |
| `POST /issues/{id}/comments` **without** a bound run             | `403 cross_issue_influence`                                        |
| `PUT /issues/{id}/documents/{key}`                               | `201` — always                                                     |

## 3. Do not set an issue `in_progress` unless an agent can hold a run on it

`blocked` is overloaded. It means both "has unresolved dependency blockers" **and** "is
assigned, was `in_progress`, and has no live execution path" — the second is written by
Paperclip's terminal-run recovery:

> Paperclip automatically retried continuation for this assigned `in_progress` issue during
> terminal run recovery, but it still has no live execution path. Moving it to `blocked` so
> it is visible for intervention.

Both land on the same status, and that status gates checkout. So a container issue set
`in_progress` while its assignee is actually working elsewhere gets parked at `blocked`
within about 60 seconds, and then looks like a dependency problem that no amount of
blocker-graph editing will fix. Measured three times on PER-2, deterministic.

Leave container and roll-up issues in a status that matches who is really holding a run.

## 4. If your run is untethered, checkout will not save you

**Preflight — run this first, before you do any work whose only record would be a comment.**
There is an exact equivalence, read out of the server source and confirmed against the live
`heartbeat_runs` table on PER-147: the denial check reads `context.issueId || context.taskId`
off your run's `context_snapshot`, and the adapter derives `PAPERCLIP_TASK_ID` from the same two
keys of the same snapshot. So:

> **`PAPERCLIP_TASK_ID` empty ⟺ every comment and status write in this run will 403.**

```bash
if [ -z "$PAPERCLIP_TASK_ID" ]; then
  # Comments and status writes WILL 403 on every issue, including one you check out.
  # Take the document + interaction exit below. Do not start work you cannot report.
fi
```

`PAPERCLIP_SCRATCH_DIR` is a second tell: an unbound run's is named
`paperclip-run-**unassigned**-<runid>`, a bound one's `paperclip-run-<issue>-<runid>`.

Measured scope: only **board-triggered on-demand wakes** are affected (11 of 24 such runs). All
355 automation-dispatched and all 107 assignment-dispatched runs carried a source issue and were
fine. A normal scheduled heartbeat is not at risk.

`context_snapshot` is written once at run dispatch and is **never updated by any route**, checkout
included — which is why the next paragraph is true.

Separate from the blocker rules above, and hit live on 2026-09-30. A run that was **not started as
a task-bound heartbeat run** has no `PAPERCLIP_TASK_ID`, and then:

| Call                                    | Result                                           |
| --------------------------------------- | ------------------------------------------------ |
| `POST /issues/{id}/comments`            | `403 cross_issue_influence_run_context_required` |
| `PATCH /issues/{id}` with `status` only | `403 cross_issue_influence_run_context_required` |
| `PUT /issues/{id}/documents/{key}`      | `200` / `201`                                    |
| `POST /issues/{id}/interactions`        | `201`                                            |
| `POST /companies/{id}/skills`           | `201`                                            |
| `POST /issues/{id}/checkout`            | `200` — **but it does not fix the writes above** |
| `POST /issues/{id}/release`             | `200`                                            |

The error's advice — "send the `X-Paperclip-Run-Id` header with your current run and retry" — **does
not work** in this case. The header was set to the real run id and the write was still refused. The
binding that `POST /checkout` writes to the issue row is not the context the comment and status
routes check; a run cannot acquire heartbeat context retroactively. Do not burn a run retrying it.

**Do not check an issue out just to try to win a write.** `POST /checkout` moves the issue to
`in_progress`. If the status write back is also refused, you have left it `in_progress` with no live
run — exactly the condition in §3 that recovery parks at `blocked`. Checking out to escape a freeze
can cause one.

**If you are already in that hole, `POST /api/issues/{id}/release` is the undo.** No request body,
agent-authorized. It clears `checkoutRunId`/`executionRunId` and moves the issue to `todo`. That is
the only status transition available to an untethered run, because it bypasses `PATCH`.

**So the compliant exit from an untethered run is:** put the content in a document
(`heartbeat-log`), raise anything needing a decision as an **interaction** (those post fine), and
release the issue if you checked it out. Never exit silently because the API refused you.

### Two verification habits

- **A `200` is not proof.** Always re-read with a fresh `GET`. A document `PUT` needs
  `baseRevisionId` (get it from `latestRevisionId`) or it returns `409` — and a naive caller that
  only checks for a `2xx` will report a write that never landed.
- **Audit from the per-issue `GET`,** never the list route (see §1).

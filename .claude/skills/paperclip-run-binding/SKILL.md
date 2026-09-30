---
name: paperclip-run-binding
description: Read this at the START of every Paperclip heartbeat, before doing any work whose only record would be an issue comment. Covers the run-binding preflight (`PAPERCLIP_TASK_ID` empty means every comment and status write in this run will 403 with `cross_issue_influence_run_context_required`), why the error's `X-Paperclip-Run-Id` advice does not work, why `POST /checkout` does not rescue the writes and can strand an issue at `blocked`, and the compliant exit (document + interaction + `release`). Triggers on: an unexplained 403 on a comment or status write, `cross_issue_influence_run_context_required`, a scratch dir named `paperclip-run-unassigned-*`, the `Paperclip connections` MCP server failing with `422 Connection requests require a task-bound heartbeat run`, or being unable to record a disposition at the end of a heartbeat.
---

# Paperclip run binding: check it before you work, not after you are refused

Every agent on this repo shares this file. It exists because the same failure has now cost
three separate agents a full heartbeat of unrecorded work (PER-116, PER-146, PER-156). The
company skill `blocked-issue-and-blocker-edges` is the authoritative version of this rule;
this copy is here because the repo reaches every agent and skill attachment does not.

## 1. The preflight

Run this before you start work whose only record would be a comment.

```bash
if [ -z "$PAPERCLIP_TASK_ID" ]; then
  # Comments and status writes WILL 403 on every issue, including one you check out.
  # Take the exit in §4. Do not start work you cannot report.
fi
```

There is an exact equivalence here, not a heuristic. The server's denial check reads
`context.issueId || context.taskId` off the run's `context_snapshot`, and the adapter derives
`PAPERCLIP_TASK_ID` from the same two keys of the same snapshot. So:

> **`PAPERCLIP_TASK_ID` empty ⟺ every comment and status write in this run will 403.**

`context_snapshot` is written once at run dispatch and is **never updated by any route**,
checkout included. That is why nothing you do mid-run can repair it.

Two corroborating tells, if you want to confirm:

- `PAPERCLIP_SCRATCH_DIR` is named `paperclip-run-`**`unassigned`**`-<runid>` on an unbound
  run, and `paperclip-run-<issue>-<runid>` on a bound one.
- The `Paperclip connections` MCP server fails to connect at session start with
  `422: "Connection requests require a task-bound heartbeat run"`.

**Measured scope:** only **board-triggered on-demand wakes** are affected — 11 of 24 such
runs. All 355 automation-dispatched and all 107 assignment-dispatched runs carried a source
issue. A normal scheduled heartbeat is not at risk, so most heartbeats will pass this
preflight in one line and move on.

## 2. What is refused, and what still works

| Call                                                | Unbound run                                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| `GET /api/agents/me`, inbox, issue reads            | works                                                |
| `POST /issues/{id}/comments`                        | **403** `cross_issue_influence_run_context_required` |
| `PATCH /issues/{id}` with `status` and/or `comment` | **403** (same)                                       |
| `PUT /issues/{id}/documents/{key}`                  | `200` / `201` — works                                |
| `POST /issues/{id}/interactions`                    | `201` — works                                        |
| `POST /companies/{id}/issues` (create)              | `201` — works, company-scoped                        |
| `POST /companies/{id}/skills`                       | `201` — works                                        |
| `POST /issues/{id}/checkout`                        | `200` — **but it does not fix the writes above**     |
| `POST /issues/{id}/release`                         | `200` — works                                        |

## 3. Two pieces of advice that will waste your run

**The error's own remedy does not work.** The 403 body says _"send the
`X-Paperclip-Run-Id` header with your current run and retry."_ It has been set to the
correct run id and the write was still refused — reproduced through three independent
clients (Python `urllib`, `curl`, and `npx paperclipai issue comment --run-id`). The
binding `POST /checkout` writes to the issue row is not the context the comment and status
routes read. A run cannot acquire heartbeat context retroactively. Do not rewrite your
client.

**Do not check an issue out to try to win a write.** `POST /checkout` moves the issue to
`in_progress`. If the status write back is then refused, you have left it `in_progress`
with no live run — and Paperclip's terminal-run recovery parks exactly that state at
`blocked` within about 60 seconds. Checking out to escape a freeze can cause one.

## 4. The compliant exit from an unbound run

You still must not exit a heartbeat silently. Do all three:

1. **Put the content in a document.** `PUT /api/issues/{id}/documents/{key}` succeeds with
   or without a bound run. A `heartbeat-log` document discharges the "never exit silently"
   rule. It needs `baseRevisionId` (take it from `latestRevisionId`) or you get a `409`.
2. **Raise anything needing a decision as an interaction.**
   `POST /issues/{id}/interactions` posts fine on an unbound run.
3. **`POST /api/issues/{id}/release` if you checked the issue out.** No request body,
   agent-authorized. It clears `checkoutRunId`/`executionRunId` and moves the issue to
   `todo`. It is the only status transition available to an unbound run, because it bypasses
   `PATCH`. Skipping this is what leaves an issue stranded at `blocked`.

## 5. Verify writes by read-back

A `2xx` is not proof a control-plane write persisted. Re-read with a fresh `GET` and report
the value you read back, not the one you sent. This applies to status, blocker edges and
documents alike.

## Related

- Company skill `blocked-issue-and-blocker-edges` — blocker-edge direction, and the
  separate write freeze on an issue that has unresolved blockers.
- PER-122 — the standing platform-defect register for this board.

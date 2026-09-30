#!/usr/bin/env node
// Company-side net for issues that have no way to wake up.
//
// Paperclip's own recovery classifier is supposed to catch this
// (`recovery-observability` reports it as `stranded_assigned_issue`). On
// 2026-09-29 it did not: eight issues (PER-49, PER-53, PER-60, PER-63, PER-64,
// PER-65, PER-66, PER-67) died in one 20:07-20:09Z batch harness failure and
// sat `in_progress` with no active run, no monitor and no blocker edge for ~21
// hours. The escalation path always posts a notice comment and moves the issue
// to `blocked`; across the 21.5h between the last failed run and the PER-151
// restart, all eight took zero platform comments and zero status changes, so no
// action was ever taken. See PER-155 for the root cause in the vendor's own
// source; the short version is that a run which exhausts the bounded
// transient-retry ladder (2 attempts, 30s apart) writes
// `contextSnapshot.wakeReason = "transient_failure_retry"` and *no*
// `contextSnapshot.retryReason`, so the escalation guard that reads the latter
// never matches, and the fall-through requeue is short-circuited back into the
// same exhausted budget. The issue is then silently skipped on every later
// reconcile tick.
//
// This sweep does not depend on any of that. It asks one question directly of
// the board: which issues are nominally being worked on, but have nothing
// scheduled to wake them?
//
// A candidate is stranded when ALL of these hold:
//   - status is one of --status (default `in_progress`)
//   - assigned to an agent, not to a human (a human assignee is not stranded,
//     they are just slow)
//   - no live `activeRun`
//   - no live monitor (see `hasLiveMonitor`)
//   - no open child issue (`issue_children_completed` IS a wake path, so an
//     umbrella/milestone issue with live children is not stranded)
//   - no pending issue-thread interaction (a pending card IS a wake path)
//   - no open blocker edge (`issue_blockers_resolved` IS a wake path; a
//     `cancelled` blocker never fires it, so it does not count)
//   - no active recovery action (the platform already owns it)
//   - last activity is at least --threshold-hours old
//   - it is not one of the sweep's own routine execution issues
//
// ## Remedy, and why it is one atomic PATCH
//
// Two contradictory measurements exist on this board about how to restart a
// stranded issue. `status -> todo` is proven: PER-60 was flipped and woke with
// `wakeReason: issue_status_changed`. A comment is also proven: PER-49/64/65/66
// each produced a run with `wakeReason: issue_commented`, one claimed 94ms
// after the request. The apparent contradiction is a timing artefact — a wake
// request is enqueued immediately but only claimed once the issue is idle, so
// commenting and then polling `activeRun` on a busy issue reads null and looks
// inert.
//
// The remedy does not have to choose. `PATCH {status, comment}` is a single
// atomic write that carries both signals, so whichever wake the platform
// honours, one fires. Doing it as one request also sidesteps the recorded race
// where flipping to `todo` *after* a comment has taken the execution lock
// strips that lock and leaves the issue at `todo` with no checkout.
//
// ## Strike ladder
//
// 40.8% of runs on this company terminate with `acpx_turn_failed`. An
// unguarded sweep therefore produces flip -> wake -> die -> strand -> flip
// forever, burning the exact subscription capacity whose exhaustion causes the
// strandings. So after --strike-limit flips of the same issue inside
// --strike-window-hours, the sweep stops flipping and escalates to `blocked`
// with the assignee named as unblock owner. That is what the vendor's own
// `escalateStrandedAssignedIssue` would have done, and it is the behaviour the
// defect denies us.
//
// The strike ledger is not stored anywhere. It is counted from the sweep's own
// audit comments on the target issue, which makes it durable across fires, is
// visible to a human reading the thread, and needs no state file in a
// contended shared workspace.
//
// Usage:
//   node scripts/ops/stranded-issue-sweep.mjs [options]
//
//   --threshold-hours N       minimum idle age to report (default 2)
//   --status a,b              statuses to sweep (default in_progress)
//   --act                     apply the remedy; default is report-only
//   --max-actions N           cap remedies per fire (default 10)
//   --strike-limit N          flips of one issue per window before escalating
//                             to `blocked` (default 2)
//   --strike-window-hours N   strike ledger window (default 24)
//   --exclude a,b             issue ids or identifiers to never touch
//   --self-routine-id ID      routine whose execution issues to never touch
//   --json                    emit machine-readable JSON instead of a table
//   --exit-zero               always exit 0, even with findings
//
// Exit codes: 0 = nothing stranded, 1 = findings (unless --exit-zero),
//             2 = configuration or transport failure.
//
// Environment: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
// PAPERCLIP_RUN_ID is sent as X-Paperclip-Run-Id when present.
// PAPERCLIP_TASK_ID, when present, is excluded automatically — a sweep must
// never sweep the issue it is running under.

import { pathToFileURL } from 'node:url'

export const LIVE_RUN_STATUSES = new Set(['running', 'queued', 'starting', 'pending', 'dispatched'])
// A child in one of these states can still reach a terminal state and fire
// `issue_children_completed` on the parent. A `done`/`cancelled` child cannot.
export const OPEN_ISSUE_STATUSES = new Set([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
])
// Restore the highest-priority work first, so that a capped fire spends its
// budget where it matters. Anything unrecognised sorts last.
export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low']
// Every audit comment the sweep writes carries this marker, and nothing else
// does. Counting markers in the thread IS the strike ledger.
export const SWEEP_FLIP_MARKER = '<!-- stranded-issue-sweep:flip v1 -->'
export const SWEEP_ESCALATE_MARKER = '<!-- stranded-issue-sweep:escalate v1 -->'
const ISSUE_PAGE_LIMIT = 500
const DEFAULTS = {
  thresholdHours: 2,
  maxActions: 10,
  strikeLimit: 2,
  strikeWindowHours: 24,
}

const BOOLEAN_FLAGS = { '--json': 'json', '--act': 'act', '--exit-zero': 'exitZero' }
const NUMERIC_FLAGS = {
  '--threshold-hours': 'thresholdHours',
  '--max-actions': 'maxActions',
  '--strike-limit': 'strikeLimit',
  '--strike-window-hours': 'strikeWindowHours',
}
const LIST_FLAGS = { '--status': 'statuses', '--exclude': 'exclude' }

// Throws rather than exiting, so the parser is testable. Only value-taking flags
// consume the next argv entry — a boolean flag that swallows its successor
// silently drops whatever followed it, which is how `--exit-zero` stopped
// working when it was not the last argument.
export function parseArgs(argv) {
  const opts = {
    thresholdHours: DEFAULTS.thresholdHours,
    statuses: ['in_progress'],
    json: false,
    act: false,
    exitZero: false,
    maxActions: DEFAULTS.maxActions,
    strikeLimit: DEFAULTS.strikeLimit,
    strikeWindowHours: DEFAULTS.strikeWindowHours,
    exclude: [],
    selfRoutineIds: [],
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)
    const takesValue = NUMERIC_FLAGS[flag] || LIST_FLAGS[flag] || flag === '--self-routine-id'
    if (BOOLEAN_FLAGS[flag]) {
      if (inline !== null) throw new Error(`${flag} does not take a value`)
      opts[BOOLEAN_FLAGS[flag]] = true
      continue
    }
    if (!takesValue) throw new Error(`unknown argument: ${arg}`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    if (NUMERIC_FLAGS[flag]) opts[NUMERIC_FLAGS[flag]] = Number(value)
    else if (LIST_FLAGS[flag])
      opts[LIST_FLAGS[flag]] = String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    else opts.selfRoutineIds = [String(value)]
  }
  for (const [flag, key] of Object.entries(NUMERIC_FLAGS)) {
    if (!Number.isFinite(opts[key]) || opts[key] < 0) {
      throw new Error(`${flag} must be a non-negative number`)
    }
  }
  if (opts.statuses.length === 0) throw new Error('--status requires at least one status')
  return opts
}

function readConfig() {
  const rawUrl = process.env.PAPERCLIP_API_URL
  const apiKey = process.env.PAPERCLIP_API_KEY
  const companyId = process.env.PAPERCLIP_COMPANY_ID
  const missing = [
    !rawUrl && 'PAPERCLIP_API_URL',
    !apiKey && 'PAPERCLIP_API_KEY',
    !companyId && 'PAPERCLIP_COMPANY_ID',
  ].filter(Boolean)
  if (missing.length > 0) {
    process.stderr.write(`missing environment: ${missing.join(', ')}\n`)
    process.exit(2)
  }
  // PAPERCLIP_API_URL is sometimes the bare origin and sometimes already
  // suffixed with /api. Normalise to the origin.
  const base = rawUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  return { base, apiKey, companyId, runId: process.env.PAPERCLIP_RUN_ID ?? null }
}

async function api(cfg, path, init = {}) {
  const headers = {
    Authorization: `Bearer ${cfg.apiKey}`,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(cfg.runId ? { 'X-Paperclip-Run-Id': cfg.runId } : {}),
    ...(init.headers ?? {}),
  }
  const res = await fetch(`${cfg.base}${path}`, { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return text.length > 0 ? JSON.parse(text) : null
}

function asList(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.items)) return payload.items
  return []
}

export function hasLiveRun(issue) {
  const run = issue.activeRun
  if (!run) return false
  // A non-null activeRun whose status is already terminal is not a wake path.
  // It is the corpse of the run that died, and reading it as liveness is
  // exactly how the batch of eight stayed invisible.
  return !run.status || LIVE_RUN_STATUSES.has(run.status)
}

// A monitor is a real wake path: `tickDueIssueMonitors` re-wakes the assignee
// once `monitorNextCheckAt` passes. Flipping a monitored issue would destroy a
// legitimate review wait, so a future monitor always excludes.
//
// A monitor that is only slightly past due is queue lag, not a dead monitor, so
// it also excludes. One that is past due by more than the sweep's own idle
// threshold has demonstrably not fired, and is no more a wake path than a
// terminal `activeRun` is.
export function hasLiveMonitor(issue, now, thresholdMs) {
  if (!issue.monitorNextCheckAt) return false
  const due = new Date(issue.monitorNextCheckAt).getTime()
  if (Number.isNaN(due)) return true // unparseable: assume live and leave it alone
  return due > now - thresholdMs
}

export function idleSince(issue) {
  const stamp = issue.lastActivityAt ?? issue.updatedAt ?? issue.startedAt ?? issue.createdAt
  return stamp ? new Date(stamp) : null
}

export function openChildIds(issue, allIssues) {
  return allIssues
    .filter((other) => other.parentId === issue.id && OPEN_ISSUE_STATUSES.has(other.status))
    .map((other) => other.id)
}

// The sweep must never find and flip itself. A routine execution issue is
// assigned to the routine's agent and sits `in_progress` while it runs, so if
// its own run dies it becomes a textbook candidate on the next fire.
export function isOwnExecutionIssue(issue, { excludeIds = [], selfRoutineIds = [] } = {}) {
  if (excludeIds.includes(issue.id) || excludeIds.includes(issue.identifier)) return true
  return Boolean(issue.originId) && selfRoutineIds.includes(issue.originId)
}

// Cheap, list-only screen. Everything here comes from the single issues list
// call, so it costs no extra requests.
export function isShallowCandidate(issue, allIssues, opts) {
  const { statuses, cutoff, now = Date.now(), thresholdMs = 0 } = opts
  if (!statuses.includes(issue.status)) return false
  if (issue.hiddenAt) return false
  if (!issue.assigneeAgentId) return false
  if (issue.assigneeUserId) return false
  if (isOwnExecutionIssue(issue, opts)) return false
  if (hasLiveMonitor(issue, now, thresholdMs)) return false
  if (hasLiveRun(issue)) return false
  if (openChildIds(issue, allIssues).length > 0) return false
  const since = idleSince(issue)
  if (!since || Number.isNaN(since.getTime())) return false
  return since <= cutoff
}

// The pure half of the per-candidate confirmation. Each input is a real wake
// path that the issues list does not expose, so a shallow candidate is only a
// finding once all three come back empty.
export function evaluateDeepWakePaths({ detail, interactions, recovery }) {
  // `blockedByIssueIds` always reads back null; the populated edge list is
  // `blockedBy`. Only an *open* edge is a wake path: a `done` blocker has
  // already fired `issue_blockers_resolved`, and a `cancelled` blocker never
  // counts as resolved, so it can never fire it.
  const openBlockers = (detail?.blockedBy ?? []).filter((edge) =>
    OPEN_ISSUE_STATUSES.has(edge.status),
  )
  const pendingInteractions = asList(interactions).filter((entry) => entry.status === 'pending')
  const activeRecovery = recovery?.active ?? null
  return {
    openBlockers,
    pendingInteractions,
    activeRecovery,
    stranded: openBlockers.length === 0 && pendingInteractions.length === 0 && !activeRecovery,
  }
}

// The strike ledger, read straight off the issue thread. Only the sweep writes
// SWEEP_FLIP_MARKER, so counting it inside the window counts our own prior
// flips — no state file, and a human reading the thread sees the same number.
export function countRecentFlips(comments, now, windowMs) {
  const floor = now - windowMs
  return asList(comments).filter((comment) => {
    if (!String(comment?.body ?? '').includes(SWEEP_FLIP_MARKER)) return false
    const at = new Date(comment.createdAt ?? 0).getTime()
    return Number.isFinite(at) && at >= floor
  }).length
}

// Two flips inside the window already failed to stick. A third would just burn
// the capacity whose exhaustion causes the stranding in the first place, so the
// issue goes to `blocked` with a named owner instead.
export function decideRemedy(flipCount, strikeLimit) {
  return flipCount >= strikeLimit ? 'escalate' : 'flip'
}

// `critical -> high -> medium -> low`, then oldest first, then capped. The cap
// exists because the shared workspace is contended: restoring 21 issues at once
// would make the sweep the contention event it is meant to prevent.
export function prioritiseFindings(findings, maxActions) {
  const rank = (priority) => {
    const index = PRIORITY_ORDER.indexOf(priority)
    return index === -1 ? PRIORITY_ORDER.length : index
  }
  const ordered = [...findings].sort(
    (a, b) => rank(a.priority) - rank(b.priority) || b.idleHours - a.idleHours,
  )
  return { selected: ordered.slice(0, maxActions), deferred: ordered.slice(maxActions) }
}

function flipBody(finding, flipCount, strikeLimit) {
  return [
    SWEEP_FLIP_MARKER,
    '## Stranded work restarted',
    '',
    `This issue sat \`${finding.status}\` for ${finding.idleHours}h with no active run, no live monitor,`,
    'no pending interaction, no open child and no blocker edge. Nothing was going to wake it.',
    '',
    'Moved to `todo`, which is the queue your normal heartbeat drains. This comment carries the audit',
    'trail; the status change carries the wake.',
    '',
    '**Before you redo anything, check the premise.** A previous run may have died mid-commit, and some',
    'of these issues turn out to be chasing a gap that no longer exists. Read your branch and re-measure',
    'before writing code — and if the work is finished or obsolete, record that disposition instead of',
    'leaving the issue `in_progress`.',
    '',
    `Restart ${flipCount + 1} of ${strikeLimit} allowed in the strike window. After ${strikeLimit}, this issue`,
    'is escalated to `blocked` instead of restarted again.',
    '',
    `Detected by \`scripts/ops/stranded-issue-sweep.mjs\` at ${new Date().toISOString()} — see PER-155.`,
  ].join('\n')
}

function escalateBody(finding, flipCount) {
  return [
    SWEEP_ESCALATE_MARKER,
    '## Stranded work escalated — restart limit reached',
    '',
    `This issue has been restarted ${flipCount} time(s) by the stranded-issue sweep inside the strike`,
    `window and stranded again each time (${finding.idleHours}h idle now). Restarting it a third time`,
    'would just consume the subscription capacity whose exhaustion is causing the strandings, so it is',
    '`blocked` instead.',
    '',
    `**Unblock owner:** the assignee, agent \`${finding.assigneeAgentId}\`.`,
    '**Unblock action:** read the run failures on this issue, decide whether the work is still wanted,',
    'and either resume it deliberately or close it with a disposition. If the runs are dying with',
    '`acpx_turn_failed`, that is the upstream capacity problem tracked from PER-155 — say so and stop,',
    'rather than retrying into it.',
    '',
    `Escalated by \`scripts/ops/stranded-issue-sweep.mjs\` at ${new Date().toISOString()}.`,
  ].join('\n')
}

// A PATCH that succeeds always echoes the updated issue. An empty body, or an
// echoed status that is not what we asked for, is a failed write however the
// request exited — so the remedy is only ever reported from the read-back, never
// inferred from the request having returned.
export function confirmWrite(updated, expected) {
  if (!updated || typeof updated !== 'object') return { ok: false, reason: 'empty response body' }
  if (updated.status !== expected) {
    return { ok: false, reason: `read back status ${updated.status}, expected ${expected}` }
  }
  return { ok: true, status: updated.status }
}

// The whole remedy decision, with no IO in it: given the target's comment
// thread, produce the exact PATCH to send. The status and the comment travel in
// one atomic write — see the header note on why that is one request and not two.
export function planRemedy(finding, comments, opts, now) {
  const flipCount = countRecentFlips(comments, now, opts.strikeWindowHours * 3600_000)
  const remedy = decideRemedy(flipCount, opts.strikeLimit)
  if (remedy === 'escalate') {
    return {
      remedy,
      flipCount,
      expectStatus: 'blocked',
      patch: {
        status: 'blocked',
        unblockDescriptor: {
          owner: { agentId: finding.assigneeAgentId },
          action:
            'Read the run failures on this issue, then either resume it deliberately or close it with a disposition.',
        },
        comment: escalateBody(finding, flipCount),
      },
    }
  }
  return {
    remedy,
    flipCount,
    expectStatus: 'todo',
    patch: { status: 'todo', comment: flipBody(finding, flipCount, opts.strikeLimit) },
  }
}

export async function applyRemedy(finding, opts, now, transport) {
  const comments = await transport.getComments(finding.id).catch(() => null)
  const plan = planRemedy(finding, comments, opts, now)
  try {
    const updated = await transport.patch(finding.id, plan.patch)
    return {
      ...finding,
      priorFlips: plan.flipCount,
      remedy: plan.remedy,
      ...confirmWrite(updated, plan.expectStatus),
    }
  } catch (error) {
    // Agents cannot name another agent as unblock owner, so the escalating PATCH
    // can be rejected for the descriptor alone. The escalation still has to
    // happen; retry without it and let the comment name the owner instead.
    const retryable = plan.patch.unblockDescriptor && error.status && error.status < 500
    if (!retryable) throw error
    const { unblockDescriptor: _dropped, ...rest } = plan.patch
    const updated = await transport.patch(finding.id, rest)
    return {
      ...finding,
      priorFlips: plan.flipCount,
      remedy: plan.remedy,
      ...confirmWrite(updated, plan.expectStatus),
      ownerInComment: true,
    }
  }
}

function httpTransport(cfg) {
  return {
    getComments: (id) => api(cfg, `/api/issues/${id}/comments?order=asc`),
    patch: (id, body) =>
      api(cfg, `/api/issues/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  }
}

async function confirm(cfg, issue) {
  const [detail, interactions, recovery] = await Promise.all([
    api(cfg, `/api/issues/${issue.id}`),
    api(cfg, `/api/issues/${issue.id}/interactions`).catch(() => null),
    api(cfg, `/api/issues/${issue.id}/recovery-actions`).catch(() => null),
  ])
  return evaluateDeepWakePaths({ detail, interactions, recovery })
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  const cfg = readConfig()
  const now = Date.now()
  const thresholdMs = opts.thresholdHours * 3600_000
  const cutoff = new Date(now - thresholdMs)
  const excludeIds = [...opts.exclude, process.env.PAPERCLIP_TASK_ID].filter(Boolean)
  const screen = {
    statuses: opts.statuses,
    cutoff,
    now,
    thresholdMs,
    excludeIds,
    selfRoutineIds: opts.selfRoutineIds,
  }

  const issues = asList(
    await api(cfg, `/api/companies/${cfg.companyId}/issues?limit=${ISSUE_PAGE_LIMIT}`),
  )
  if (issues.length >= ISSUE_PAGE_LIMIT) {
    process.stderr.write(
      `warning: issue list hit the ${ISSUE_PAGE_LIMIT}-row page limit; the sweep may be incomplete\n`,
    )
  }

  const shallow = issues.filter((issue) => isShallowCandidate(issue, issues, screen))
  const findings = []
  for (const issue of shallow) {
    const detail = await confirm(cfg, issue)
    if (!detail.stranded) continue
    const since = idleSince(issue)
    findings.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      lastActivityAt: since.toISOString(),
      idleHours: Number(((now - since.getTime()) / 3600_000).toFixed(1)),
    })
  }

  const { selected, deferred } = prioritiseFindings(findings, opts.act ? opts.maxActions : Infinity)
  const acted = []
  if (opts.act) {
    const transport = httpTransport(cfg)
    for (const finding of selected) {
      try {
        acted.push(await applyRemedy(finding, opts, now, transport))
      } catch (error) {
        acted.push({ ...finding, ok: false, reason: error.message })
      }
    }
  }

  const report = {
    generatedAt: new Date(now).toISOString(),
    companyId: cfg.companyId,
    thresholdHours: opts.thresholdHours,
    statuses: opts.statuses,
    scanned: issues.length,
    shallowCandidates: shallow.length,
    findings: selected,
    deferredOverCap: deferred.map((f) => f.identifier),
    acted: opts.act ? acted : null,
    mode: opts.act ? 'act' : 'report-only',
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `stranded-issue-sweep [${report.mode}]: scanned ${report.scanned} issues, ` +
        `statuses [${opts.statuses.join(', ')}], threshold ${opts.thresholdHours}h\n`,
    )
    if (findings.length === 0) {
      process.stdout.write('no stranded issues — every candidate has a live wake path\n')
    } else {
      process.stdout.write(`${findings.length} stranded issue(s) with no wake path:\n`)
      for (const f of selected) {
        const done = acted.find((entry) => entry.id === f.id)
        const note = done
          ? done.ok
            ? ` [${done.remedy} ok, ${done.priorFlips} prior flip(s)]`
            : ` [${done.remedy ?? 'remedy'} FAILED: ${done.reason}]`
          : ''
        process.stdout.write(
          `  ${(f.priority ?? '?').padEnd(8)} ${f.identifier.padEnd(8)} ` +
            `${String(f.idleHours).padStart(6)}h idle  ${f.title.slice(0, 50)}${note}\n`,
        )
      }
      if (deferred.length > 0) {
        process.stdout.write(
          `deferred over the ${opts.maxActions}-action cap: ${report.deferredOverCap.join(', ')}\n`,
        )
      }
    }
  }

  if (findings.length > 0 && !opts.exitZero) process.exitCode = 1
}

// Only sweep when invoked as the CLI. The predicates above are imported
// directly by tools/ops-sweep, which must not make a single network call.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`stranded-issue-sweep failed: ${error.message}\n`)
    process.exit(2)
  })
}

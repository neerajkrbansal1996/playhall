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
//   - `monitorNextCheckAt` is null (a monitor IS a wake path)
//   - no open child issue (`issue_children_completed` IS a wake path, so an
//     umbrella/milestone issue with live children is not stranded)
//   - no pending issue-thread interaction (a pending card IS a wake path)
//   - no open blocker edge (`issue_blockers_resolved` IS a wake path; a
//     `cancelled` blocker never fires it, so it does not count)
//   - no active recovery action (the platform already owns it)
//   - last activity is at least --threshold-hours old
//
// Usage:
//   node scripts/ops/stranded-issue-sweep.mjs [options]
//
//   --threshold-hours N   minimum idle age to report (default 2)
//   --status a,b          statuses to sweep (default in_progress)
//   --json                emit machine-readable JSON instead of a table
//   --wake                post a wake comment on each finding (opt-in;
//                         commenting on an `in_progress` issue wakes its
//                         assignee, which is what restarted PER-151's eight)
//   --exit-zero           always exit 0, even with findings
//
// Exit codes: 0 = nothing stranded, 1 = findings (unless --exit-zero),
//             2 = configuration or transport failure.
//
// Environment: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID.
// PAPERCLIP_RUN_ID is sent as X-Paperclip-Run-Id when present.

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
const ISSUE_PAGE_LIMIT = 500

function parseArgs(argv) {
  const opts = {
    thresholdHours: 2,
    statuses: ['in_progress'],
    json: false,
    wake: false,
    exitZero: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--wake') opts.wake = true
    else if (arg === '--exit-zero') opts.exitZero = true
    else if (arg === '--threshold-hours') opts.thresholdHours = Number(argv[++i])
    else if (arg.startsWith('--threshold-hours=')) opts.thresholdHours = Number(arg.split('=')[1])
    else if (arg === '--status') opts.statuses = argv[++i].split(',')
    else if (arg.startsWith('--status=')) opts.statuses = arg.split('=')[1].split(',')
    else {
      process.stderr.write(`unknown argument: ${arg}\n`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(opts.thresholdHours) || opts.thresholdHours < 0) {
    process.stderr.write('--threshold-hours must be a non-negative number\n')
    process.exit(2)
  }
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
  return !run.status || LIVE_RUN_STATUSES.has(run.status)
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

// Cheap, list-only screen. Everything here comes from the single issues list
// call, so it costs no extra requests.
export function isShallowCandidate(issue, allIssues, statuses, cutoff) {
  if (!statuses.includes(issue.status)) return false
  if (issue.hiddenAt) return false
  if (!issue.assigneeAgentId) return false
  if (issue.assigneeUserId) return false
  if (issue.monitorNextCheckAt) return false
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

async function confirm(cfg, issue) {
  const [detail, interactions, recovery] = await Promise.all([
    api(cfg, `/api/issues/${issue.id}`),
    api(cfg, `/api/issues/${issue.id}/interactions`).catch(() => null),
    api(cfg, `/api/issues/${issue.id}/recovery-actions`).catch(() => null),
  ])
  return evaluateDeepWakePaths({ detail, interactions, recovery })
}

async function wake(cfg, finding) {
  const body = [
    '## Stranded work detected',
    '',
    `This issue has been \`${finding.status}\` for ${finding.idleHours}h with no active run, no scheduled`,
    'monitor, no pending interaction and no blocker edge — nothing was going to wake it. This comment is',
    'the wake.',
    '',
    '- Re-read what is already on your branch before redoing work; the previous run may have died',
    '  mid-commit.',
    '- If the work is genuinely finished or obsolete, record that disposition rather than leaving the',
    '  issue `in_progress`.',
    '',
    `Detected by \`scripts/ops/stranded-issue-sweep.mjs\` at ${new Date().toISOString()}.`,
  ].join('\n')
  await api(cfg, `/api/issues/${finding.id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cfg = readConfig()
  const now = Date.now()
  const cutoff = new Date(now - opts.thresholdHours * 3600_000)

  const issues = asList(
    await api(cfg, `/api/companies/${cfg.companyId}/issues?limit=${ISSUE_PAGE_LIMIT}`),
  )
  if (issues.length >= ISSUE_PAGE_LIMIT) {
    process.stderr.write(
      `warning: issue list hit the ${ISSUE_PAGE_LIMIT}-row page limit; the sweep may be incomplete\n`,
    )
  }

  const shallow = issues.filter((issue) => isShallowCandidate(issue, issues, opts.statuses, cutoff))
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
  findings.sort((a, b) => b.idleHours - a.idleHours)

  if (opts.wake) {
    for (const finding of findings) {
      try {
        await wake(cfg, finding)
        finding.woken = true
      } catch (error) {
        finding.woken = false
        finding.wakeError = error.message
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
    findings,
    wakeRequested: opts.wake,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `stranded-issue-sweep: scanned ${report.scanned} issues, ` +
        `statuses [${opts.statuses.join(', ')}], threshold ${opts.thresholdHours}h\n`,
    )
    if (findings.length === 0) {
      process.stdout.write('no stranded issues — every candidate has a live wake path\n')
    } else {
      process.stdout.write(`${findings.length} stranded issue(s) with no wake path:\n`)
      for (const f of findings) {
        const wakeNote = opts.wake ? (f.woken ? ' [woken]' : ` [wake failed: ${f.wakeError}]`) : ''
        process.stdout.write(
          `  ${f.identifier.padEnd(8)} ${String(f.idleHours).padStart(6)}h idle  ` +
            `${f.status.padEnd(12)} ${f.title.slice(0, 60)}${wakeNote}\n`,
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

import { describe, expect, it } from 'vitest'

import {
  SWEEP_FLIP_MARKER,
  SWEEP_SELF_CLOSE_MARKER,
  applyRemedy,
  classifyBlockedWithoutEdges,
  classifyReviewWait,
  closeDeadOwnFires,
  confirmWrite,
  countRecentFlips,
  decideRemedy,
  parseArgs,
  partitionReviewPaths,
  planRemedy,
  evaluateDeepWakePaths,
  hasLiveMonitor,
  hasLiveRun,
  isObservationCandidate,
  isOwnExecutionIssue,
  isShallowCandidate,
  openChildIds,
  prioritiseFindings,
  selectDeadOwnFires,
} from '../../../scripts/ops/stranded-issue-sweep.mjs'

/**
 * `scripts/ops/stranded-issue-sweep.mjs` exists because Paperclip's own recovery
 * classifier missed a batch of eight. On 2026-09-29 PER-49, PER-53, PER-60,
 * PER-63, PER-64, PER-65, PER-66 and PER-67 all died inside one 20:07-20:09Z
 * harness failure and then sat `in_progress` with `activeRun = null`,
 * `monitorNextCheckAt = null` and no blocker edge for ~21 hours. Nothing was
 * scheduled to wake them and they were invisible to the blocker-attention
 * rollups, because `in_progress` is not `blocked`. A Chief of Staff sweep found
 * them by luck.
 *
 * So the bar for this sweep is not "it has plausible logic" — it is "fed the
 * recorded pre-restart state of those eight, it flags all eight". The
 * ELIGIBLE_AT_2026_09_30 fixture below is transcribed from the state PER-151
 * recorded, with the real issue ids, assignee ids and `lastActivityAt` stamps,
 * so the sweep is tested against the incident rather than against shapes
 * invented to match the implementation.
 *
 * The negative cases matter just as much, and each one is a *real* wake path
 * rather than a hypothetical: they are the post-restart states the same eight
 * issues actually reached (a scheduled monitor, a live run, `blocked`,
 * `cancelled`, `done`, `todo`), plus the two false-positive classes that a
 * naive "in_progress with no run" query gets wrong — an umbrella issue whose
 * open children will fire `issue_children_completed`, and an issue handed to a
 * human. A sweep that cries wolf on those gets ignored, which is the same
 * outcome as not having one.
 */

const CTO = 'ba4efbd5-5fb5-4799-a911-d4d065bf3bfc'
const PLATFORM = '97cedc56-c218-4e2d-a8a4-d590cdfe0bfe'

function issue(overrides) {
  return {
    id: overrides.id,
    identifier: overrides.identifier,
    title: overrides.identifier,
    status: 'in_progress',
    priority: 'high',
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    hiddenAt: null,
    monitorNextCheckAt: null,
    activeRun: null,
    originId: null,
    ...overrides,
  }
}

// The eight, exactly as they sat when the Chief of Staff sweep found them.
const ELIGIBLE_AT_2026_09_30 = [
  ['PER-49', 'a14a2c2b-6f2d-4954-80ac-0d1fa1bf399f', PLATFORM, '2026-09-29T20:10:21.990Z'],
  ['PER-53', '606ff3fe-4ed6-4de9-9dbd-ed1f05044f94', PLATFORM, '2026-09-29T20:10:19.883Z'],
  ['PER-60', '071429ad-7d68-4aae-b97a-44c513a11778', CTO, '2026-09-29T20:10:19.887Z'],
  ['PER-63', '5558317a-9622-4fac-b933-285e758f8eb9', CTO, '2026-09-29T20:10:29.905Z'],
  ['PER-64', '953b8dfc-9200-4b5c-9a9e-cad2fb27fc9b', PLATFORM, '2026-09-29T20:10:20.198Z'],
  ['PER-65', '633b815f-f116-488c-985c-390a42bafdff', PLATFORM, '2026-09-29T20:10:29.893Z'],
  ['PER-66', '2b504a9f-8a50-409a-bea9-a32f337d4a24', PLATFORM, '2026-09-29T20:10:19.478Z'],
  ['PER-67', 'f6c38746-563f-43ef-8a72-637bc8a9276b', CTO, '2026-09-29T20:10:29.099Z'],
].map(([identifier, id, assigneeAgentId, lastActivityAt]) =>
  issue({ id, identifier, assigneeAgentId, lastActivityAt }),
)

// The moment the batch was found, ~21.3h after the last of them died.
const DISCOVERY = new Date('2026-09-30T17:30:00.000Z')
const IN_PROGRESS = ['in_progress']

function sweep(all, now = DISCOVERY, thresholdHours = 2, extra = {}) {
  const thresholdMs = thresholdHours * 3600_000
  const screen = {
    statuses: IN_PROGRESS,
    cutoff: new Date(now.getTime() - thresholdMs),
    now: now.getTime(),
    thresholdMs,
    ...extra,
  }
  return all
    .filter((candidate) => isShallowCandidate(candidate, all, screen))
    .map((candidate) => candidate.identifier)
}

describe('the batch the platform classifier missed', () => {
  it('flags all eight from their recorded pre-restart state', () => {
    expect(sweep(ELIGIBLE_AT_2026_09_30)).toEqual([
      'PER-49',
      'PER-53',
      'PER-60',
      'PER-63',
      'PER-64',
      'PER-65',
      'PER-66',
      'PER-67',
    ])
  })

  it('would also have flagged them at the 2h threshold, ~19h before they were found', () => {
    expect(sweep(ELIGIBLE_AT_2026_09_30, new Date('2026-09-29T22:11:00.000Z'))).toHaveLength(8)
  })

  it('does not flag them one hour in, before the 2h threshold', () => {
    expect(sweep(ELIGIBLE_AT_2026_09_30, new Date('2026-09-29T21:10:00.000Z'))).toEqual([])
  })
})

describe('real wake paths are not strandings', () => {
  // PER-67's post-restart state: in_review with a monitor due at 18:10:51Z. The
  // scheduler will re-wake the assignee, so nothing is stranded — and this is the
  // one signal a "no active run" query on its own gets wrong.
  it('a scheduled monitor is a wake path', () => {
    const withMonitor = issue({
      id: 'f6c38746-563f-43ef-8a72-637bc8a9276b',
      identifier: 'PER-67',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-29T20:10:29.099Z',
      monitorNextCheckAt: '2026-09-30T18:10:51.000Z',
    })
    expect(sweep([withMonitor])).toEqual([])
  })

  // PER-65's post-restart state: a live automation run. Idle age is still ~21h
  // because `lastActivityAt` lags, so age alone would flag it.
  it('a live run is a wake path even when lastActivityAt is stale', () => {
    const running = issue({
      id: '633b815f-f116-488c-985c-390a42bafdff',
      identifier: 'PER-65',
      assigneeAgentId: PLATFORM,
      lastActivityAt: '2026-09-29T20:10:29.893Z',
      activeRun: { id: '12abd0d2-81b1-403b-a8d9-a42a3f4e4989', status: 'running' },
    })
    expect(hasLiveRun(running)).toBe(true)
    expect(sweep([running])).toEqual([])
  })

  // The trap the other way round: `activeRun` is non-null but its status is
  // terminal. That is the corpse of the run that died, not a wake path, and
  // treating a non-null `activeRun` as liveness is exactly how the batch of
  // eight stays invisible.
  it('a non-null activeRun in a terminal status is NOT a wake path', () => {
    const dead = issue({
      id: 'a14a2c2b-6f2d-4954-80ac-0d1fa1bf399f',
      identifier: 'PER-49',
      assigneeAgentId: PLATFORM,
      lastActivityAt: '2026-09-29T20:10:21.990Z',
      activeRun: { id: 'dead', status: 'failed' },
    })
    expect(hasLiveRun(dead)).toBe(false)
    expect(sweep([dead])).toEqual(['PER-49'])
  })

  // An umbrella/milestone issue sits `in_progress` for weeks on purpose. Its
  // children reaching a terminal state fires `issue_children_completed` on it,
  // so it has a wake path. Without this, PER-3, PER-6, PER-13, PER-14, PER-38
  // and PER-89 all read as stranded on a live board.
  it('an open child is a wake path for the parent', () => {
    const parent = issue({
      id: 'parent',
      identifier: 'PER-3',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-30T11:00:00.000Z',
    })
    const openChild = issue({
      id: 'child-open',
      identifier: 'PER-6',
      parentId: 'parent',
      status: 'blocked',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-30T11:00:00.000Z',
    })
    expect(openChildIds(parent, [parent, openChild])).toEqual(['child-open'])
    expect(sweep([parent, openChild])).toEqual([])
  })

  it('a parent whose children are all terminal is stranded again', () => {
    const parent = issue({
      id: 'parent',
      identifier: 'PER-3',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-30T11:00:00.000Z',
    })
    const doneChild = issue({
      id: 'child-done',
      identifier: 'PER-6',
      parentId: 'parent',
      status: 'done',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-30T11:00:00.000Z',
    })
    expect(sweep([parent, doneChild])).toEqual(['PER-3'])
  })

  it('an issue handed to a human is not stranded', () => {
    const handedBack = issue({
      id: 'human',
      identifier: 'PER-99',
      assigneeAgentId: null,
      assigneeUserId: 'a-real-person',
      lastActivityAt: '2026-09-28T00:00:00.000Z',
    })
    expect(sweep([handedBack])).toEqual([])
  })

  // PER-66 -> blocked, PER-53 -> cancelled, PER-49 -> done, PER-60 -> todo. Each
  // is a recorded disposition, and none of them is the sweep's business: the
  // default sweep is `in_progress` only.
  it.each(['blocked', 'cancelled', 'done', 'todo', 'in_review', 'backlog'])(
    'does not sweep status %s by default',
    (status) => {
      const other = issue({
        id: `other-${status}`,
        identifier: 'PER-66',
        status,
        assigneeAgentId: PLATFORM,
        lastActivityAt: '2026-09-29T20:10:19.478Z',
      })
      expect(sweep([other])).toEqual([])
    },
  )

  it('a hidden issue is never swept', () => {
    const hidden = issue({
      id: 'hidden',
      identifier: 'PER-98',
      assigneeAgentId: CTO,
      lastActivityAt: '2026-09-28T00:00:00.000Z',
      hiddenAt: '2026-09-29T00:00:00.000Z',
    })
    expect(sweep([hidden])).toEqual([])
  })
})

describe('deep wake paths', () => {
  const none = { detail: { blockedBy: [] }, interactions: [], recovery: { active: null } }

  it('reports stranded when no deep path exists', () => {
    expect(evaluateDeepWakePaths(none).stranded).toBe(true)
  })

  it('an open blocker edge is a wake path', () => {
    const result = evaluateDeepWakePaths({
      ...none,
      detail: { blockedBy: [{ id: 'b', identifier: 'PER-139', status: 'in_progress' }] },
    })
    expect(result.stranded).toBe(false)
    expect(result.openBlockers).toHaveLength(1)
  })

  // `cancelled` blockers do not count as resolved, so `issue_blockers_resolved`
  // can never fire. A cancelled-only blocker list is a dead edge, not a wake
  // path, and an audit that counts it strands the issue silently.
  it('a cancelled blocker edge is NOT a wake path', () => {
    const result = evaluateDeepWakePaths({
      ...none,
      detail: { blockedBy: [{ id: 'b', identifier: 'PER-53', status: 'cancelled' }] },
    })
    expect(result.stranded).toBe(true)
    expect(result.openBlockers).toEqual([])
  })

  it('a done blocker edge is NOT a wake path', () => {
    expect(
      evaluateDeepWakePaths({
        ...none,
        detail: { blockedBy: [{ id: 'b', identifier: 'PER-49', status: 'done' }] },
      }).stranded,
    ).toBe(true)
  })

  it('a pending interaction is a wake path', () => {
    expect(
      evaluateDeepWakePaths({ ...none, interactions: [{ id: 'i', status: 'pending' }] }).stranded,
    ).toBe(false)
  })

  it('an answered interaction is NOT a wake path', () => {
    expect(
      evaluateDeepWakePaths({ ...none, interactions: [{ id: 'i', status: 'answered' }] }).stranded,
    ).toBe(true)
  })

  it('an active recovery action means the platform already owns it', () => {
    expect(
      evaluateDeepWakePaths({
        ...none,
        recovery: { active: { id: 'r', kind: 'stranded_assigned_issue', ownerType: 'board' } },
      }).stranded,
    ).toBe(false)
  })

  // `GET /issues/{id}/recovery-actions` reads `{"active": null, "actions": []}`
  // on the eight -- but it reads the same on PER-2, which recovery-observability
  // does count as a `stranded_assigned_issue` recovery, so an empty read is not
  // by itself evidence of a miss. The sweep treats it as "no live wake path
  // here", which is all it needs to be.
  it('treats an empty recovery-actions payload as no wake path', () => {
    expect(
      evaluateDeepWakePaths({ ...none, recovery: { active: null, actions: [] } }).stranded,
    ).toBe(true)
  })

  it('tolerates a missing interactions or recovery payload', () => {
    expect(
      evaluateDeepWakePaths({ detail: { blockedBy: [] }, interactions: null, recovery: null })
        .stranded,
    ).toBe(true)
  })
})

/**
 * The four corrections Chief of Staff made binding when authorising the routine
 * (PER-155, 2026-09-30T18:09Z). Each one is here because the proposal without it
 * would have been worse than no sweep at all.
 */
describe('monitor exclusion (correction 3)', () => {
  // PER-86's real state at 18:04Z: `critical`, no activeRun, and a monitor due
  // at 20:02:56Z. It has a live path; flipping it destroys a review wait.
  const per86 = issue({
    id: 'e3a6ff2c-per-86',
    identifier: 'PER-86',
    priority: 'critical',
    assigneeAgentId: CTO,
    lastActivityAt: '2026-09-30T14:00:00.000Z',
    monitorNextCheckAt: '2026-09-30T20:02:56.000Z',
  })
  const NOW = new Date('2026-09-30T18:04:00.000Z')

  it('a future monitor excludes an otherwise-qualifying critical issue', () => {
    expect(hasLiveMonitor(per86, NOW.getTime(), 2 * 3600_000)).toBe(true)
    expect(sweep([per86], NOW)).toEqual([])
  })

  it('without the monitor the same issue is a finding — the monitor is what saves it', () => {
    expect(sweep([{ ...per86, monitorNextCheckAt: null }], NOW)).toEqual(['PER-86'])
  })

  // A monitor a few minutes past due is scheduler queue lag, not a dead monitor.
  it('a slightly past-due monitor still counts as live', () => {
    const lagging = { ...per86, monitorNextCheckAt: '2026-09-30T17:50:00.000Z' }
    expect(hasLiveMonitor(lagging, NOW.getTime(), 2 * 3600_000)).toBe(true)
    expect(sweep([lagging], NOW)).toEqual([])
  })

  // Past due by more than the sweep's own threshold: it has demonstrably not
  // fired, and is no more a wake path than a terminal `activeRun` is.
  it('a monitor past due by more than the threshold is not a wake path', () => {
    const dead = { ...per86, monitorNextCheckAt: '2026-09-30T12:00:00.000Z' }
    expect(hasLiveMonitor(dead, NOW.getTime(), 2 * 3600_000)).toBe(false)
    expect(sweep([dead], NOW)).toEqual(['PER-86'])
  })

  it('an unparseable monitor timestamp is treated as live, never flipped', () => {
    expect(hasLiveMonitor({ monitorNextCheckAt: 'not-a-date' }, NOW.getTime(), 0)).toBe(true)
  })
})

describe('the sweep never sweeps itself (correction 3)', () => {
  const routineId = '6d1f0b2e-routine'
  const runIssue = issue({
    id: 'sweep-run-issue',
    identifier: 'PER-200',
    assigneeAgentId: CTO,
    lastActivityAt: '2026-09-30T11:00:00.000Z',
    originId: routineId,
  })

  it('excludes an execution issue created by the sweep routine', () => {
    expect(isOwnExecutionIssue(runIssue, { selfRoutineIds: [routineId] })).toBe(true)
    expect(sweep([runIssue], DISCOVERY, 2, { selfRoutineIds: [routineId] })).toEqual([])
  })

  it('an execution issue from a different routine is still swept', () => {
    expect(sweep([runIssue], DISCOVERY, 2, { selfRoutineIds: ['some-other-routine'] })).toEqual([
      'PER-200',
    ])
  })

  it('excludes explicit ids and identifiers, including the running issue itself', () => {
    expect(sweep([runIssue], DISCOVERY, 2, { excludeIds: ['sweep-run-issue'] })).toEqual([])
    expect(sweep([runIssue], DISCOVERY, 2, { excludeIds: ['PER-200'] })).toEqual([])
  })
})

describe('strike ladder (correction 2)', () => {
  const WINDOW = 24 * 3600_000
  const NOW = new Date('2026-09-30T18:00:00.000Z').getTime()
  const flipAt = (iso) => ({
    body: `${SWEEP_FLIP_MARKER}\n## Stranded work restarted`,
    createdAt: iso,
  })

  it("counts only the sweep's own flip comments", () => {
    const comments = [
      flipAt('2026-09-30T10:00:00.000Z'),
      {
        body: 'An ordinary engineer comment about the branch.',
        createdAt: '2026-09-30T11:00:00.000Z',
      },
      { body: 'Restarting this — please pick it up.', createdAt: '2026-09-30T12:00:00.000Z' },
    ]
    expect(countRecentFlips(comments, NOW, WINDOW)).toBe(1)
  })

  it('ignores flips older than the window', () => {
    const comments = [flipAt('2026-09-28T10:00:00.000Z'), flipAt('2026-09-30T10:00:00.000Z')]
    expect(countRecentFlips(comments, NOW, WINDOW)).toBe(1)
  })

  it('reads the ledger from a paginated items payload', () => {
    expect(countRecentFlips({ items: [flipAt('2026-09-30T10:00:00.000Z')] }, NOW, WINDOW)).toBe(1)
  })

  it('an unreadable comment list reads as zero flips, so the first remedy is a flip', () => {
    expect(countRecentFlips(null, NOW, WINDOW)).toBe(0)
    expect(decideRemedy(0, 2)).toBe('flip')
  })

  // PER-60 is the case that makes this necessary: it was flipped to `todo`, woke
  // via `issue_status_changed`, and died again with `acpx_turn_failed`. 40.8% of
  // runs on this company do. Without the limit the sweep loops forever on the
  // failure it is treating, burning the capacity whose exhaustion causes it.
  it('flips up to the limit, then escalates instead of looping', () => {
    expect(decideRemedy(0, 2)).toBe('flip')
    expect(decideRemedy(1, 2)).toBe('flip')
    expect(decideRemedy(2, 2)).toBe('escalate')
    expect(decideRemedy(3, 2)).toBe('escalate')
  })
})

describe('ordering and cap (correction 4)', () => {
  const finding = (identifier, priority, idleHours) => ({ identifier, priority, idleHours })

  it('orders critical -> high -> medium -> low, then oldest first', () => {
    const { selected } = prioritiseFindings(
      [
        finding('PER-109', 'low', 11.9),
        finding('PER-81', 'medium', 5.4),
        finding('PER-3', 'critical', 6.0),
        finding('PER-13', 'high', 9.0),
        finding('PER-6', 'critical', 8.0),
        finding('PER-137', 'medium', 7.0),
      ],
      10,
    )
    expect(selected.map((f) => f.identifier)).toEqual([
      'PER-6',
      'PER-3',
      'PER-13',
      'PER-137',
      'PER-81',
      'PER-109',
    ])
  })

  // 21 stranded issues were measured at 17:55Z. Restoring all of them in one
  // fire floods a contended shared workspace, which is why the cap exists.
  it('caps the fire at maxActions and reports the rest as deferred', () => {
    const many = Array.from({ length: 21 }, (_, i) => finding(`PER-${i}`, 'medium', 21 - i))
    const { selected, deferred } = prioritiseFindings(many, 10)
    expect(selected).toHaveLength(10)
    expect(deferred).toHaveLength(11)
    expect(selected[0].idleHours).toBe(21)
  })

  it('sorts an unknown priority last rather than dropping it', () => {
    const { selected } = prioritiseFindings(
      [finding('PER-X', undefined, 20), finding('PER-Y', 'low', 1)],
      10,
    )
    expect(selected.map((f) => f.identifier)).toEqual(['PER-Y', 'PER-X'])
  })

  it('does not mutate the input array', () => {
    const input = [finding('PER-A', 'low', 1), finding('PER-B', 'critical', 1)]
    prioritiseFindings(input, 10)
    expect(input.map((f) => f.identifier)).toEqual(['PER-A', 'PER-B'])
  })
})

describe('the remedy (correction 1)', () => {
  const NOW = new Date('2026-09-30T18:00:00.000Z').getTime()
  const OPTS = { strikeLimit: 2, strikeWindowHours: 24 }
  const per60 = {
    id: '071429ad-7d68-4aae-b97a-44c513a11778',
    identifier: 'PER-60',
    status: 'in_progress',
    priority: 'high',
    assigneeAgentId: CTO,
    idleHours: 21.3,
  }

  // The two proven wake mechanisms on this board do not have to be chosen
  // between: `PATCH {status, comment}` is one atomic write carrying both, which
  // also sidesteps the race where flipping to `todo` *after* a comment has taken
  // the execution lock strips that lock.
  it('sends the status change and the audit comment in ONE patch', () => {
    const plan = planRemedy(per60, [], OPTS, NOW)
    expect(plan.remedy).toBe('flip')
    expect(plan.patch.status).toBe('todo')
    expect(plan.patch.comment).toContain('Stranded work restarted')
    expect(plan.patch).not.toHaveProperty('unblockDescriptor')
  })

  // The invariant that makes the ledger work: a flip comment this sweep writes
  // must be counted by the NEXT fire. If the marker and the counter ever drift
  // apart, the strike limit silently stops existing.
  it('a flip comment it writes is counted as a strike by the next fire', () => {
    const first = planRemedy(per60, [], OPTS, NOW)
    const thread = [{ body: first.patch.comment, createdAt: '2026-09-30T18:00:00.000Z' }]
    expect(countRecentFlips(thread, NOW, 24 * 3600_000)).toBe(1)

    const second = planRemedy(per60, thread, OPTS, NOW)
    expect(second.remedy).toBe('flip')
    thread.push({ body: second.patch.comment, createdAt: '2026-09-30T18:30:00.000Z' })

    const third = planRemedy(per60, thread, OPTS, NOW)
    expect(third.remedy).toBe('escalate')
    expect(third.flipCount).toBe(2)
  })

  it('escalates to blocked naming the assignee as unblock owner', () => {
    const thread = [
      { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T10:00:00.000Z' },
      { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T14:00:00.000Z' },
    ]
    const plan = planRemedy(per60, thread, OPTS, NOW)
    expect(plan.patch.status).toBe('blocked')
    expect(plan.patch.unblockDescriptor.owner.agentId).toBe(CTO)
    expect(plan.patch.unblockDescriptor.action).toBeTruthy()
    // The owner must also be legible to a human reading the thread, because the
    // descriptor write is the part the platform can reject.
    expect(plan.patch.comment).toContain(CTO)
  })

  it('an escalation rejected for the descriptor still lands, owner named in the comment', async () => {
    const sent = []
    const transport = {
      getComments: async () => [
        { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T10:00:00.000Z' },
        { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T14:00:00.000Z' },
      ],
      patch: async (id, body) => {
        sent.push(body)
        if (body.unblockDescriptor) {
          const err = new Error('422 agent cannot set another agent as unblock owner')
          err.status = 422
          throw err
        }
        return { id, status: body.status }
      },
    }
    const result = await applyRemedy(per60, OPTS, NOW, transport)
    expect(sent).toHaveLength(2)
    expect(sent[1]).not.toHaveProperty('unblockDescriptor')
    expect(result.ok).toBe(true)
    expect(result.status).toBe('blocked')
    expect(result.ownerInComment).toBe(true)
  })

  it('a rejected FLIP is not retried without its fields — it is reported as failed', async () => {
    const transport = {
      getComments: async () => [],
      patch: async () => {
        const err = new Error('409 conflict')
        err.status = 409
        throw err
      },
    }
    await expect(applyRemedy(per60, OPTS, NOW, transport)).rejects.toThrow('409')
  })

  it('a 5xx on the escalating patch is not swallowed by the descriptor fallback', async () => {
    const transport = {
      getComments: async () => [
        { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T10:00:00.000Z' },
        { body: SWEEP_FLIP_MARKER, createdAt: '2026-09-30T14:00:00.000Z' },
      ],
      patch: async () => {
        const err = new Error('503 upstream')
        err.status = 503
        throw err
      },
    }
    await expect(applyRemedy(per60, OPTS, NOW, transport)).rejects.toThrow('503')
  })

  it('an unreadable comment thread does not stop the remedy — it flips', async () => {
    const transport = {
      getComments: async () => {
        throw new Error('403')
      },
      patch: async (id, body) => ({ id, status: body.status }),
    }
    const result = await applyRemedy(per60, OPTS, NOW, transport)
    expect(result.remedy).toBe('flip')
    expect(result.ok).toBe(true)
  })

  // A 200 can still not persist. The remedy is only ever reported from what the
  // PATCH echoed back, never from the request having returned.
  describe('writes are confirmed by read-back, never inferred', () => {
    it('an empty response body is a FAILED write', () => {
      expect(confirmWrite(null, 'todo')).toEqual({ ok: false, reason: 'empty response body' })
      expect(confirmWrite('', 'todo').ok).toBe(false)
    })

    it('an echoed status that is not what we asked for is a FAILED write', () => {
      const result = confirmWrite({ status: 'in_progress' }, 'todo')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('expected todo')
    })

    it('only the echoed target status counts as success', () => {
      expect(confirmWrite({ status: 'todo' }, 'todo')).toEqual({ ok: true, status: 'todo' })
    })

    it('reports a silently non-persisting patch as failed, not woken', async () => {
      const transport = {
        getComments: async () => [],
        patch: async () => ({ status: 'in_progress' }), // 200, but nothing changed
      }
      const result = await applyRemedy(per60, OPTS, NOW, transport)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('expected todo')
    })
  })
})

describe('argument parsing', () => {
  it('defaults to the authorised report-only sweep: 2h, cap 10, 2 strikes in 24h', () => {
    expect(parseArgs([])).toMatchObject({
      thresholdHours: 2,
      maxActions: 10,
      strikeLimit: 2,
      strikeWindowHours: 24,
      statuses: ['in_progress'],
      act: false,
    })
  })

  // A boolean flag that consumes the next argv entry silently drops it. This
  // bit `--exit-zero`, which the routine depends on: the flag was accepted,
  // ignored, and the sweep still exited 1 on findings.
  it('a boolean flag does not swallow the argument after it', () => {
    const opts = parseArgs(['--json', '--exit-zero', '--threshold-hours', '3'])
    expect(opts.json).toBe(true)
    expect(opts.exitZero).toBe(true)
    expect(opts.thresholdHours).toBe(3)
  })

  it('accepts both --flag value and --flag=value', () => {
    expect(parseArgs(['--max-actions', '5']).maxActions).toBe(5)
    expect(parseArgs(['--max-actions=5']).maxActions).toBe(5)
    expect(parseArgs(['--status=in_progress,in_review']).statuses).toEqual([
      'in_progress',
      'in_review',
    ])
    expect(parseArgs(['--exclude', 'PER-155, PER-2']).exclude).toEqual(['PER-155', 'PER-2'])
  })

  it('rejects malformed input rather than sweeping on a wrong threshold', () => {
    expect(() => parseArgs(['--threshold-hours', 'soon'])).toThrow('non-negative')
    expect(() => parseArgs(['--threshold-hours', '-1'])).toThrow('non-negative')
    expect(() => parseArgs(['--max-actions'])).toThrow('requires a value')
    expect(() => parseArgs(['--json=true'])).toThrow('does not take a value')
    expect(() => parseArgs(['--wake'])).toThrow('unknown argument')
    expect(() => parseArgs(['--status', ''])).toThrow('at least one status')
  })

  it('observes in_review and blocked by default, and never both acts and observes', () => {
    expect(parseArgs([]).observeStatuses).toEqual(['in_review', 'blocked'])
    expect(parseArgs(['--no-observe']).observeStatuses).toEqual([])
    // Widening the ACTING scope must remove the status from the observed set,
    // or an operator reading the report cannot tell which half touched it.
    expect(parseArgs(['--status=in_progress,in_review']).observeStatuses).toEqual(['blocked'])
  })
})

/**
 * PER-199. At the 14h mid-trial read the remedy was proven — 26 findings, 10
 * remedies, 0 false positives, 0 repeat offenders — but the carrier was not: 2
 * of 9 fires completed and seven sat permanently stranded `in_progress`. The
 * sweep was the board's single largest producer of the condition it detects,
 * because `--self-routine-id` stopped it flipping its own fires without ever
 * closing them.
 */
describe('self-close of dead prior fires (PER-199)', () => {
  const ROUTINE = '346b6b5e-dedd-4adb-a3e0-66045f93bbb4'
  const NOW = new Date('2026-10-01T08:18:00.000Z')
  // The seven real fires, with the statuses and ids they actually carried.
  const FIRES = [
    ['PER-186', '7629014f-d3e4-4606-8b54-cabc5345d640', '2026-10-01T07:06:25.379Z'],
    ['PER-187', 'b921a4df-7cc7-4a80-a709-5d4c15b34428', '2026-09-30T20:00:25.757Z'],
    ['PER-192', 'fc4cb3eb-a57a-4349-b378-97287f462e45', '2026-10-01T06:05:25.496Z'],
  ].map(([identifier, id, lastActivityAt]) =>
    issue({ id, identifier, assigneeAgentId: CTO, originId: ROUTINE, lastActivityAt }),
  )

  const screen = { selfRoutineIds: [ROUTINE], now: NOW.getTime(), excludeIds: [] }

  it('selects the dead fires of its own routine', () => {
    expect(selectDeadOwnFires(FIRES, screen).map((f) => f.identifier)).toEqual([
      'PER-186',
      'PER-187',
      'PER-192',
    ])
  })

  it('never closes the fire it is running under', () => {
    const selected = selectDeadOwnFires(FIRES, { ...screen, excludeIds: [FIRES[0].id] })
    expect(selected.map((f) => f.identifier)).toEqual(['PER-187', 'PER-192'])
  })

  // `skip_if_active` should make this impossible, but a fire that has started
  // and not yet registered a run would otherwise look dead to its successor.
  it('leaves a sibling fire inside the grace window alone', () => {
    const justStarted = issue({
      id: 'fresh',
      identifier: 'PER-193',
      assigneeAgentId: CTO,
      originId: ROUTINE,
      lastActivityAt: '2026-10-01T08:15:00.000Z',
    })
    expect(selectDeadOwnFires([justStarted], screen)).toEqual([])
  })

  it('leaves a fire with a live run alone', () => {
    const running = { ...FIRES[1], activeRun: { status: 'running' } }
    expect(selectDeadOwnFires([running], screen)).toEqual([])
  })

  it('never touches a fire of a different routine, or an already-closed one', () => {
    const other = issue({
      id: 'x',
      identifier: 'PER-200',
      assigneeAgentId: CTO,
      originId: 'some-other-routine',
      lastActivityAt: '2026-09-30T01:00:00.000Z',
    })
    const closed = { ...FIRES[2], status: 'done' }
    expect(selectDeadOwnFires([other, closed], screen)).toEqual([])
  })

  it('does nothing at all without --self-routine-id', () => {
    expect(selectDeadOwnFires(FIRES, { ...screen, selfRoutineIds: [] })).toEqual([])
  })

  it('closes each fire with one atomic patch and reports from the read-back', async () => {
    const sent = []
    const transport = {
      patch: async (id, body) => {
        sent.push({ id, body })
        return { id, status: body.status }
      },
    }
    const results = await closeDeadOwnFires(FIRES, NOW.getTime(), transport)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(sent).toHaveLength(3)
    expect(sent[0].body.status).toBe('done')
    expect(sent[0].body.comment).toContain(SWEEP_SELF_CLOSE_MARKER)
  })

  // The sweep reports a remedy only from the echoed status. PER-199 was asked to
  // reproduce an HTTP 500 on this exact PATCH; it did not reproduce from a bound
  // run, but a silently non-persisting write must still read as FAILED.
  it('reports a patch that does not persist as failed, not closed', async () => {
    const transport = { patch: async (id) => ({ id, status: 'in_progress' }) }
    const [result] = await closeDeadOwnFires([FIRES[0]], NOW.getTime(), transport)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('read back status in_progress')
  })

  it('a failing close does not stop the remaining fires being closed', async () => {
    const transport = {
      patch: async (id, body) => {
        if (id === FIRES[0].id) throw new Error('PATCH -> 500')
        return { id, status: body.status }
      },
    }
    const results = await closeDeadOwnFires(FIRES, NOW.getTime(), transport)
    expect(results[0]).toMatchObject({ ok: false })
    expect(results.slice(1).every((r) => r.ok)).toBe(true)
  })
})

/**
 * PER-199, amendment 3. `in_progress` is one of several ways to lose a wake
 * path: 31 of 70 non-terminal issues had none, and the acting scope could see
 * seven. These two classes are reported and never acted on.
 */
describe('report-only observation classes (PER-199)', () => {
  const NOW = new Date('2026-10-01T08:18:00.000Z')
  const THRESHOLD_MS = 2 * 3600_000
  const screen = {
    observeStatuses: ['in_review', 'blocked'],
    cutoff: new Date(NOW.getTime() - THRESHOLD_MS),
    now: NOW.getTime(),
    thresholdMs: THRESHOLD_MS,
  }

  // PER-94, exactly as it read: in_review, agent assignee, no path of any kind,
  // and the platform's own classifier already saying so to nobody.
  const PER_94 = issue({
    id: '94',
    identifier: 'PER-94',
    status: 'in_review',
    priority: 'critical',
    assigneeAgentId: PLATFORM,
    lastActivityAt: '2026-09-30T18:46:01.775Z',
    reviewAttention: { state: 'stalled', paths: [] },
  })

  // PER-157: blocked, zero edges, holding finished work — PR #85 merged as
  // fd00f81 with 15/15 checks green. Invisible to every rollup, because
  // `blocked` reads as a decision someone made.
  const PER_157 = issue({
    id: '157',
    identifier: 'PER-157',
    status: 'blocked',
    priority: 'medium',
    assigneeAgentId: CTO,
    lastActivityAt: '2026-09-30T18:38:39.932Z',
    blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 0 },
  })

  it('PER-157 is a finding: blocked, zero edges, no unblock owner', () => {
    expect(isObservationCandidate(PER_157, [PER_157], screen)).toBe(true)
    const verdict = classifyBlockedWithoutEdges(PER_157, { detail: { blockedBy: [] } })
    expect(verdict).toMatchObject({
      kind: 'blocked_no_blocker_edge',
      edgeCount: 0,
      openBlockerCount: 0,
      unblockOwner: null,
      stalled: true,
    })
  })

  it('a blocked issue with a real open edge is not a finding', () => {
    const detail = { blockedBy: [{ identifier: 'PER-13', status: 'in_progress' }] }
    expect(classifyBlockedWithoutEdges(PER_157, { detail }).stalled).toBe(false)
  })

  // `done` already fired `issue_blockers_resolved`; `cancelled` never will.
  it('a blocked issue whose only edges are terminal is still stranded', () => {
    const detail = {
      blockedBy: [
        { identifier: 'PER-13', status: 'done' },
        { identifier: 'PER-14', status: 'cancelled' },
      ],
    }
    const verdict = classifyBlockedWithoutEdges(PER_157, { detail })
    expect(verdict.stalled).toBe(true)
    expect(verdict.edgeCount).toBe(2)
    expect(verdict.closedEdgeStatuses).toEqual(['done', 'cancelled'])
  })

  // The cheap list-side screen: 11 unresolved edges means blocked on something
  // real, and it never costs a deep fetch.
  it('skips a blocked issue the list already says has unresolved edges', () => {
    const per2 = {
      ...PER_157,
      identifier: 'PER-2',
      blockerAttention: { state: 'needs_attention', unresolvedBlockerCount: 11 },
    }
    expect(isObservationCandidate(per2, [per2], screen)).toBe(false)
  })

  it('PER-94 is a finding, and the sweep agrees with the platform for once', () => {
    expect(isObservationCandidate(PER_94, [PER_94], screen)).toBe(true)
    const verdict = classifyReviewWait(PER_94, {
      detail: PER_94,
      interactions: [],
      now: NOW.getTime(),
      thresholdMs: THRESHOLD_MS,
    })
    expect(verdict).toMatchObject({ stalled: true, platformVerdict: 'stalled', reviewPaths: [] })
  })

  it('a pending interaction is a review path, however long it has waited', () => {
    const verdict = classifyReviewWait(PER_94, {
      detail: PER_94,
      interactions: [{ status: 'pending' }],
      now: NOW.getTime(),
      thresholdMs: THRESHOLD_MS,
    })
    expect(verdict.stalled).toBe(false)
  })

  /**
   * The divergence that nearly made this report lie. PER-121, PER-136 and
   * PER-138 all read `covered` because a wake was enqueued for them — one of
   * them 21 hours earlier, and still unclaimed. The platform counts a queued
   * wake as covering the review the moment it is enqueued and never ages it
   * out, which is the same mistake as reading a terminal `activeRun` as
   * liveness. The sweep already refuses to make that mistake for monitors.
   */
  it('a queued wake unclaimed for 21h is not a review path', () => {
    const per121 = {
      ...PER_94,
      identifier: 'PER-121',
      reviewAttention: {
        state: 'covered',
        paths: [
          {
            kind: 'queued_wake',
            responder: 'Frontend Engineer',
            since: '2026-09-30T11:30:12.698Z',
          },
        ],
      },
    }
    const verdict = classifyReviewWait(per121, {
      detail: per121,
      interactions: [],
      now: NOW.getTime(),
      thresholdMs: THRESHOLD_MS,
    })
    expect(verdict.stalled).toBe(true)
    expect(verdict.platformVerdict).toBe('covered')
    expect(verdict.stalePaths).toEqual([
      { kind: 'queued_wake', responder: 'Frontend Engineer', since: '2026-09-30T11:30:12.698Z' },
    ])
  })

  it('a queued wake from four minutes ago IS a review path', () => {
    const fresh = [{ kind: 'queued_wake', since: '2026-10-01T08:14:00.000Z' }]
    expect(partitionReviewPaths(fresh, NOW.getTime(), THRESHOLD_MS).live).toHaveLength(1)
  })

  // A person taking two days to answer a card is a slow reviewer, not a
  // stranded issue. Ageing out a human-serviced path would destroy a real wait.
  it('human-serviced paths are never aged out', () => {
    const old = [
      { kind: 'interaction', since: '2026-09-25T00:00:00.000Z' },
      { kind: 'approval', since: '2026-09-25T00:00:00.000Z' },
    ]
    const { live, stale } = partitionReviewPaths(old, NOW.getTime(), THRESHOLD_MS)
    expect(live).toHaveLength(2)
    expect(stale).toEqual([])
  })

  it('an unparseable path timestamp is treated as live, never reported', () => {
    const bad = [{ kind: 'queued_wake', since: 'whenever' }]
    expect(partitionReviewPaths(bad, NOW.getTime(), THRESHOLD_MS).stale).toEqual([])
  })

  it('an issue handed to a human is not an observation finding', () => {
    const handed = { ...PER_94, assigneeUserId: 'local-board' }
    expect(isObservationCandidate(handed, [handed], screen)).toBe(false)
  })

  it('a live monitor or a live run keeps an in_review issue out of the report', () => {
    const monitored = { ...PER_94, monitorNextCheckAt: '2026-10-01T09:00:00.000Z' }
    const running = { ...PER_94, activeRun: { status: 'running' } }
    expect(isObservationCandidate(monitored, [monitored], screen)).toBe(false)
    expect(isObservationCandidate(running, [running], screen)).toBe(false)
  })

  // The acting scope and the observed scope must never overlap, or a finding
  // could be flipped by one half and reported by the other.
  it('an in_progress issue is never an observation candidate', () => {
    const inProgress = { ...PER_94, status: 'in_progress' }
    expect(isObservationCandidate(inProgress, [inProgress], screen)).toBe(false)
  })
})

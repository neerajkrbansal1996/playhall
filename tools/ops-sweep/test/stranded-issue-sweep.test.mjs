import { describe, expect, it } from 'vitest'

import {
  evaluateDeepWakePaths,
  hasLiveRun,
  isShallowCandidate,
  openChildIds,
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

function sweep(all, now = DISCOVERY, thresholdHours = 2) {
  const cutoff = new Date(now.getTime() - thresholdHours * 3600_000)
  return all
    .filter((candidate) => isShallowCandidate(candidate, all, IN_PROGRESS, cutoff))
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

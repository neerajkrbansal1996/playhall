import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `scripts/ci/assert-merged-via-pr.mjs` is the whole control on `main`: ADR-0004
 * cannot prevent a direct push on this plan, so the audit is what makes one loud.
 * Nothing regression-tested it, and its behaviour had already been silently
 * narrowed twice by the time PER-130 looked at it.
 *
 * The predicate under test is **arrival**, not PR membership. `GET
 * commits/{sha}/pulls` keeps a commit's association with a merged PR forever —
 * including for a commit the squash threw away, which therefore never reached
 * `main` at all. So a merged association is checked *and then* the commit is
 * required to be `merge_commit_sha` or an ancestor of it.
 *
 * Two cases below are transcribed from live-API measurements against
 * neerajkrbansal1996/playhall on 2026-09-30, with the real shas, because the
 * whole finding was that the two verdicts are indistinguishable on paper:
 *
 *   d79f02e  head of PR #43 before its squash; merge_commit_sha 45aa812
 *            compare d79f02e...45aa812 -> diverged; NOT an ancestor of main
 *            verdict: FAIL — it is not on `main` and must not read as landed
 *
 *   ee460b0  head of PR #56, merged as the *merge commit* 1452723
 *            compare ee460b0...1452723 -> ahead; IS an ancestor of main
 *            verdict: PASS — bare `merge_commit_sha === sha` would false-fail it
 *
 * `GITHUB_API_URL` is honoured by the script, so a loopback server stands in for
 * api.github.com and no case touches the network. The same three shas were also
 * run end-to-end against the real API once, and agreed: d79f02e -> exit 1,
 * 45aa812 -> exit 0, ee460b0 -> exit 0.
 */

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', '..', '..', 'scripts', 'ci', 'assert-merged-via-pr.mjs')

/** Real shas from the measurements in the header, so the fixtures name what was measured. */
const SQUASHED_AWAY_HEAD = 'd79f02e8495fc43c8c7743c71b1bb28f528c0368'
const SQUASH_COMMIT = '45aa812fafdd23b93ba41e2a710851d49c32646c'
const MERGE_COMMIT_PR_HEAD = 'ee460b073deddbbf6f99c4a522aefb1ba94ddb10'
const MERGE_COMMIT = '14527236496d1da706561d3d3f0295b08e228d40'

interface Route {
  status?: number
  body?: unknown
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  summary: string
  /** Every path the fake API was asked for, so "did it even compare?" is assertable. */
  seen: string[]
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
})

async function fakeApi(routes: Record<string, Route>): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.url ?? '')
    const route = request.url === undefined ? undefined : routes[request.url]
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"message":"Not Found"}')
      return
    }
    response.writeHead(route.status ?? 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(route.body ?? null))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, seen }
}

/** A `push` event payload on disk, which is how the script sees `forced`/`before`. */
function eventPayload(payload: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'push-audit-')), 'event.json')
  writeFileSync(file, JSON.stringify(payload))
  return file
}

/**
 * Async on purpose: the fake API runs in *this* process, so `spawnSync` would
 * block the event loop and the script's first `fetch` would never be answered.
 */
async function run(
  sha: string,
  apiUrl: string,
  seen: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const summaryFile = join(mkdtempSync(join(tmpdir(), 'push-audit-')), 'summary.md')
  writeFileSync(summaryFile, '')
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'acme/playhall',
      GITHUB_SHA: sha,
      GITHUB_TOKEN: 'test-token',
      GITHUB_API_URL: apiUrl,
      GITHUB_ACTOR: 'someone',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_STEP_SUMMARY: summaryFile,
      // Overridden rather than inherited, so a real Actions run of this suite
      // cannot leak its own `push` payload — and so the default case is the
      // ordinary fast-forward, not a missing payload.
      GITHUB_EVENT_PATH: eventPayload({ forced: false, before: 'c'.repeat(40) }),
      ...env,
    },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })

  return { status, stdout, stderr, summary: readFileSync(summaryFile, 'utf8'), seen }
}

const pullsPath = (sha: string) => `/repos/acme/playhall/commits/${sha}/pulls`
const commitPath = (sha: string) => `/repos/acme/playhall/commits/${sha}`
const comparePath = (base: string, head: string) => `/repos/acme/playhall/compare/${base}...${head}`

/** A merged PR as the API returns it. */
const mergedPull = (number: number, mergeCommitSha: string | null) => ({
  number,
  merged_at: '2026-09-30T11:13:39Z',
  merge_commit_sha: mergeCommitSha,
})

describe('the commit is the merge commit itself', () => {
  it('passes without asking for a comparison', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/Push audit OK — 45aa812 arrived via merged PR #43\./)
    expect(result.summary).toMatch(/## Push audit/)
    expect(result.seen.some((path) => path.includes('/compare/'))).toBe(false)
  })
})

// The measured finding, asserted rather than described. Verdict: this must FAIL.
describe('a squashed-away PR-head commit (measured: d79f02e, PR #43)', () => {
  it('fails, because PR membership is not arrival', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASHED_AWAY_HEAD)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASHED_AWAY_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(SQUASHED_AWAY_HEAD, SQUASH_COMMIT)]: {
        body: { status: 'diverged', ahead_by: 13, behind_by: 3 },
      },
    })

    const result = await run(SQUASHED_AWAY_HEAD, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Unreviewed push to main/)
    expect(result.stderr).toMatch(/did not arrive on this ref through it/)
    // The evidence has to be in the annotation, or nobody can act on it.
    expect(result.stderr).toMatch(/#43 \(merged as 45aa812, compare: diverged\)/)
    expect(result.summary).toMatch(/## Unreviewed push to `main`/)
  })

  it('would have passed under the old membership-only predicate', async () => {
    // Pins *why* this file exists: the association the old predicate read is
    // present and merged. Only the comparison distinguishes the two verdicts.
    const api = await fakeApi({
      [pullsPath(SQUASHED_AWAY_HEAD)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASHED_AWAY_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(SQUASHED_AWAY_HEAD, SQUASH_COMMIT)]: { body: { status: 'diverged' } },
    })

    const result = await run(SQUASHED_AWAY_HEAD, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.seen).toContain(comparePath(SQUASHED_AWAY_HEAD, SQUASH_COMMIT))
  })
})

// The false-failure the strict one-liner would cause, also measured. Verdict: PASS.
describe('a non-tip commit of a merge-committed PR (measured: ee460b0, PR #56)', () => {
  it('passes, because it is an ancestor of the merge commit', async () => {
    const api = await fakeApi({
      [pullsPath(MERGE_COMMIT_PR_HEAD)]: { body: [mergedPull(56, MERGE_COMMIT)] },
      [commitPath(MERGE_COMMIT_PR_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(MERGE_COMMIT_PR_HEAD, MERGE_COMMIT)]: {
        body: { status: 'ahead', ahead_by: 9, behind_by: 0 },
      },
    })

    const result = await run(MERGE_COMMIT_PR_HEAD, api.url, api.seen)

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/arrived via merged PR #56\./)
  })

  it('passes on a tag pointing at it, which is where equality would bite hardest', async () => {
    // `release.yml` audits the *tagged* commit, and a tag can point at a non-tip
    // commit of a rebase- or merge-committed PR. Equality would turn a correct
    // production cut red.
    const api = await fakeApi({
      [pullsPath(MERGE_COMMIT_PR_HEAD)]: { body: [mergedPull(56, MERGE_COMMIT)] },
      [commitPath(MERGE_COMMIT_PR_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(MERGE_COMMIT_PR_HEAD, MERGE_COMMIT)]: { body: { status: 'ahead' } },
    })

    const result = await run(MERGE_COMMIT_PR_HEAD, api.url, api.seen, {
      GITHUB_REF: 'refs/tags/v0.1.0',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/arrived via merged PR #56\./)
  })

  it('treats an identical comparison as arrival', async () => {
    const api = await fakeApi({
      [pullsPath(MERGE_COMMIT_PR_HEAD)]: { body: [mergedPull(56, MERGE_COMMIT)] },
      [commitPath(MERGE_COMMIT_PR_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(MERGE_COMMIT_PR_HEAD, MERGE_COMMIT)]: { body: { status: 'identical' } },
    })

    expect((await run(MERGE_COMMIT_PR_HEAD, api.url, api.seen)).status).toBe(0)
  })

  it('rejects `behind`, which means the merge commit is an ancestor of this one', async () => {
    const api = await fakeApi({
      [pullsPath(MERGE_COMMIT_PR_HEAD)]: { body: [mergedPull(56, MERGE_COMMIT)] },
      [commitPath(MERGE_COMMIT_PR_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(MERGE_COMMIT_PR_HEAD, MERGE_COMMIT)]: { body: { status: 'behind' } },
    })

    const result = await run(MERGE_COMMIT_PR_HEAD, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/compare: behind/)
  })
})

describe('more than one merged PR is associated', () => {
  it('passes on the one it actually arrived via, not on the count', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: {
        body: [mergedPull(43, SQUASH_COMMIT), mergedPull(99, MERGE_COMMIT)],
      },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(SQUASH_COMMIT, MERGE_COMMIT)]: { body: { status: 'diverged' } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/arrived via merged PR #43\./)
    expect(result.stdout).not.toMatch(/#99/)
  })
})

describe('no merged PR at all', () => {
  it('fails on the ordinary careless direct push', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/is not reachable from any merged pull request/)
    expect(result.stderr).toMatch(/pushed by @someone/)
  })

  it('names the associated but unmerged PRs so the fix is obvious', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [{ number: 7, merged_at: null }] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    expect((await run(SQUASH_COMMIT, api.url, api.seen)).stderr).toMatch(
      /Associated but unmerged: #7\./,
    )
  })
})

describe('a forced push to `main`', () => {
  it('is reported even when the arrival check passes', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: eventPayload({ forced: true, before: 'c'.repeat(40) }),
    })

    // Arrival passed and the run still fails: the two facts are independent.
    expect(result.stdout).toMatch(/Push audit OK/)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Force-push to main/)
    expect(result.stderr).toMatch(/previously pointed at cccccccc/)
    expect(result.summary).toMatch(/## Force-push to `main`/)
  })

  it('is reported even on the root-commit exemption, which otherwise exits 0', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: eventPayload({ forced: true, before: 'c'.repeat(40) }),
    })

    expect(result.stdout).toMatch(/is the root commit/)
    expect(result.status).toBe(1)
  })

  it('reports an unknown previous tip rather than crashing when `before` is absent', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: eventPayload({ forced: true }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/previously pointed at unknown/)
  })
})

describe('an ordinary fast-forward push', () => {
  it('passes, and says nothing about a force-push', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: eventPayload({ forced: false, before: 'c'.repeat(40) }),
    })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toMatch(/Force-push/)
    expect(result.stdout).not.toMatch(/Force-push check skipped/)
  })
})

describe('an unreadable `push` event payload', () => {
  // A warning, not a failure: the arrival predicate independently catches the
  // same residual path, so failing here would trade a real detection for a false
  // one. Pinned so the choice is deliberate rather than accidental.
  it('warns and still decides the arrival question', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: join(tmpdir(), 'push-audit-does-not-exist', 'event.json'),
    })

    expect(result.stdout).toMatch(/::warning title=Force-push check skipped/)
    expect(result.status).toBe(0)
  })

  it('warns when the payload carries no `forced` field', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_PATH: eventPayload({ ref: 'refs/heads/main' }),
    })

    expect(result.stdout).toMatch(/::warning title=Force-push check skipped/)
    expect(result.status).toBe(0)
  })

  it('does not look for `forced` on a tag, where the field is meaningless', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, { GITHUB_REF: 'refs/tags/v0.1.0' })

    expect(result.stdout).not.toMatch(/Force-push check skipped/)
    expect(result.status).toBe(0)
  })
})

describe('the audit fails closed', () => {
  it('fails when the pulls lookup errors, rather than passing', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { status: 502, body: { message: 'bad gateway' } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Push audit could not run/)
    expect(result.stderr).toMatch(/inconclusive, which is itself a failure/)
  })

  it('fails when the comparison errors, because arrival is then unproven', async () => {
    const api = await fakeApi({
      [pullsPath(MERGE_COMMIT_PR_HEAD)]: { body: [mergedPull(56, MERGE_COMMIT)] },
      [commitPath(MERGE_COMMIT_PR_HEAD)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
      [comparePath(MERGE_COMMIT_PR_HEAD, MERGE_COMMIT)]: { status: 500, body: { message: 'boom' } },
    })

    const result = await run(MERGE_COMMIT_PR_HEAD, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/would not compare/)
    expect(result.stderr).toMatch(/cannot tell arrival from mere PR membership/)
  })

  it('fails when a merged PR carries no `merge_commit_sha` to compare against', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, null)] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/compare: no merge_commit_sha/)
  })
})

describe('scope and configuration', () => {
  it('exempts the root commit, which can never have a PR', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/is the root commit/)
  })

  it('reports not applicable on a ref that deploys nothing', async () => {
    const api = await fakeApi({})

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REF: 'refs/pull/64/merge',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/Push audit not applicable/)
    expect(result.seen).toEqual([])
  })

  it('audits a tag whatever the event, including workflow_dispatch', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/tags/v0.1.0',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Unreviewed push to main/)
  })

  it('exits 2 when the event environment is missing, rather than inferring exempt', async () => {
    const api = await fakeApi({})

    const result = await run(SQUASH_COMMIT, api.url, api.seen, {
      GITHUB_EVENT_NAME: '',
      GITHUB_REF: '',
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/GITHUB_EVENT_NAME and GITHUB_REF are both required/)
  })

  it('exits 2 when the API credentials are missing', async () => {
    const api = await fakeApi({})

    const result = await run(SQUASH_COMMIT, api.url, api.seen, { GITHUB_TOKEN: '' })

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN are all required/)
  })

  it('reports an unknown actor rather than crashing when GITHUB_ACTOR is unset', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [] },
      [commitPath(SQUASH_COMMIT)]: { body: { parents: [{ sha: 'b'.repeat(40) }] } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen, { GITHUB_ACTOR: '' })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/pushed by @unknown/)
  })

  it('still decides when the commit lookup fails but arrival is proven', async () => {
    const api = await fakeApi({
      [pullsPath(SQUASH_COMMIT)]: { body: [mergedPull(43, SQUASH_COMMIT)] },
      [commitPath(SQUASH_COMMIT)]: { status: 500, body: { message: 'boom' } },
    })

    const result = await run(SQUASH_COMMIT, api.url, api.seen)

    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/arrived via merged PR #43\./)
  })
})

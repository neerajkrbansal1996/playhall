import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * PER-236. `scripts/ci/gate.mjs` reports a gate whose root script does not exist
 * yet as PENDING and exits 0 — by design, so the pipeline's shape can land before
 * every implementation. GitHub then records `result: success`, which is exactly
 * what it records for a gate that ran and passed.
 *
 * Everything downstream read `toJSON(needs)` alone, so it could not tell the two
 * apart. On PR #114 that rendered `coverage` and `integration` as `✅ pass` under
 * the footer "All gates passed." while neither ran anything — a reviewer reading
 * the artefact ADR-0004 Decision 2 exists to produce was told the >= 80% floors
 * held when nothing had checked them.
 *
 * These cases pin the contract that fixes it: the PENDING state reaches the PR
 * comment with its owner, and the footer cannot claim a clean sweep while a
 * placeholder is in the table. They spawn the real scripts against a scratch repo
 * root — the same pattern as `gate-runner.test.ts`, and for the same reason:
 * `gate-report.mjs` derives the repo root from its own file URL, so no test seam
 * is added to the production script.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const ciScripts = join(repoRoot, 'scripts', 'ci')

/** Every gate job on `main`, all reporting success — the PR #114 situation. */
const ALL_SUCCESS = Object.fromEntries(
  [
    'pr-hygiene',
    'workflows',
    'lint',
    'format',
    'typecheck',
    'boundaries',
    'bundle',
    'unit',
    'coverage',
    'testkit',
    'integration',
    'e2e',
  ].map((job) => [job, { result: 'success' }]),
)

/**
 * Builds a scratch repo root holding the four real CI scripts and a
 * `package.json` with exactly the given root scripts.
 */
function scratchRepo(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-report-'))
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true })
  for (const file of ['gates.mjs', 'gate.mjs', 'gate-report.mjs', 'assert-gates.mjs']) {
    copyFileSync(join(ciScripts, file), join(root, 'scripts', 'ci', file))
  }
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'scratch', private: true, scripts }, null, 2)}\n`,
  )
  return root
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(
  root: string,
  script: 'gate-report.mjs' | 'assert-gates.mjs',
  args: string[],
  env: Record<string, string>,
): RunResult {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'ci', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_STRICT_GATES: '',
      GITHUB_STEP_SUMMARY: '',
      GATE_SHA: 'b1a4cf3',
      GATE_RUN_URL: 'https://github.com/o/r/actions/runs/1',
      ...env,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The PR comment body for a given `needs` payload and set of root scripts. */
function prComment(
  scripts: Record<string, string>,
  needs: object,
  env: Record<string, string> = {},
) {
  const root = scratchRepo(scripts)
  const { status, stdout } = run(root, 'gate-report.mjs', ['--format=pr'], {
    GATE_RESULTS: JSON.stringify(needs),
    ...env,
  })
  expect(status).toBe(0)
  return stdout
}

/**
 * The footer sentence — the claim PER-236 is actually about.
 *
 * Asserted separately from the body because the comment ends with a standing
 * legend that explains both the `skipped` and `pending` markers, so a bare
 * `not.toContain('pending')` over the whole body matches that legend and says
 * nothing about the verdict. Layout: `… rows, '', footer, '', legend`.
 */
function footerOf(body: string): string {
  return body.trimEnd().split('\n').at(-3) ?? ''
}

/** True for a YAML line that sets `ref:`, at any indent. Not `ref` in prose. */
function declaresRef(line: string): boolean {
  return /^\s*ref:/.test(line)
}

/**
 * Every two-space key in the workflow that opens a block of its own. Mostly
 * jobs; `on:`'s triggers come along too, which is harmless because callers
 * filter on what the block contains rather than trusting the name.
 */
function jobNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}([a-z][\w-]*):$/gm)].flatMap((m) => m[1] ?? [])
}

/**
 * The body of one top-level job in a workflow, as lines — everything under
 * `  <job>:` up to the next key at the same two-space indent.
 */
function jobBlock(yaml: string, job: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`  ${job}:`)
  if (start === -1) throw new Error(`could not locate the \`${job}:\` job in ci.yml`)
  const body = lines.slice(start + 1)
  const end = body.findIndex((line) => /^ {2}\S/.test(line))
  return end === -1 ? body : body.slice(0, end)
}

/**
 * The lines of the single step inside `block` that mentions `needle`, `with:`
 * block included — found by walking back to the `- ` that opens the step and
 * forward to the one that opens the next.
 */
function stepContaining(block: string[], needle: string): string[] {
  const isStepStart = (line: string) => /^ {6}- /.test(line)
  const hit = block.findIndex((line) => line.includes(needle))
  if (hit === -1) throw new Error(`no step in the job mentions \`${needle}\``)
  let start = hit
  while (start > 0 && !isStepStart(block[start] ?? '')) start -= 1
  const end = block.slice(start + 1).findIndex(isStepStart)
  return end === -1 ? block.slice(start) : block.slice(start, start + 1 + end)
}

/** Root scripts as `main` has them: `test:coverage` and `test:integration` absent. */
const MAIN_SCRIPTS = {
  lint: 'true',
  'format:check': 'true',
  typecheck: 'true',
  test: 'true',
  boundaries: 'true',
  'check:bundle-zod-free': 'true',
  'test:testkit': 'true',
  'test:e2e': 'true',
}

describe('a PENDING gate in the PR comment', () => {
  it('is visually distinct from a gate that ran, and names its owner', () => {
    const body = prComment(MAIN_SCRIPTS, ALL_SUCCESS)

    // The regression: these two rows used to be byte-identical to `lint`'s.
    expect(body).toContain('| `coverage` | ⏸ pending')
    expect(body).toContain('| `integration` | ⏸ pending')
    expect(body).toContain('| `lint` | ✅ pass |')
    expect(body).not.toContain('| `coverage` | ✅ pass |')
    expect(body).not.toContain('| `integration` | ✅ pass |')

    // The owner string is the actionable half — a pending gate with no named
    // issue is indistinguishable from one nobody is going to write.
    expect(body).toContain('owner: PER-89')
    expect(body).toContain('owner: M1 —')
  })

  it('cannot leave the footer reading "All gates passed."', () => {
    const body = prComment(MAIN_SCRIPTS, ALL_SUCCESS)

    expect(body).not.toContain('All gates passed.')
    expect(footerOf(body)).toContain('2 of 12 ran nothing')
  })

  it('says "All gates passed." once the placeholders land their scripts', () => {
    // The other half of the contract: the new state must not be sticky. The day
    // PER-89 adds `test:coverage`, this comment has to go back to a clean sweep
    // with no edit to the renderer.
    const body = prComment(
      { ...MAIN_SCRIPTS, 'test:coverage': 'true', 'test:integration': 'true' },
      ALL_SUCCESS,
    )

    expect(footerOf(body)).toBe('All gates passed.')
    expect(body).toContain('| `coverage` | ✅ pass |')
    expect(body).not.toContain('⏸ pending')
  })

  it('does not mask a real failure', () => {
    const body = prComment(MAIN_SCRIPTS, {
      ...ALL_SUCCESS,
      lint: { result: 'failure' },
    })

    // A failing gate outranks the pending notice: the footer must keep pointing
    // at the thing that is actually broken.
    expect(body).toContain('| `lint` | ❌ FAIL |')
    expect(footerOf(body)).toContain('1 gate(s) not passing')
    expect(footerOf(body)).not.toContain('ran nothing')
    // The placeholder is still labelled honestly in the table; it just is not
    // what the footer leads with.
    expect(body).toContain('| `coverage` | ⏸ pending')
  })

  it('lets the reported result win when it contradicts the registry', () => {
    // The re-derivation is how the run's silence about PENDING is recovered, not
    // a second opinion about whether the job passed. A gate the registry calls
    // pending that somehow reported `failure` is a failure.
    const body = prComment(MAIN_SCRIPTS, { coverage: { result: 'failure' } })

    expect(body).toContain('| `coverage` | ❌ FAIL |')
    expect(body).not.toContain('pending —')
  })

  it('still treats a stray skipped job as a failure', () => {
    // Unchanged behaviour, re-pinned here because the renderer moved: `skipped`
    // is "not failed" to GitHub, so a job given an `if:` that never matches
    // would otherwise stop gating behind a green required check.
    const body = prComment(MAIN_SCRIPTS, {
      'pr-hygiene': { result: 'skipped' },
      lint: { result: 'skipped' },
    })

    expect(body).toContain('| `pr-hygiene` | ✅ skipped |')
    expect(body).toContain('| `lint` | ❌ skipped |')
  })
})

describe('CI_STRICT_GATES is not an input to the report', () => {
  // PER-263. `CI_STRICT_GATES=1` belongs on the *gate* jobs' env — that is what
  // `gate.mjs`'s header instructs, and it is what makes a placeholder exit 1.
  // `ci-gate` is a different job environment. The report used to read the
  // variable out of its own env and pass it to `classifyGate`, where `strict`
  // replaces the `pending` state with `missing`, so setting it on the aggregate
  // job alone suppressed every `⏸ pending` row while the placeholder gate jobs
  // went on exiting 0 — PER-236's defect, restored verbatim, at the exact moment
  // PER-98 was supposed to be closing it.
  //
  // The flag never earned anything here. Under real strict mode the placeholder
  // *job* fails, so `needs.<job>.result` is `failure` and the raw result decides
  // the row before the registry is consulted. It only changed the output in a
  // state production cannot reach, and in the misconfigured one it lied.

  it('does not suppress the pending rows when only the aggregate job can see it', () => {
    const body = prComment(MAIN_SCRIPTS, ALL_SUCCESS, { CI_STRICT_GATES: '1' })

    expect(body).toContain('| `coverage` | ⏸ pending')
    expect(body).toContain('| `integration` | ⏸ pending')
    expect(body).not.toContain('| `coverage` | ✅ pass |')
    expect(footerOf(body)).toContain('2 of 12 ran nothing')
  })

  it('renders a byte-identical table whatever the variable says', () => {
    // Stronger than checking each value against `⏸ pending`: nothing about the
    // comment may vary with an environment the gate jobs did not share.
    const baseline = prComment(MAIN_SCRIPTS, ALL_SUCCESS)
    for (const value of ['0', '1', 'true', 'yes', '']) {
      const body = prComment(MAIN_SCRIPTS, ALL_SUCCESS, { CI_STRICT_GATES: value })
      expect(body, `CI_STRICT_GATES=${value}`).toBe(baseline)
    }
  })

  it('renders a placeholder as FAIL from the result strict mode actually produces', () => {
    // The real strict contract, asserted from the state production reaches.
    // With the variable on the gate jobs, `gate.mjs` classifies `coverage` as
    // `missing` and exits 1, so GitHub records `failure` — and that is what has
    // to reach the table. `success` under strict is not a thing; the old case
    // fed the renderer one and so proved nothing about PER-98's switch.
    const body = prComment(
      MAIN_SCRIPTS,
      { ...ALL_SUCCESS, coverage: { result: 'failure' }, integration: { result: 'failure' } },
      { CI_STRICT_GATES: '1' },
    )

    expect(body).toContain('| `coverage` | ❌ FAIL |')
    expect(body).toContain('| `integration` | ❌ FAIL |')
    expect(body).not.toContain('⏸ pending')
    expect(footerOf(body)).toContain('2 gate(s) not passing')
  })
})

describe('the ci-gate verdict', () => {
  it('still exits 0 with placeholders present, and says so', () => {
    // Deliberate: failing here instead of under CI_STRICT_GATES would take every
    // PR red today. PER-236 changes what the evidence says, not what blocks a
    // merge.
    const root = scratchRepo(MAIN_SCRIPTS)
    const { status, stdout } = run(root, 'assert-gates.mjs', [], {
      GATE_RESULTS: JSON.stringify(ALL_SUCCESS),
    })

    expect(status).toBe(0)
    expect(stdout).toContain('PENDING (ran nothing)')
    expect(stdout).toContain('10 of 12 gates passed; 2 pending.')
    // The Actions log must not contradict the PR comment.
    expect(stdout).not.toContain('all 12 gates passed')
  })

  it('exits 1 on a real failure', () => {
    const root = scratchRepo(MAIN_SCRIPTS)
    const { status, stderr } = run(root, 'assert-gates.mjs', [], {
      GATE_RESULTS: JSON.stringify({ ...ALL_SUCCESS, lint: { result: 'failure' } }),
    })

    expect(status).toBe(1)
    expect(stderr).toContain('Gates did not pass — lint: failure')
  })

  it('refuses to report success on an empty or absent needs payload', () => {
    const root = scratchRepo(MAIN_SCRIPTS)

    const empty = run(root, 'assert-gates.mjs', [], { GATE_RESULTS: '{}' })
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('No gates reported')

    const absent = run(root, 'assert-gates.mjs', [], { GATE_RESULTS: '' })
    expect(absent.status).toBe(2)
    expect(absent.stderr).toContain('GATE_RESULTS is not set')
  })
})

describe('the workflow posts what the renderer rendered', () => {
  const source = () => readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')

  it('builds the comment body with gate-report.mjs rather than inline JS', () => {
    // The defect's root cause was two implementations of the same verdict — the
    // table in `assert-gates.mjs` and a near-copy inlined in the workflow. If a
    // future edit re-inlines the row rendering, this fails.
    const yaml = source()
    expect(yaml).toContain('node scripts/ci/gate-report.mjs --format=pr')
    expect(yaml).not.toContain("const icon = { success: 'pass'")
    expect(yaml).not.toMatch(/const skipAllowed = new Set/)
    expect(yaml).not.toContain("'All gates passed.'")
  })

  it('checks out the bytes the gates ran on, with no `ref:` anywhere', () => {
    // PER-263. The whole design re-derives each gate's state from *this*
    // checkout's `package.json` instead of plumbing a status out of every gate
    // job — which is sound only because `ci-gate` reads the same bytes the gate
    // jobs read. A checkout step with no `ref:` resolves to `github.sha`, and
    // that is fixed for the entire workflow run. Give any of these a `ref:`, or
    // point one at a branch, and the aggregate job starts reporting on a tree
    // the gates never ran, with nothing else in the repo to notice.
    //
    // Asserted on both sides, not just `ci-gate`: the property is that the two
    // agree, and pinning one end leaves the other free to move.
    const yaml = source()

    // `jobBlock` throws on an absent job, so renaming `ci-gate` cannot make
    // this case quietly stop covering it. A second checkout step would be a
    // second tree in the same job, which the per-step scan below cannot see.
    const ciGate = jobBlock(yaml, 'ci-gate')
    expect(ciGate.filter((line) => line.includes('actions/checkout@'))).toHaveLength(1)

    const checkedOut = jobNames(yaml).filter((job) =>
      jobBlock(yaml, job).some((line) => line.includes('actions/checkout@')),
    )
    expect(checkedOut).toContain('ci-gate')
    // Every gate job, plus the aggregate one: a dozen-odd jobs, not a lucky two.
    expect(checkedOut.length).toBeGreaterThan(5)
    for (const job of checkedOut) {
      const step = stepContaining(jobBlock(yaml, job), 'actions/checkout@')
      expect(step.filter(declaresRef), `${job} checkout`).toEqual([])
    }
  })

  it('reads the comment marker back off the rendered body', () => {
    // The marker is what the post step matches on to *update* its own comment.
    // A second copy of the literal in the workflow that drifted from
    // `COMMENT_MARKER` would stop matching and append a fresh table to every PR
    // on every run, which is a noisier version of the same class of bug.
    const yaml = source()
    expect(yaml).toContain('marker=$(head -n 1 "$body")')
    expect(yaml).toContain('GATE_MARKER: ${{ steps.gate-table.outputs.marker }}')
    expect(yaml).not.toContain('<!-- playhall-ci-gate -->')
  })

  it('renders the marker on the first line, where the workflow reads it', () => {
    const body = prComment(MAIN_SCRIPTS, ALL_SUCCESS)
    expect(body.split('\n')[0]).toBe('<!-- playhall-ci-gate -->')
  })

  it('guards the post step on the render actually having succeeded', () => {
    // Both steps are `continue-on-error`, so `conclusion` is always `success` and
    // only `outcome` distinguishes a rendered body from a missing file. Posting
    // unconditionally would throw ENOENT inside github-script instead.
    expect(source()).toContain("steps.gate-table.outcome == 'success'")
  })
})

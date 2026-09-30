import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `scripts/ci/gate.mjs` is the one place that decides whether a CI gate ran, was
 * legitimately not written yet, or silently stopped gating. Nothing tested it.
 *
 * It matters most for the switch this package is named after: `CI_STRICT_GATES=1`
 * (PER-98) turns a PENDING gate into a hard failure at M1 close. Proving that
 * branch here means the flip is a one-line `env` addition whose behaviour is
 * already known, instead of a change whose first evidence is a red pipeline.
 *
 * Each case builds a scratch repo root — a `package.json` with exactly the
 * scripts under test, plus a copy of the real `gate.mjs` at the same relative
 * path — because `gate.mjs` derives its repo root from its own file URL. No test
 * seam is added to the production script.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const realGate = join(repoRoot, 'scripts', 'ci', 'gate.mjs')

const tmpRoots: string[] = []

afterEach(() => {
  // Left in place deliberately on failure would be nicer, but vitest gives no
  // per-test verdict here; the OS reaps tmpdir and each root is a few KB.
  tmpRoots.length = 0
})

/** Builds a scratch repo root containing `scripts/ci/gate.mjs` and the given root scripts. */
function scratchRepo(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ci-gate-'))
  tmpRoots.push(root)
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true })
  copyFileSync(realGate, join(root, 'scripts', 'ci', 'gate.mjs'))
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
  /** What the gate appended to `GITHUB_STEP_SUMMARY`. */
  summary: string
}

function runGate(
  root: string,
  gateName: string | undefined,
  env: Record<string, string> = {},
): RunResult {
  const summaryFile = join(root, 'step-summary.md')
  writeFileSync(summaryFile, '')
  const args = [join(root, 'scripts', 'ci', 'gate.mjs')]
  if (gateName !== undefined) args.push(gateName)
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI_STRICT_GATES: '', GITHUB_STEP_SUMMARY: summaryFile, ...env },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    summary: readFileSync(summaryFile, 'utf8'),
  }
}

describe('a gate whose owning issue has not landed the script yet', () => {
  it('passes, and says who owns it', () => {
    const root = scratchRepo({ lint: 'true' })
    const { status, stdout, summary } = runGate(root, 'coverage')

    expect(status).toBe(0)
    expect(stdout).toContain('::notice title=CI gate pending')
    expect(stdout).toContain('no root script "test:coverage"')
    // The owner is the whole point of the PENDING branch: a pending gate with no
    // named issue is indistinguishable from one nobody is going to write.
    expect(stdout).toContain('PER-89')
    expect(summary).toContain('PENDING **coverage**')
  })

  it('fails under CI_STRICT_GATES=1', () => {
    const root = scratchRepo({ lint: 'true' })
    const { status, stderr } = runGate(root, 'coverage', { CI_STRICT_GATES: '1' })

    expect(status).toBe(1)
    expect(stderr).toContain('::error title=CI gate missing')
    expect(stderr).toContain('CI_STRICT_GATES=1')
  })

  it('ignores any CI_STRICT_GATES value other than exactly "1"', () => {
    // `=== '1'` is deliberate, but it is the kind of comparison someone
    // "helpfully" loosens to truthiness later. `CI_STRICT_GATES=0` reading as
    // strict would be a surprise; `=true` silently not being strict would be a
    // worse one, so pin the contract rather than the implementation's mood.
    const root = scratchRepo({ lint: 'true' })
    for (const value of ['0', 'true', 'yes', '']) {
      expect(runGate(root, 'coverage', { CI_STRICT_GATES: value }).status).toBe(0)
    }
  })
})

describe('a gate declared live whose root script has gone missing', () => {
  it('fails hard, and CI_STRICT_GATES gets no say', () => {
    // The demotion case: rename the root `lint` script and the old behaviour was
    // PENDING with "owner: unassigned" and exit 0 — `ci-gate` green while lint no
    // longer ran. Asserted in both modes, because the whole point is that this
    // one does not wait for the strict switch.
    const root = scratchRepo({ 'format:check': 'true' })
    for (const strict of ['', '1']) {
      const { status, stderr } = runGate(root, 'lint', { CI_STRICT_GATES: strict })
      expect(status).toBe(1)
      expect(stderr).toContain('::error title=CI gate demoted')
      expect(stderr).toContain('renamed or deleted rather than not written yet')
    }
  })
})

describe('an unknown gate name', () => {
  it('exits 2 rather than passing as pending', () => {
    const root = scratchRepo({ lint: 'true' })
    const { status, stderr } = runGate(root, 'lnit')

    expect(status).toBe(2)
    expect(stderr).toContain('Unknown CI gate "lnit"')
  })

  it('exits 2 for an inherited Object property', () => {
    // Regression guard for the `Object.hasOwn` fix. A plain `GATES[name]` lookup
    // resolves `constructor` / `toString` up the prototype chain; the truthy
    // result then reads `gate.script` as undefined, lands in the PENDING branch
    // and passes forever as "owner: unassigned".
    const root = scratchRepo({ lint: 'true' })
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const { status, stderr } = runGate(root, name)
      expect(status, `gate name ${name}`).toBe(2)
      expect(stderr).toContain('Unknown CI gate')
    }
  })

  it('exits 2 when no gate name is passed at all', () => {
    const root = scratchRepo({ lint: 'true' })
    expect(runGate(root, undefined).status).toBe(2)
  })
})

describe('a live gate whose script exists', () => {
  it('runs it and passes on exit 0', () => {
    const root = scratchRepo({ lint: `"${process.execPath}" -e ""` })
    const { status, summary } = runGate(root, 'lint')

    expect(status).toBe(0)
    expect(summary).toContain('PASS **lint**')
    expect(summary).toContain('`pnpm lint`')
  })

  it('propagates the script exit code on failure', () => {
    const root = scratchRepo({ lint: `"${process.execPath}" -e "process.exit(3)"` })
    const { status, summary } = runGate(root, 'lint')

    expect(status).not.toBe(0)
    expect(summary).toContain('FAIL **lint**')
  })
})

describe('the registry and the workflow do not drift', () => {
  const gateSource = readFileSync(realGate, 'utf8')
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')

  /** The keys of the GATES object literal in gate.mjs, read from source. */
  const registryGates = (() => {
    const block = /const GATES = \{\n(.*?)\n\}\n/s.exec(gateSource)?.[1]
    if (!block) throw new Error('could not locate the GATES registry in scripts/ci/gate.mjs')
    return [...block.matchAll(/^ {2}([a-z][\w:-]*):/gm)].map((m) => m[1])
  })()

  const needs = (() => {
    const block = /ci-gate:.*?needs:\s*\[(.*?)\]/s.exec(workflow)?.[1]
    if (!block) throw new Error("could not locate ci-gate's needs list in ci.yml")
    return block
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  })()

  it('found the nine gates', () => {
    expect(registryGates).toEqual([
      'lint',
      'format',
      'typecheck',
      'unit',
      'coverage',
      'boundaries',
      'testkit',
      'integration',
      'e2e',
    ])
  })

  it.each(registryGates)(
    'gate %s has a job that invokes it and is a ci-gate dependency',
    (name) => {
      // A registry entry with no job never runs; a job missing from `needs` runs
      // but cannot fail the one required check. Either way the gate is decoration.
      expect(workflow).toContain(`node scripts/ci/gate.mjs ${name}`)
      expect(needs).toContain(name)
    },
  )

  it('every gate.mjs invocation in the workflow names a registered gate', () => {
    const invoked = [...workflow.matchAll(/node scripts\/ci\/gate\.mjs (\S+)/g)].map((m) => m[1])
    expect(invoked.length).toBeGreaterThan(0)
    for (const name of invoked) expect(registryGates).toContain(name)
  })
})

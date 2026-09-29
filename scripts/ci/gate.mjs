#!/usr/bin/env node
/**
 * Runs one CI gate by name.
 *
 * Why this exists: PER-6 must stand up the *shape* of the pipeline (lint,
 * typecheck, boundaries, unit, testkit, integration, e2e) before every gate's
 * implementation exists — `pnpm boundaries` lands with PER-5, the conformance
 * testkit with PER-17, integration and E2E with M1/M3. A workflow that calls a
 * missing pnpm script fails with `ERR_PNPM_NO_SCRIPT`, which is
 * indistinguishable from a real regression.
 *
 * So each gate is declared here once, with the issue that owns it. A gate whose
 * script is not defined yet is reported as PENDING and passes; the day the
 * owning issue adds the script, the same job turns into a hard gate with no
 * workflow edit. The job names never change, which is what lets required status
 * checks be switched on (see `docs/ci-cd.md`) without rework.
 *
 * `CI_STRICT_GATES=1` turns PENDING into a failure. Set it once M1 closes so a
 * gate can never silently regress back to "not implemented".
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The gate registry. `script` is a root-level pnpm script name.
 * `pendingOwner` is who must land it; `null` means the gate is already live.
 */
const GATES = {
  lint: { script: 'lint', pendingOwner: null },
  typecheck: { script: 'typecheck', pendingOwner: null },
  unit: { script: 'test', pendingOwner: null },
  boundaries: {
    script: 'boundaries',
    pendingOwner: 'PER-5 — dependency-cruiser rule set (see docs/adr/0002)',
  },
  testkit: {
    script: 'test:testkit',
    pendingOwner: 'PER-17 — game conformance testkit (first consumer: tic-tac-toe)',
  },
  integration: {
    script: 'test:integration',
    pendingOwner: 'M1 — realtime service integration tests (need Redis + Postgres)',
  },
  e2e: {
    script: 'test:e2e',
    pendingOwner: 'M1/M3 — QA Engineer, multi-browser Playwright suite',
  },
}

const gateName = process.argv[2]
const gate = GATES[gateName]

if (!gate) {
  console.error(`Unknown CI gate "${gateName}". Known gates: ${Object.keys(GATES).join(', ')}`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const isDefined = Boolean(pkg.scripts?.[gate.script])

if (!isDefined) {
  const strict = process.env.CI_STRICT_GATES === '1'
  const detail = `gate "${gateName}" has no root script "${gate.script}" yet — owner: ${gate.pendingOwner ?? 'unassigned'}`

  if (strict) {
    console.error(`::error title=CI gate missing::${detail} (CI_STRICT_GATES=1)`)
    process.exit(1)
  }

  console.log(`::notice title=CI gate pending::${detail}`)
  appendSummary(`- PENDING **${gateName}** — ${detail}\n`)
  process.exit(0)
}

const started = Date.now()
const result = spawnSync('pnpm', ['run', gate.script], { cwd: repoRoot, stdio: 'inherit' })
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (result.error) {
  console.error(`::error title=CI gate could not start::${gateName}: ${result.error.message}`)
  process.exit(1)
}

const code = result.status ?? 1
appendSummary(
  `- ${code === 0 ? 'PASS' : 'FAIL'} **${gateName}** — \`pnpm ${gate.script}\` in ${seconds}s\n`,
)
process.exit(code)

/** Writes a line to the GitHub job summary when running in Actions; no-ops locally. */
function appendSummary(line) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  try {
    appendFileSync(target, line)
  } catch {
    // A summary is nice-to-have; never fail a gate over it.
  }
}

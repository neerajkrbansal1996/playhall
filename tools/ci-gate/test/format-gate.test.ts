import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The `format` gate (PER-101) went live green. Green proves it *runs*; it does not
 * prove it fails closed, and a gate nobody has seen fail is a gate nobody has
 * checked.
 *
 * The obvious proof — push a deliberately misformatted file and watch CI go red —
 * only holds for the run it happened on, and the attempt on PR #51 left the
 * fixture in place and the PR red for its whole life. So the proof lives here
 * instead: `prettier --check` with *this repo's* config must reject a misformatted
 * file and accept a formatted one. Composed with the gate-runner cases in
 * `gate-runner.test.ts` — which prove `gate.mjs` propagates a non-zero script exit
 * code — that is the whole chain `gate.mjs format` → `pnpm format:check` →
 * `prettier --check .`, re-proven on every run.
 *
 * Both files are written to a scratch directory, so nothing misformatted is ever
 * committed and the repo's own `format` gate has nothing to trip over.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const prettier = join(repoRoot, 'node_modules', '.bin', 'prettier')

const FORMATTED = `export const seatCount = 4\n`
// Double quotes, a semicolon and 4-space indent: three separate violations of
// .prettierrc.json, so the case does not hinge on one option staying set.
const MISFORMATTED = `export function seats() {\n    return "four";\n}\n`

const emptyIgnore = (() => {
  const path = join(mkdtempSync(join(tmpdir(), 'format-gate-ignore-')), '.prettierignore')
  writeFileSync(path, '')
  return path
})()

function check(contents: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'format-gate-'))
  const file = join(dir, 'subject.ts')
  writeFileSync(file, contents)
  const result = spawnSync(
    prettier,
    // `--ignore-path` is pointed at an empty file on purpose: the subject lives
    // outside the repo, and prettier would otherwise resolve no ignore file at all
    // — pinning it keeps the case independent of .prettierignore's contents.
    ['--check', '--config', join(repoRoot, '.prettierrc.json'), '--ignore-path', emptyIgnore, file],
    { cwd: dir, encoding: 'utf8' },
  )
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('the format gate fails closed', () => {
  it('rejects a deliberately misformatted file', () => {
    const { status, output } = check(MISFORMATTED)

    expect(status).not.toBe(0)
    expect(output).toContain('subject.ts')
  })

  it('accepts the same code formatted, so the check discriminates', () => {
    // Without this, a prettier invocation broken in some unrelated way (bad config
    // path, missing binary) would satisfy the case above and prove nothing.
    const { status } = check(FORMATTED)

    expect(status).toBe(0)
  })
})

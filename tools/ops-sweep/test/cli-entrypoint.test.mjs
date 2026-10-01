import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { isCliEntrypoint } from '../../../scripts/ops/stranded-issue-sweep.mjs'

/**
 * The sweep decides whether to run by comparing `import.meta.url` against
 * `process.argv[1]`. Node resolves symlinks when it loads a module, so
 * `import.meta.url` is the *real* path while `argv[1]` is the path as typed.
 * Compared unresolved, the guard is false whenever any component of the
 * invocation path is a symlink — and on macOS `/tmp` and `/var` are symlinks
 * into `/private`, which is where every scratch and temp directory lives.
 *
 * The symptom is the worst one available for a watchdog: no output, exit 0.
 * It looks exactly like "swept the board, found nothing". This was caught by
 * running main's merged copy from PAPERCLIP_RUN_SCRATCH_DIR and getting silence.
 *
 * These cases therefore assert on the *subprocess*, because the bug lives in
 * how the process is entered and no in-process assertion can see it. Exit 2
 * with "missing environment" proves `main()` ran: the sweep is invoked with no
 * PAPERCLIP_* config, so reaching the config check is proof of entry, and it
 * cannot make a network call on the way there.
 */

const SWEEP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/ops/stranded-issue-sweep.mjs',
)
const SCRATCH = mkdtempSync(join(realpathSync(tmpdir()), 'sweep-cli-'))

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

// Strip the ambient PAPERCLIP_* config so the run cannot reach the network and
// stops at the config check, whose output is our proof of entry.
function runSweep(scriptPath) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PAPERCLIP_')),
  )
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [scriptPath, '--threshold-hours', '2'], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('the CLI guard survives a symlinked invocation path', () => {
  it('runs when invoked by its real path', async () => {
    const result = await runSweep(SWEEP)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing environment')
  })

  // The regression. A symlinked *directory* in the path is the realistic case:
  // it is what `/tmp`, `/var` and a linked worktree all are.
  it('runs when a directory in the invocation path is a symlink', async () => {
    const realDir = join(SCRATCH, 'real')
    mkdirSync(realDir, { recursive: true })
    const linkDir = join(SCRATCH, 'linked')
    symlinkSync(realDir, linkDir, 'dir')
    // Point at the sweep *through* the symlinked directory.
    const viaLink = join(linkDir, '..', '..', 'real', 'x')
    void viaLink

    const linkedScript = join(realDir, 'sweep.mjs')
    symlinkSync(SWEEP, linkedScript, 'file')
    const throughLinkedDir = join(linkDir, 'sweep.mjs')

    const result = await runSweep(throughLinkedDir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing environment')
    // The pre-fix behaviour: silence and success, indistinguishable from a
    // clean board.
    expect(result.stdout).toBe('')
    expect(result.code).not.toBe(0)
  })

  it('runs when the script itself is reached through a file symlink', async () => {
    const linked = join(SCRATCH, 'sweep-link.mjs')
    symlinkSync(SWEEP, linked, 'file')
    const result = await runSweep(linked)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('missing environment')
  })
})

describe('isCliEntrypoint', () => {
  it('matches a path that resolves to the module, however it was written', () => {
    const moduleUrl = new URL(`file://${realpathSync(SWEEP)}`).href
    expect(isCliEntrypoint(moduleUrl, SWEEP)).toBe(true)
  })

  it('does not match a different module — an import must not trigger the sweep', () => {
    expect(isCliEntrypoint('file:///somewhere/else.mjs', SWEEP)).toBe(false)
  })

  it('does not match when there is no entry path (an import, or a REPL)', () => {
    expect(isCliEntrypoint('file:///x.mjs', undefined)).toBe(false)
    expect(isCliEntrypoint('file:///x.mjs', '')).toBe(false)
  })

  it('returns false rather than throwing on a path that does not resolve', () => {
    expect(isCliEntrypoint('file:///x.mjs', join(SCRATCH, 'does-not-exist.mjs'))).toBe(false)
  })
})

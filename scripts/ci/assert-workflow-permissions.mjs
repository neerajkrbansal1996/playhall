#!/usr/bin/env node
/**
 * Static guard for the reusable-workflow permission clamp (PER-88).
 *
 * `workflow_call` lets a called workflow *lower* the caller's `GITHUB_TOKEN`
 * permissions but never raise them, and GitHub enforces that when it builds the
 * run — not when the job would start. So a caller that grants less than the
 * called workflow asks for does not fail a gate: the whole run is rejected as
 * `startup_failure`, with **zero jobs, no annotation and no check run on the
 * commit**. Nothing goes red. The only way to notice is to list runs by hand.
 *
 * That is exactly what happened to `main.yml`: `ci.yml`'s `ci-gate` job needs
 * `pull-requests: write` to post the gate table (ADR-0004 Decision 2), both
 * callers passed `contents: read`, and every push to `main` silently ran nothing
 * — including `push-audit`, the direct-push detector that ADR-0004 relies on
 * because `main` cannot be protected on this plan. `release.yml` carried the
 * same defect and would have hit it on the first tag ever cut, i.e. on the
 * production path, with no earlier warning.
 *
 * A comment in `ci.yml` already stated the constraint. A comment is not a gate.
 * This is, and it is purely static: it reads the workflow files off disk, needs
 * no install, no token and no network, and asserts
 *
 *   for every job that calls a local reusable workflow, the permissions that
 *   job passes are a superset of every scope that workflow's jobs request.
 *
 * Run it with `pnpm check:workflow-permissions`.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowDir = join(repoRoot, '.github', 'workflows')

const LEVELS = { none: 0, read: 1, write: 2 }

/** Every permission scope GitHub grants to `GITHUB_TOKEN`, for `*-all` expansion. */
const ALL_SCOPES = [
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'repository-projects',
  'security-events',
  'statuses',
]

const failures = []
const notes = []

const files = existsSync(workflowDir)
  ? readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort()
  : []

if (files.length === 0) {
  console.error(
    '::error title=Workflow permission check::No workflow files found under .github/workflows.',
  )
  process.exit(2)
}

const parsed = new Map()
for (const name of files) {
  const path = join(workflowDir, name)
  parsed.set(`.github/workflows/${name}`, {
    path,
    doc: parseWorkflow(readFileSync(path, 'utf8'), path),
  })
}

for (const [callerKey, caller] of parsed) {
  const jobs = caller.doc.jobs
  if (!isMap(jobs)) continue

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isMap(job)) continue
    const uses = typeof job.uses === 'string' ? job.uses : null
    if (!uses) continue

    // Only local calls can be checked statically. A remote reusable workflow
    // lives in another repo at another ref, so its permissions are not on disk.
    if (!uses.startsWith('./')) {
      notes.push(
        `${callerKey} job \`${jobId}\` calls the remote workflow \`${uses}\` — not checked.`,
      )
      continue
    }

    const calleeKey = uses.slice(2)
    const callee = parsed.get(calleeKey)
    if (!callee) {
      failures.push(
        `${callerKey} job \`${jobId}\` calls \`${uses}\`, which does not exist. ` +
          'That alone is a `startup_failure`.',
      )
      continue
    }

    const required = requiredPermissions(callee.doc)
    const grantedSource =
      isMap(job.permissions) || typeof job.permissions === 'string' ? 'job' : 'workflow'
    const grantedRaw = grantedSource === 'job' ? job.permissions : caller.doc.permissions
    const granted = normalisePermissions(grantedRaw)

    if (granted === null) {
      // No `permissions` anywhere on the caller path. The effective token then
      // comes from a repo/org setting this file cannot see, so a superset
      // cannot be proven — and the default is not reliably permissive.
      const wanted = Object.entries(required)
        .map(([scope, level]) => `${scope}: ${level}`)
        .join(', ')
      if (Object.keys(required).length > 0) {
        failures.push(
          `${callerKey} job \`${jobId}\` calls \`${calleeKey}\` but declares no \`permissions\` ` +
            `on the job or the workflow. \`${calleeKey}\` requests ${wanted}; an unset token ` +
            'depends on a repository setting and cannot be shown to cover that. Declare the ' +
            'permissions explicitly on the calling job.',
        )
      }
      continue
    }

    for (const [scope, level] of Object.entries(required)) {
      const have = granted[scope] ?? 'none'
      if (LEVELS[have] < LEVELS[level]) {
        failures.push(
          `${callerKey} job \`${jobId}\` passes \`${scope}: ${have}\` (from the ${grantedSource}-level ` +
            `\`permissions\`) but \`${calleeKey}\` requests \`${scope}: ${level}\`. ` +
            "A reusable workflow cannot raise the caller's token, and GitHub rejects the run at " +
            'startup with zero jobs. Add to the calling job:\n' +
            `        permissions:\n          ${scope}: ${level}`,
        )
      }
    }
  }
}

const summary = []
summary.push('## Reusable-workflow permissions\n')
if (failures.length === 0) {
  summary.push(
    'Every local `workflow_call` passes a superset of the permissions its callee requests.\n',
  )
  for (const note of notes) summary.push(`- note: ${note}\n`)
  console.log('Workflow permission check passed.')
  for (const note of notes) console.log(`note: ${note}`)
} else {
  for (const failure of failures) {
    console.error(
      `::error title=Reusable-workflow permission narrowing::${failure.replace(/\n/g, ' ')}`,
    )
    console.error(`\n${failure}\n`)
    summary.push(`- ${failure.split('\n')[0]}\n`)
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join(''))
  } catch {
    // A summary must never decide the verdict.
  }
}

process.exit(failures.length === 0 ? 0 : 1)

/**
 * The strongest level each scope is requested at anywhere in `doc` — workflow
 * level or any job level. A called workflow is clamped as a whole, so the
 * caller must cover the union, not each job separately.
 */
function requiredPermissions(doc) {
  const required = {}
  const merge = (raw) => {
    const perms = normalisePermissions(raw)
    if (!perms) return
    for (const [scope, level] of Object.entries(perms)) {
      if (level === 'none') continue
      if (LEVELS[level] > LEVELS[required[scope] ?? 'none']) required[scope] = level
    }
  }

  merge(doc.permissions)
  if (isMap(doc.jobs))
    for (const job of Object.values(doc.jobs)) if (isMap(job)) merge(job.permissions)
  return required
}

/** `write-all` / `read-all` / `{}` / a scope map -> a scope map, or null if unset. */
function normalisePermissions(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (value === 'write-all') return Object.fromEntries(ALL_SCOPES.map((s) => [s, 'write']))
    if (value === 'read-all') return Object.fromEntries(ALL_SCOPES.map((s) => [s, 'read']))
    if (value === '{}') return {}
    throw new Error(`Unsupported \`permissions\` value ${JSON.stringify(value)}.`)
  }
  if (!isMap(raw)) throw new Error('Unsupported `permissions` shape.')

  const out = {}
  for (const [scope, level] of Object.entries(raw)) {
    if (typeof level !== 'string' || !(level in LEVELS)) {
      throw new Error(`Unsupported permission level for \`${scope}\`: ${JSON.stringify(level)}.`)
    }
    out[scope] = level
  }
  return out
}

function isMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A deliberately small block-YAML reader.
 *
 * Adding a YAML dependency to the repo root for one static check is not worth
 * it, so this understands only the subset GitHub workflow files (formatted by
 * Prettier, so block style and two-space indents) actually use: nested block
 * maps of scalars. Sequences and block scalars are read as opaque, because the
 * only keys this check needs are `jobs`, `uses` and `permissions`, none of which
 * are sequences. It throws on anything it cannot model rather than guessing —
 * a check that silently mis-parses is worse than no check.
 */
function parseWorkflow(source, path) {
  const lines = source.split('\n')
  const { map } = parseMap(lines, 0, 0, path)
  return map
}

function parseMap(lines, start, indent, path) {
  const map = {}
  let i = start

  while (i < lines.length) {
    const raw = lines[i]
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      i += 1
      continue
    }

    const ind = raw.length - raw.trimStart().length
    if (ind < indent) break
    if (ind > indent) {
      // Content deeper than this map's own indent that was not consumed by a
      // key above it. Real workflow files do not produce this.
      throw new Error(`${path}:${i + 1}: unexpected indentation inside a block map.`)
    }

    const line = stripComment(raw.trim())
    if (line.startsWith('- ')) break // a sequence, not a map, at this level

    const match = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):(?:\s+(.*))?$/.exec(line)
    if (!match) throw new Error(`${path}:${i + 1}: cannot parse ${JSON.stringify(line)}.`)

    const key = (match[1] ?? match[2] ?? match[3]).trim()
    const inline = (match[4] ?? '').trim()
    i += 1

    if (inline !== '' && inline !== '|' && inline !== '>' && inline !== '|-' && inline !== '>-') {
      map[key] = unquote(inline)
      continue
    }

    const nextIndent = peekIndent(lines, i)
    if (nextIndent === null || nextIndent <= indent) {
      map[key] = inline === '' ? null : ''
      continue
    }

    const nextLine = lines[peekIndex(lines, i)].trim()
    if (
      inline !== '' ||
      nextLine.startsWith('- ') ||
      nextLine.startsWith('[') ||
      nextLine.startsWith('{')
    ) {
      // A block scalar, a block sequence, or a flow collection Prettier wrapped
      // onto its own lines (`needs:` does this once the list gets long). All
      // opaque here — none of `jobs`, `uses` or `permissions` is ever one — so
      // skip the subtree rather than pretend to parse it.
      i = skipSubtree(lines, i, indent)
      map[key] = inline === '' ? [] : ''
      continue
    }

    const nested = parseMap(lines, i, nextIndent, path)
    map[key] = nested.map
    i = nested.next
  }

  return { map, next: i }
}

function skipSubtree(lines, start, indent) {
  let i = start
  while (i < lines.length) {
    const raw = lines[i]
    if (raw.trim() === '') {
      i += 1
      continue
    }
    const ind = raw.length - raw.trimStart().length
    if (ind <= indent) break
    i += 1
  }
  return i
}

function peekIndex(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim() === '' || lines[i].trimStart().startsWith('#')) continue
    return i
  }
  return -1
}

function peekIndent(lines, start) {
  const i = peekIndex(lines, start)
  if (i === -1) return null
  return lines[i].length - lines[i].trimStart().length
}

/** Strips an inline `# comment`. Adequate here: no workflow value contains `#`. */
function stripComment(line) {
  const at = line.indexOf(' #')
  return at === -1 ? line : line.slice(0, at).trim()
}

function unquote(value) {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'")
  ) {
    return value.slice(1, -1)
  }
  return value
}

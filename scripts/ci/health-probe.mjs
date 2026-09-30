#!/usr/bin/env node
/**
 * Probes a health endpoint and fails if it is not healthy.
 *
 * Used by three callers, which is why it is one script and not three inline
 * `curl` pipelines:
 *   * the preview deploy, to prove the PR URL is actually reachable;
 *   * the production deploy, to prove a `main` merge landed something that runs;
 *   * the uptime workflow, as the recurring monitor.
 *
 * "HTTP 200" is not the same as "healthy" — a platform behind a CDN edge will
 * happily return 200 from a cached shell while the service behind it is down.
 * So a pass requires `{"ok": true}` in the JSON body as well as a 2xx status.
 *
 * `--expect-commit` extends that same idea one step further, for a target where
 * "is the process up?" is the wrong question. A static host has no process: the
 * artifact *is* the deployment, so the failure worth catching is not "the
 * service died" but "the edge is still serving the previous upload". Pinning the
 * commit turns a stale-content deploy into a red job instead of a silent one.
 * A mismatch is retried rather than failed outright, because an edge that has
 * not finished propagating looks identical to one serving the wrong build for
 * the first few seconds, and only the second one is still wrong at attempt N.
 *
 * Usage: node scripts/ci/health-probe.mjs <url> [--attempts 10] [--timeout-ms 5000]
 *        [--delay-ms 3000] [--expect-commit <sha>]
 */
const args = process.argv.slice(2)
const NUMBER_FLAGS = ['--attempts', '--timeout-ms', '--delay-ms']
// Every flag that consumes the argument after it. `--expect-commit <sha>` takes
// a bare value that does not start with `--`, so leaving it out of this list
// would make the sha look like the URL — the same trap the comment below
// describes, one flag later.
const VALUE_FLAGS = [...NUMBER_FLAGS, '--expect-commit']
// The URL is the first argument that is neither a flag nor a flag's value.
// Taking "the first arg not starting with --" meant `--attempts 3 <url>` probed
// `3`: every current call site happens to put the URL first, which makes it a
// trap rather than a bug.
const url = args.find(
  (arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.includes(args[index - 1]),
)
const attempts = numberFlag('--attempts', 10)
const timeoutMs = numberFlag('--timeout-ms', 5_000)
const delayMs = numberFlag('--delay-ms', 3_000)
const expectCommit = stringFlag('--expect-commit')

if (!url) {
  console.error(
    'Usage: node scripts/ci/health-probe.mjs <url> [--attempts N] [--timeout-ms N] ' +
      '[--delay-ms N] [--expect-commit <sha>]',
  )
  process.exit(2)
}

let lastError = 'no attempt made'

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const startedAt = performance.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
      // A cached 200 tells us nothing about the running service.
      cache: 'no-store',
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const text = await response.text()

    if (!response.ok) {
      lastError = `HTTP ${response.status} in ${latencyMs}ms — ${truncate(text)}`
    } else {
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        lastError = `HTTP 200 in ${latencyMs}ms but body is not JSON — ${truncate(text)}`
        payload = undefined
      }

      if (payload !== undefined) {
        if (payload.ok !== true) {
          lastError = `HTTP 200 in ${latencyMs}ms but ok !== true — ${truncate(text)}`
        } else if (expectCommit !== undefined && payload.commit !== expectCommit) {
          // Healthy, but serving something other than what this job deployed.
          lastError =
            `HTTP 200 in ${latencyMs}ms and ok === true, but commit is ` +
            `${payload.commit ?? '(absent)'} and this deploy uploaded ${expectCommit} — ` +
            'the target is serving a different build'
        } else {
          console.log(
            `healthy: ${url} — HTTP ${response.status} in ${latencyMs}ms, service=${payload.service ?? 'unknown'}, attempt ${attempt}/${attempts}` +
              (expectCommit === undefined ? '' : `, commit=${expectCommit}`),
          )
          process.exit(0)
        }
      }
    }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt)
    lastError = `${error instanceof Error ? error.name : 'Error'}: ${
      error instanceof Error ? error.message : String(error)
    } after ${latencyMs}ms`
  }

  console.log(`attempt ${attempt}/${attempts} failed — ${lastError}`)
  if (attempt < attempts) await sleep(delayMs)
}

console.error(`::error title=Health probe failed::${url} never became healthy. Last: ${lastError}`)
process.exit(1)

function numberFlag(flag, fallback) {
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  const parsed = Number(args[index + 1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * `undefined` for both "flag absent" and "flag present but empty", because the
 * composite action passes an unset output through as `--expect-commit ''`. An
 * empty expectation must mean "do not check", not "expect the empty string" —
 * otherwise every unpinned caller fails.
 */
function stringFlag(flag) {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') || value === '' ? undefined : value
}

function truncate(text, max = 300) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

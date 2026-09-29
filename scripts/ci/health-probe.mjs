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
 * Usage: node scripts/ci/health-probe.mjs <url> [--attempts 10] [--timeout-ms 5000] [--delay-ms 3000]
 */
const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--'))
const attempts = numberFlag('--attempts', 10)
const timeoutMs = numberFlag('--timeout-ms', 5_000)
const delayMs = numberFlag('--delay-ms', 3_000)

if (!url) {
  console.error('Usage: node scripts/ci/health-probe.mjs <url> [--attempts N] [--timeout-ms N] [--delay-ms N]')
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
        } else {
          console.log(
            `healthy: ${url} — HTTP ${response.status} in ${latencyMs}ms, service=${payload.service ?? 'unknown'}, attempt ${attempt}/${attempts}`,
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

function truncate(text, max = 300) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

#!/usr/bin/env node
/**
 * `no-illegal-declared-dep` — the one rule in ADR-0002 §2 that dependency-cruiser cannot
 * express.
 *
 * dependency-cruiser reasons about *edges*: a dependency it has never seen imported produces
 * no edge, so `@playhall/platform-core` sitting in `games/chess/package.json` with no import yet
 * is invisible to it. ADR-0002 §1 lists "validates declared package.json dependencies" as a
 * dependency-cruiser capability; it is not one (verified against dependency-cruiser 18.4.0 —
 * every `dependencyTypes` value is import-derived). The rule is still worth enforcing, because
 * a declared dependency is a stated intent to cross the boundary and it will be imported by
 * the next commit, so it is enforced here instead and runs in the same `pnpm boundaries` job.
 *
 * Contract: a game package's manifest may declare exactly one @playhall package —
 * `@playhall/game-sdk`. Third-party dependencies are unrestricted.
 *
 * Paths are resolved relative to cwd, so this can be pointed at a scratch repo by the
 * boundary fixture tests.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const RULE = 'no-illegal-declared-dep'
const MANIFEST_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

/**
 * The npm scope is read from the SDK's own manifest, never hard-coded. The scope is a brand
 * string and the brand is a board decision that is still open — a literal here would make this
 * check silently pass the day the scope is renamed, which is the worst failure mode a gate has:
 * green and doing nothing.
 */
const SDK_MANIFEST = 'packages/game-sdk/package.json'
const sdkName = JSON.parse(readFileSync(SDK_MANIFEST, 'utf8')).name
const scope = sdkName.startsWith('@') ? sdkName.split('/')[0] : null

if (scope === null) {
  console.error(`${RULE}: cannot run — ${SDK_MANIFEST} name "${sdkName}" is not scoped.`)
  process.exit(2)
}

const ALLOWED = new Set([sdkName])

const COMMENT =
  `A game package may declare exactly one ${scope} dependency: ${sdkName}. A declared ` +
  'dependency is as much a boundary violation as an import — it is a stated intent to cross ' +
  'the boundary. Remove it; if the capability is genuinely needed, it belongs in the SDK and ' +
  'that needs a CTO ADR first.'

/** Every game package directory, covering both `games/<name>` and `games/_examples/<name>`. */
function gamePackageDirs(root = 'games') {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'package.json'))) {
      out.push(dir)
    } else {
      // A grouping directory such as `games/_examples` — recurse one level.
      out.push(...gamePackageDirs(dir))
    }
  }
  return out
}

const violations = []

for (const dir of gamePackageDirs()) {
  const manifestPath = join(dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    violations.push({ manifestPath, detail: `is not valid JSON (${error.message})` })
    continue
  }
  for (const section of MANIFEST_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith(`${scope}/`) && !ALLOWED.has(name)) {
        violations.push({ manifestPath, detail: `declares "${name}" in ${section}` })
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`${RULE}: ok — no game package declares a forbidden ${scope} dependency.`)
  process.exit(0)
}

console.error(`\n  error ${RULE}: ${violations.length} violation(s)\n`)
for (const { manifestPath, detail } of violations) {
  console.error(`  error ${RULE}: ${manifestPath} ${detail}`)
}
console.error(`\n  ${COMMENT}\n`)
console.error(`✖ ${violations.length} dependency violation(s) (${violations.length} error(s))\n`)
process.exit(1)

#!/usr/bin/env node
/**
 * The manifest half of the boundary gate: the part of ADR-0002 §2 that dependency-cruiser
 * cannot express. Two rules are checked here — `no-illegal-declared-dep` and the manifest half
 * of `no-platform-framework-in-games`.
 *
 * dependency-cruiser reasons about *edges*: a dependency it has never seen imported produces
 * no edge, so `@playhall/platform-core` sitting in `games/chess/package.json` with no import yet
 * is invisible to it. ADR-0002 §1 lists "validates declared package.json dependencies" as a
 * dependency-cruiser capability; it is not one (verified against dependency-cruiser 18.4.0 —
 * every `dependencyTypes` value is import-derived). The rules are still worth enforcing, because
 * a declared dependency is a stated intent to cross the boundary and it will be imported by
 * the next commit, so they are enforced here instead and run in the same `pnpm boundaries` job.
 *
 * Contract: a game package's manifest may declare exactly one @playhall package —
 * `@playhall/game-sdk`. Third-party dependencies are unrestricted, with one denylist: the
 * platform's netcode framework (ADR-0001 §4.2 condition 2), which is a platform choice a game
 * may never see. Denylist, not allowlist — games pick their own libraries; only a package whose
 * presence *is* the coupling gets named here.
 *
 * Paths are resolved relative to cwd, so this can be pointed at a scratch repo by the
 * boundary fixture tests.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const RULE = 'no-illegal-declared-dep'
const FRAMEWORK_RULE = 'no-platform-framework-in-games'
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

/**
 * `no-platform-framework-in-games`, manifest half. The dependency-cruiser rule of the same name
 * catches the *import*; this catches the *declaration*, for the same reason
 * `no-illegal-declared-dep` exists — a declared dependency is a stated intent to cross the
 * boundary, and under pnpm's strict `node_modules` it is also the only way the import would
 * resolve at all. `cd games/chess && pnpm add colyseus` is the easiest way to break ADR-0001
 * §4.2 condition 2 by accident, and it produces *only* a manifest line until the next commit;
 * catching it here means the gate fires on that line rather than three commits later.
 *
 * `colyseus.js` is the browser client and is published under a name matching neither
 * `^colyseus$` nor `@colyseus/*`, so it needs its own alternative or the likeliest
 * client-side declaration slips through.
 */
const FORBIDDEN_THIRD_PARTY = /^(colyseus|colyseus\.js|@colyseus\/[^/]+)$/

const COMMENTS = {
  [RULE]:
    `A game package may declare exactly one ${scope} dependency: ${sdkName}. A declared ` +
    'dependency is as much a boundary violation as an import — it is a stated intent to cross ' +
    'the boundary. Remove it; if the capability is genuinely needed, it belongs in the SDK and ' +
    'that needs a CTO ADR first.',
  [FRAMEWORK_RULE]:
    'ADR-0001 §4.2 condition 2: no game imports the framework. The board adopted Colyseus for ' +
    'apps/realtime (ADR-0001 §4 rev 4) on the binding condition that the choice stays invisible ' +
    'to games, and exactly one adapter file names it. A game that declares colyseus, colyseus.js ' +
    "or @colyseus/* pins every game to the platform's netcode framework and opts into " +
    'default-broadcast state sync, where a field is visible unless someone remembers to filter ' +
    'it. @colyseus/schema being in the tree is availability, not permission (condition 1). Keep ' +
    `game state as plain TypeScript and carry it through ${sdkName}; if you believe you need ` +
    'the capability, that is an SDK ADR for the CTO, not a widening of this rule.',
}

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
    violations.push({ rule: RULE, manifestPath, detail: `is not valid JSON (${error.message})` })
    continue
  }
  for (const section of MANIFEST_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith(`${scope}/`) && !ALLOWED.has(name)) {
        violations.push({ rule: RULE, manifestPath, detail: `declares "${name}" in ${section}` })
      } else if (FORBIDDEN_THIRD_PARTY.test(name)) {
        violations.push({
          rule: FRAMEWORK_RULE,
          manifestPath,
          detail: `declares "${name}" in ${section}`,
        })
      }
    }
  }
}

if (violations.length === 0) {
  // Both rule names are printed on success, not just the first. A green log that names only one
  // of the two checks cannot be used as evidence that the other one ran at all.
  console.log(`${RULE}: ok — no game package declares a forbidden ${scope} dependency.`)
  console.log(`${FRAMEWORK_RULE}: ok — no game package declares the platform netcode framework.`)
  process.exit(0)
}

// Grouped by rule, because the fixture suite asserts that the *right* rule fired and that its
// explanation was printed. A single blended error message would satisfy neither.
const byRule = new Map()
for (const violation of violations) {
  const bucket = byRule.get(violation.rule) ?? []
  bucket.push(violation)
  byRule.set(violation.rule, bucket)
}

for (const [rule, found] of byRule) {
  console.error(`\n  error ${rule}: ${found.length} violation(s)\n`)
  for (const { manifestPath, detail } of found) {
    console.error(`  error ${rule}: ${manifestPath} ${detail}`)
  }
  console.error(`\n  ${COMMENTS[rule]}\n`)
}
console.error(`✖ ${violations.length} dependency violation(s) (${violations.length} error(s))\n`)
process.exit(1)

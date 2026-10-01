#!/usr/bin/env node
/**
 * The manifest half of the boundary gate: the part of ADR-0002 §2 that dependency-cruiser
 * cannot express. Two rules are checked here — `no-illegal-declared-dep` and the manifest half
 * of `no-game-to-colyseus`.
 *
 * dependency-cruiser reasons about *edges*: a dependency it has never seen imported produces
 * no edge, so `@playhall/platform-core` sitting in `games/chess/package.json` with no import yet
 * is invisible to it. ADR-0002 §1 lists "validates declared package.json dependencies" as a
 * dependency-cruiser capability; it is not one (verified against dependency-cruiser 18.4.0 —
 * every `dependencyTypes` value is import-derived). The rules are still worth enforcing, because
 * a declared dependency is a stated intent to cross the boundary and it will be imported by
 * the next commit, so they are enforced here instead and run in the same `pnpm boundaries` job.
 *
 * Contract: a game package's manifest may declare exactly one dependency that resolves inside
 * this repo — the SDK, identified by reading the SDK manifest's own `name`. Any other
 * `workspace:`, `link:` or `file:` dependency is rejected whatever it is called, and so is any
 * other dependency in the SDK's scope. Third-party registry dependencies are unrestricted, with
 * one denylist: the server framework (ADR-0001 §4), a platform choice a game may never see.
 *
 * `no-illegal-declared-dep` is an allowlist over repo-internal edges rather than a denylist over
 * one scope, because a scope denylist goes quiet the moment a package is renamed. Measured at
 * `9f0292b` against the previous scope-only form, a game declaring `link:` straight into
 * `packages/platform-core` under a name in no scope at all installed cleanly and exited 0 — a
 * boundary violation nothing in CI saw, since dependency-cruiser has no edge until it is
 * imported. Matching on the specifier instead of the name is rename-proof. See PER-64.
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
 * Specifier prefixes that resolve to a package inside this repo. A dependency carrying one of
 * these is a repo-internal edge no matter what it is named, which is what makes this arm survive
 * a rename. `catalog:` is deliberately absent: it resolves through the root catalog to a registry
 * version, so it is a third-party dependency wearing a pnpm protocol.
 */
const WORKSPACE_PROTOCOLS = ['workspace:', 'link:', 'file:']

const isWorkspaceEdge = (specifier) =>
  typeof specifier === 'string' &&
  WORKSPACE_PROTOCOLS.some((protocol) => specifier.startsWith(protocol))

/**
 * The SDK's package name is read from its own manifest, never hard-coded. It is derived from a
 * brand string and the brand is a board decision that is still open — a literal here would make
 * this check silently pass the day the package is renamed, which is the worst failure mode a
 * gate has: green and doing nothing.
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
 * `no-game-to-colyseus`, manifest half. The dependency-cruiser rule of the same name catches the
 * *import*; this catches the *declaration*, for the same reason `no-illegal-declared-dep` exists
 * — a declared dependency is a stated intent to cross the boundary, and under pnpm's strict
 * `node_modules` it is also the only way the import would resolve at all. Catching it here means
 * the gate fires on the manifest line rather than on the import three commits later.
 *
 * `colyseus.js` is the browser client and is published under a name matching neither
 * `^colyseus$` nor `@colyseus/*`, so it needs its own alternative or the likeliest
 * client-side declaration slips through.
 */
const FORBIDDEN_THIRD_PARTY = /^(colyseus|colyseus\.js|@colyseus\/[^/]+)$/

const COMMENTS = {
  'no-illegal-declared-dep':
    `A game package may declare exactly one workspace dependency: ${sdkName}. Any other ` +
    `workspace:/link:/file: dependency — or any other ${scope} dependency — is a boundary ` +
    'violation whatever it is called. A declared dependency is as much a violation as an ' +
    'import: it is a stated intent to cross the boundary, and dependency-cruiser cannot see it ' +
    'until something imports it. Remove it; if the capability is genuinely needed, it belongs ' +
    'in the SDK and that needs a CTO ADR first. Third-party registry dependencies are ' +
    'unrestricted.',
  'no-game-to-colyseus':
    "The server framework is a platform choice, never a game's. The board adopted Colyseus for " +
    'apps/realtime (ADR-0001 §4) and exactly one adapter file names it. A game that declares ' +
    "colyseus or @colyseus/* pins every game to the platform's netcode framework and opts into " +
    'default-broadcast state sync, where a field is visible unless someone remembers to filter ' +
    `it. Keep game state as plain TypeScript and carry it through ${sdkName}.`,
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
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      // The framework denylist is checked first and independently of the allowlist below: a
      // vendored `colyseus` pinned with `link:` is both violations, and the framework rule is
      // the one that explains why it can never be a game's choice.
      if (FORBIDDEN_THIRD_PARTY.test(name)) {
        violations.push({
          rule: 'no-game-to-colyseus',
          manifestPath,
          detail: `declares "${name}" in ${section}`,
        })
        continue
      }

      if (ALLOWED.has(name)) continue

      // The allowlist arm: any edge into this repo other than the SDK, whatever its name. This
      // is what catches a dependency left behind under a scope that no longer exists, and the
      // `link:`/`file:` violation that installs cleanly under a name in no scope at all.
      if (isWorkspaceEdge(specifier)) {
        violations.push({
          rule: RULE,
          manifestPath,
          detail: `declares workspace dependency "${name}": "${specifier}" in ${section}`,
        })
        continue
      }

      // The scope arm, kept so a platform package pinned to a *registry* version — a boundary
      // violation that carries no repo-internal specifier to match on — is still caught.
      if (name.startsWith(`${scope}/`)) {
        violations.push({ rule: RULE, manifestPath, detail: `declares "${name}" in ${section}` })
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    `${RULE}: ok — every game package declares ${sdkName} or nothing else from this workspace.`,
  )
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

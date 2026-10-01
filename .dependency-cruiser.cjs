/**
 * Playhall dependency-boundary rule set — the mechanical form of ADR-0002.
 *
 * This file IS the boundary contract. Read it top to bottom and you know what a game
 * may touch. Widening any rule here is a reviewed change and needs an ADR (ADR-0002,
 * "Consequences"): if a game needs something it cannot reach, the answer is usually
 * "put it in the game", and occasionally "add it to the SDK" — never "relax the rule".
 *
 * Run it with `pnpm boundaries`. Every rule below carries a `comment`, because CI output
 * is where an engineer meets one of these rules for the first time.
 */

const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Package names quoted in the `comment` strings below are read from each package's own manifest,
 * never typed as literals. Those comments are printed by the `err-long` reporter, so they are
 * the advice an engineer acts on when the gate stops them — advice naming a scope the workspace
 * no longer uses is worse than no advice.
 */
const SDK_NAME = require(join(__dirname, 'packages/game-sdk/package.json')).name
const SCOPE = SDK_NAME.startsWith('@') ? SDK_NAME.split('/')[0] : null
if (SCOPE === null) {
  throw new Error(`.dependency-cruiser.cjs: SDK package name "${SDK_NAME}" is not scoped.`)
}

/** Regex-escapes a literal, so a `.` or `+` inside a package name cannot act as a metacharacter. */
const escapeRe = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Workspace package directories directly under `parent` — those that carry a manifest.
 *
 * Enumerated rather than hard-listed so that a package added later is covered without editing
 * this file. A boundary rule that quietly stops covering a new package is the same failure mode
 * as a rule that never fired: green, and not enforcing anything.
 */
function workspacePackageDirs(parent) {
  const base = join(__dirname, parent)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => `${parent}/${entry.name}`)
}

/** A workspace package's declared name, read from its manifest. */
const packageName = (dir) => require(join(__dirname, dir, 'package.json')).name

/**
 * Matches an import of one of our own workspace packages, in **both** the forms it can take in
 * the graph — written as a repo path, and written as a bare package specifier.
 *
 * This second form is not hypothetical, and leaving it out was a real hole rather than a
 * theoretical one. dependency-cruiser only learns a module's repo-relative path once the import
 * *resolves*, and pnpm links a workspace package into `node_modules` only when the importer
 * *declares* it. A game may never declare a platform package — `no-illegal-declared-dep` forbids
 * exactly that — so the realistic violation, `import { x } from '<scope>/platform-core'` inside a
 * game with nothing added to its `package.json`, resolves to nothing. A path-only rule then sees
 * no edge at all: it was reported as a `not-to-unresolvable` *warning* and CI stayed green, on
 * the single most likely way to break the plugin boundary.
 *
 * So each pattern below carries three alternations, the same shape COLYSEUS_MODULES already uses
 * for third-party packages, applied to our own:
 *   - `^packages/platform-core/` — resolved through the workspace link, the declared case.
 *   - `^@scope/platform-core($|/)` — the bare specifier dependency-cruiser keeps when the import
 *     does not resolve, i.e. the undeclared case.
 *   - `node_modules/@scope/platform-core/` — resolved through an installed (non-linked) copy.
 * Which one appears depends only on whether the author happened to also declare the dependency
 * they should not have, so all three have to be forbidden for the rule to mean anything.
 */
function packageTargets(dirs) {
  const paths = dirs.map(escapeRe).join('|')
  const names = dirs.map((dir) => escapeRe(packageName(dir))).join('|')
  return [`^(${paths})/`, `^(${names})($|/)`, `(^|/)node_modules/(${names})/`]
}

/**
 * The platform internals a game may never reach.
 *
 * `game-sdk` is the one package a game may import, and `shared` has its own rule (its published
 * index is legal, a deep import is not), so both are excluded here. Everything else under
 * `packages/` is a platform internal by default — which is the right default: a game reaches the
 * platform through the SDK contract or not at all.
 */
const PLATFORM_PACKAGE_DIRS = workspacePackageDirs('packages').filter(
  (dir) => dir !== 'packages/game-sdk' && dir !== 'packages/shared',
)
const PLATFORM_INTERNALS = packageTargets(PLATFORM_PACKAGE_DIRS)

/** Every app. An app is a composition root, never a library a game or the SDK imports. */
const APP_TARGETS = packageTargets(workspacePackageDirs('apps'))

/** Every game package, across both the flat `games/*` and nested `games/_examples/*` layouts. */
const GAME_TARGETS = packageTargets([
  ...workspacePackageDirs('games'),
  ...workspacePackageDirs('games/_examples'),
])

/** `shared` is legal through its published index and illegal by deep path — see the rule below. */
const SHARED_DIR = 'packages/shared'
const SHARED_NAME = packageName(SHARED_DIR)
const SHARED_INTERNALS = [
  // Resolved: any file under `src/` that is not the index.
  '^packages/shared/src/(?!index)',
  // Unresolved: a subpath specifier. The package's `exports` map publishes only `.`, so a deep
  // import never resolves — meaning without this alternation the rule could not fire at all.
  `^${escapeRe(SHARED_NAME)}/.+`,
]

/**
 * The single allowlisted platform->game edge (ADR-0002 §3). Generated by a script that
 * enumerates `games/*`, never hand-written, and dynamic-only so a game adds zero bytes
 * to other bundles.
 */
const GENERATED_REGISTRY = '^apps/[^/]+/src/games\\.generated\\.ts$'

/**
 * Any game package, capturing the package directory. Covers both `games/<name>` and the
 * nested `games/_examples/<name>` layout the workspace actually uses, so `$1` is the game
 * and not the literal string `_examples`. ADR-0002 §2 writes this as `^games/([^/]+)/`;
 * the non-capturing `_examples` prefix strictly tightens that, it does not widen it.
 */
const ANY_GAME_DIR = '^games/((?:_examples/)?[^/]+)/'

/**
 * The server framework. ADR-0001 §4 (rev 4) adopts Colyseus for `apps/realtime` by board
 * decision; ADR-0002 §2 keeps it out of `games/**`. That pairing is the whole point: the
 * platform may pick a framework, a game may never learn which one was picked.
 *
 * Two alternations, because a module's path in the graph depends on whether it resolved:
 *   - `^(colyseus|@colyseus/x)$` — declared but not installed, or imported without being
 *     declared. dependency-cruiser keeps the bare specifier as the path.
 *   - `.../node_modules/colyseus/...` — installed and resolved.
 * Matching only the resolved form would make the rule silently pass on the exact case a game
 * author is most likely to produce first: an import written before `pnpm install` runs.
 *
 * `colyseus.js` is listed explicitly because it is the browser *client*, published under a
 * name that neither `^colyseus$` nor `@colyseus/*` matches. That is the form a game's
 * client-side code reaches for first, so leaving it out would have left the likeliest
 * violation green.
 */
const COLYSEUS_PACKAGES = 'colyseus|colyseus\\.js|@colyseus/[^/]+'
const COLYSEUS_MODULES = `^(${COLYSEUS_PACKAGES})$|(^|/)node_modules/(${COLYSEUS_PACKAGES})/`

/**
 * The validator, in both the forms it can take in the graph — same two alternations, and for
 * the same reason, as COLYSEUS_MODULES above. `^zod$` alone matches only the *unresolved* case;
 * zod is a real declared dependency of the SDK, so in practice it resolves and its path is
 * `.../node_modules/zod/...`. A rule written against the bare specifier only would therefore
 * pass on every actual violation, which is the failure mode this whole file warns about.
 */
const ZOD_MODULES = '^zod($|/)|(^|/)node_modules/zod/'

/**
 * The two modules the settings contract is split across, by absolute path.
 *
 * `$`-anchored because `apps/web` has its own `settings-form.tsx`, and an unanchored pattern
 * would catch the renderer instead of the contract.
 */
const SDK_PURE_SETTINGS = '^packages/game-sdk/src/settings-form\\.ts$'
const SDK_SETTINGS_SCHEMAS = '^packages/game-sdk/src/settings\\.ts$'

/**
 * The one file in `packages/platform-core/src/` allowed to reach a Node builtin.
 *
 * **Permanent and governed by ADR-0011 §Decision part 4** — not a temporary carve-out expiring on
 * a follow-up. `guest-token.ts` signs with `node:crypto`'s `createHmac`/`timingSafeEqual`; the
 * WebCrypto equivalent is `crypto.subtle.sign`, which is async, so swapping it turns
 * `signGuestToken` / `verifyGuestToken` async and ripples through
 * `GuestIdentityService.issue()`/`authenticate()`. ADR-0011 §Alternatives 1 rejected that swap, and
 * leads with the objection that actually settles it: converting this file would not make the
 * default entrypoint edge-importable either, because `identity/service.ts` sits in the same barrel
 * subtree and the entrypoint's whole graph is what decides. On the property it is named for the
 * swap buys nothing, while making `issue()`/`authenticate()` permanently async. Reversibility is
 * the second reason, not the first. So the import stays and the exception stays with it.
 *
 * The exception is a single `$`-anchored path on purpose. The policy the rule enforces — "the list
 * is short enough to read" — is only defensible while the list is one entry, so a second entry is
 * never a mechanical fix: it trips ADR-0011's revisit trigger #2 and needs that ADR amended, not
 * this line extended. Port the capability instead (see the rule's comment below).
 */
const PLATFORM_CORE_NODE_BUILTIN_EXCEPTIONS =
  '^packages/platform-core/src/identity/guest-token\\.ts$'

module.exports = {
  forbidden: [
    {
      name: 'no-game-to-platform',
      severity: 'error',
      comment:
        `A game talks to the platform ONLY through ${SDK_NAME}. Importing platform ` +
        'internals couples the game to code that is free to change under it, and breaks the ' +
        'promise that a game needs no change outside its own folder. Need something? Ask the ' +
        'CTO for an SDK addition (ADR first) rather than reaching past the contract.',
      from: { path: '^games/' },
      to: { path: PLATFORM_INTERNALS },
    },
    {
      name: 'no-game-to-colyseus',
      severity: 'error',
      comment:
        "The server framework is a platform choice, never a game's. The board adopted Colyseus " +
        'for apps/realtime (ADR-0001 §4); exactly one file names it, and that file is an ' +
        'adapter. A game that imports colyseus or @colyseus/* — most likely @colyseus/schema to ' +
        'express its state — makes the SDK contract Colyseus-shaped and pins every game to the ' +
        "platform's netcode framework, which is the coupling the one rule forbids. It also " +
        'hands the game to Colyseus state sync, which is default-broadcast: a hidden-information ' +
        'leak is a correctness bug (ADR-0001 §4.5). Keep game state as plain TypeScript and let ' +
        `${SDK_NAME} carry it.`,
      from: { path: '^games/' },
      to: { path: COLYSEUS_MODULES },
    },
    {
      name: 'no-game-to-app',
      severity: 'error',
      comment:
        'A game may not reach into the web shell or the realtime server. Games are plugins ' +
        'loaded by an app; an app is never a library a game imports.',
      from: { path: '^games/' },
      to: { path: APP_TARGETS },
    },
    {
      name: 'no-game-to-game',
      severity: 'error',
      comment:
        'Games are independent plugins. Chess is not a special case and neither is anything ' +
        'else. Shared game logic belongs in the SDK (if general) or duplicated (if not).',
      from: { path: ANY_GAME_DIR },
      // `pathNot` exempts the game's own directory via `$1` (dependency-cruiser group matching,
      // not a regex backreference). It deliberately does not exempt the game's own *package
      // name*: a game importing itself by bare specifier routes its own files through
      // `node_modules` and is a cycle waiting to happen, so flagging it is correct.
      to: { path: GAME_TARGETS, pathNot: '^games/$1/' },
    },
    {
      name: 'no-game-to-shared-internals',
      severity: 'error',
      comment:
        `Import ${SHARED_NAME} through its published surface, not by deep path. A deep import ` +
        'bypasses the export map and pins the game to an internal file layout.',
      from: { path: '^games/' },
      to: { path: SHARED_INTERNALS },
    },
    {
      name: 'no-platform-to-game',
      severity: 'error',
      comment:
        'The platform never imports a game. Games load through the generated registry at ' +
        'apps/*/src/games.generated.ts, which is the ONLY allowlisted platform->game edge ' +
        '(ADR-0002 §3). packages/platform-core gets no exception at all — composition happens ' +
        'at the app root. If you need a second such edge, the registry abstraction is wrong: ' +
        'escalate to the CTO, do not add yourself to this allowlist.',
      from: { path: '^(packages|apps)/', pathNot: GENERATED_REGISTRY },
      to: { path: GAME_TARGETS },
    },
    {
      name: 'no-static-game-import-in-registry',
      severity: 'error',
      comment:
        'Companion to no-platform-to-game, required by ADR-0002 §3: even the generated ' +
        'registry may only reach a game through a dynamic import(). A static import pulls ' +
        'every game into the shared chunk and breaks "adding a game adds zero bytes to other ' +
        'bundles".',
      from: { path: GENERATED_REGISTRY },
      to: { path: GAME_TARGETS, dynamic: false },
    },
    {
      name: 'no-package-to-app',
      severity: 'error',
      comment:
        'An app is a composition root, never a library. A packages/** -> apps/** edge inverts ' +
        'the dependency: apps/web and apps/realtime both import platform-core, so the import ' +
        'back is a cycle waiting to happen, and it makes the package unpublishable on its own ' +
        'because installing it would drag a whole Next.js or server app along. This covers a ' +
        "package's test/ tree too, which is the case a test author actually writes — reaching " +
        'for apps/realtime/src/clock.ts from a platform-core test rather than copying it. If a ' +
        'package needs something an app has, the thing is in the wrong place: move it down into ' +
        'the package (or packages/shared) and let the app import it, which is the direction that ' +
        'already works.',
      // `^packages/` deliberately, not "every package except game-sdk": `no-sdk-to-platform`
      // below already forbids game-sdk -> app, so that one edge trips two rules. Narrowing this
      // rule to dodge the overlap would make it stop saying what it is named for — no package
      // imports an app — and an overlap costs nothing but a second line of CI output.
      from: { path: '^packages/' },
      to: { path: APP_TARGETS },
    },
    {
      name: 'no-sdk-to-platform',
      severity: 'error',
      comment:
        'game-sdk is a contract, not a client of the platform. It must stay dependency-light ' +
        `and independently publishable, so it depends on nothing of ours except ${SHARED_NAME}. ` +
        'If the SDK seems to need platform code, the logic belongs on the platform side of the ' +
        'contract instead.',
      from: { path: '^packages/game-sdk/' },
      to: { path: [...PLATFORM_INTERNALS, ...APP_TARGETS, ...GAME_TARGETS] },
    },
    {
      name: 'no-zod-in-pure-settings',
      severity: 'error',
      comment:
        'settings-form.ts exists so a browser can compute which settings fields to show without ' +
        'shipping a validator. It is the presentation half of the settings contract: the ' +
        'descriptor shape plus its pure readers, reachable at ' +
        `${SDK_NAME}/settings-form and importing nothing. The validating half — the zod schemas ` +
        'and checkSettingsForm — lives in settings.ts and imports this module, never the other ' +
        'way round. A zod edge here, direct or through settings.ts, silently puts the whole ' +
        'validator back in the create-lobby chunk (measured at 79.6 kB raw, PER-115) to ' +
        're-check JSON the server already validated at registry load. Nothing else in the ' +
        'suite would go red if that happened, which is why this rule exists rather than a ' +
        'comment. Need to validate? Put it in settings.ts. Need a new pure reader for the ' +
        'descriptor? It belongs here, and it must stay dependency-free.',
      from: { path: SDK_PURE_SETTINGS },
      to: { path: [ZOD_MODULES, SDK_SETTINGS_SCHEMAS] },
    },
    {
      name: 'no-game-node-builtins',
      severity: 'error',
      comment:
        'Game modules are pure: no I/O, no ambient clock, no filesystem. That purity is what ' +
        'buys replays, crash recovery and reproducible tests. Use ctx.now and ctx.rng; if you ' +
        'genuinely need a capability, it belongs behind an SDK-provided ctx facility, decided ' +
        'by ADR.',
      from: { path: '^games/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-platform-core-node-builtins',
      severity: 'error',
      comment:
        'This rule does not say "platform-core reaches no Node builtin" — ADR-0011 §1 shows we ' +
        'do not want that (Workers support node:crypto in full) and §3 shows a path denylist ' +
        'cannot express it. What it says is: every Node builtin in packages/platform-core/src is ' +
        'in the exception list above, and that list is short enough to read. One entry, named, ' +
        'governed by an ADR. A new node: import at module top level is load-bearing for a whole ' +
        'entrypoint, because src/index.ts re-exports every subtree, and nothing else goes red: ' +
        'the unit tests run on Node, typecheck is clean, and the break surfaces at build time in ' +
        'a consumer CI does not exercise (ADR-0011 §2 — webpack says UnhandledSchemeError, never ' +
        '"edge runtime"). That gap is why this is a rule and not a comment. The fix is to take ' +
        'the capability as a port instead of importing it: the RandomSource / Clock / IdSource ' +
        'interfaces in runtime.ts exist for exactly this, and webCryptoRandomSource() is the ' +
        'documented default. If the capability has no WebCrypto equivalent with the same ' +
        'signature (async vs sync counts as "no equivalent"), do not make the identity API async ' +
        'to satisfy a bundler: an edge consumer gets @playhall/platform-core/edge, a second ' +
        'entrypoint whose graph reaches no Node builtin, specified surface-by-surface in ' +
        'ADR-0011 §Decision part 2 and deliberately not built until a consumer exists. Build ' +
        'that to spec, or amend ADR-0011 — do not add yourself to the exception above.',
      from: {
        path: '^packages/platform-core/src/',
        pathNot: PLATFORM_CORE_NODE_BUILTIN_EXCEPTIONS,
      },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A dependency cycle makes version pinning, incremental build and bundle splitting ' +
        'unreliable, and it usually means two modules should be one or three.',
      from: {},
      to: { circular: true },
    },
    {
      // Deliberately `warn`, not `error` (ADR-0002 §2): a temporarily unreferenced file
      // mid-development is not a boundary violation, and failing the build on it teaches
      // people to ignore the tool.
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'This module is not imported by anything and imports nothing. Usually dead code or a ' +
        'file that lost its last consumer. Not a boundary violation, so it does not fail CI.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig[^/]*\\.json$',
          '(^|/)[^/]+\\.config\\.(js|cjs|mjs|ts|mts)$',
          '(^|/)src/index\\.ts$',
          '^apps/web/', // Next.js route files are entered by the framework, not by an import.
        ],
      },
      to: {},
    },
    {
      /**
       * Not in ADR-0002 §2, and deliberately `warn`: this one guards the *gate itself*. An
       * import dependency-cruiser cannot resolve is an edge missing from the graph, so every
       * rule above silently passes for it. That is the one failure mode that would make this
       * whole file decorative, so it has to be visible in the output rather than inferred.
       * `warn` because a legitimately virtual module (framework-generated, type-only ambient)
       * should not block a merge.
       */
      name: 'not-to-unresolvable',
      severity: 'warn',
      comment:
        'This import could not be resolved, so it is invisible to every boundary rule. If it ' +
        'is a path alias, mirror it in enhancedResolveOptions.alias below or the boundary gate ' +
        'is blind to imports made through it.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],

  options: {
    /**
     * Type-only imports are real boundary edges — `import type { Board } from '...'` couples
     * the game to platform internals just as hard as a value import.
     */
    tsPreCompilationDeps: true,

    /** Third-party code is allowed; we do not audit inside it. */
    doNotFollow: { path: '(^|/)node_modules/' },

    /**
     * `node_modules` is deliberately NOT excluded, only `doNotFollow`ed. The difference matters:
     * `doNotFollow` keeps a third-party package in the graph as a leaf, so an edge *to* it is
     * visible to the rules; `exclude` deletes the module, and with it every edge pointing at it.
     * Excluding it left the gate unable to express any rule about a game's third-party
     * dependencies at all — `no-game-to-colyseus` would have passed silently on the one case
     * that matters most, a game importing an installed `@colyseus/schema`. Proven by the
     * `no-game-to-colyseus.fixture` negative test, which fails without this line.
     *
     * Cost is bounded: each third-party package adds one leaf node and is never traversed.
     */
    exclude: { path: '(^|/)(dist|\\.next|coverage|\\.turbo)/' },

    /**
     * Resolution only — never used to compile. dependency-cruiser takes one tsconfig for the
     * whole cruise, so the path aliases from the per-app tsconfigs are mirrored in this file.
     * An alias the gate cannot resolve is an edge missing from the graph, and a missing edge
     * passes every rule above. See the header of the file itself.
     */
    tsConfig: { fileName: join(__dirname, 'tools', 'boundaries', 'tsconfig.resolve.json') },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'types', 'default'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}

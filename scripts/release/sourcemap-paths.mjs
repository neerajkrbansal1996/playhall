/**
 * Rewrites a bundle's source-map `sources` to repo-root-relative paths, and
 * refuses to let a path that escapes the repository through.
 *
 * Why this exists rather than a line in a runbook. A bundler computes `sources`
 * relative to the *outfile*, so the emitted paths are a function of where the
 * build ran. `docs/ENVIRONMENTS.md` §10 used to instruct "build in-tree" and
 * leave it there — and the very first evidence build broke the instruction
 * without anyone noticing, because a build that writes its outfile outside the
 * tree still succeeds. Sentry then rendered the frame as
 *
 *     ../../../../../../../Users/<name>/…/.worktrees/per-7/apps/realtime/src/index.ts
 *
 * and used that same string as the issue *culprit* — the one-line identity shown
 * in every issue list, alert and digest. Two costs, neither recoverable after
 * the fact: the trace is unreadable to anyone on a different machine, and a
 * username plus an internal directory layout is now on a third-party record we
 * do not delete.
 *
 * So the clean path is made a property of the artifact and asserted, instead of
 * a property of the operator's working directory and hoped for. `..` in a
 * rewritten source is the escape signal, and it is a hard failure.
 */
import { isAbsolute, relative, resolve } from 'node:path'

/** A rewritten source that still points outside the repository. */
export class SourcePathEscapedError extends Error {
  constructor(offenders) {
    super(
      `source map contains ${offenders.length} path(s) outside the repository — ` +
        `the build wrote its outfile outside the tree, so Sentry would render ` +
        `absolute build-machine paths and leak them permanently:\n` +
        offenders.map((o) => `  ${o.original}  ->  ${o.rewritten}`).join('\n'),
    )
    this.name = 'SourcePathEscapedError'
    this.offenders = offenders
  }
}

/**
 * Maps every `sources` entry from "relative to `outDir`" to "relative to
 * `repoRoot`", using POSIX separators so the artifact is identical on any host.
 *
 * Entries a bundler synthesises rather than reads from disk — esbuild's
 * `<stdin>`, virtual plugin namespaces like `sentry:foo` — are left untouched:
 * they are not paths, and relativising them would invent a file that does not
 * exist.
 */
export function rewriteSources(sources, { outDir, repoRoot }) {
  const rewritten = []
  const offenders = []

  for (const original of sources) {
    if (isSynthetic(original)) {
      rewritten.push(original)
      continue
    }

    const abs = isAbsolute(original) ? original : resolve(outDir, original)
    const next = relative(repoRoot, abs).split('\\').join('/')

    // `..` is the only signal that matters. It is what a path climbing out of
    // the repo looks like, and it is what turned into a home directory in
    // Sentry. An absolute input lands here too: `relative()` from the repo root
    // to somewhere else on the disk also starts with `..`.
    if (next === '' || next.startsWith('../') || next === '..') {
      offenders.push({ original, rewritten: next })
    }
    rewritten.push(next)
  }

  return { sources: rewritten, offenders }
}

function isSynthetic(source) {
  return source.startsWith('<') || /^[a-z][a-z0-9+.-]*:/i.test(source)
}

/**
 * Rewrites a parsed source map in place and clears `sourceRoot`.
 *
 * `sourceRoot` is dropped deliberately: Sentry joins it onto every `sources`
 * entry, so a leftover root would silently re-prefix the repo-relative paths we
 * just computed and break artifact matching for every frame at once.
 */
export function normaliseSourceMap(map, { outDir, repoRoot }) {
  const { sources, offenders } = rewriteSources(map.sources ?? [], { outDir, repoRoot })
  if (offenders.length > 0) throw new SourcePathEscapedError(offenders)

  map.sources = sources
  delete map.sourceRoot
  return map
}

/**
 * Asserts the property a reader of a Sentry trace actually depends on: the frame
 * they will click resolves to a path that exists in this repository.
 *
 * `expectEntry` is the entry point's repo-relative path. Checking it by name is
 * what makes the gate falsifiable — a map whose `sources` are all clean but
 * whose entry module is missing would otherwise pass while symbolicating
 * nothing useful.
 */
export function assertResolvable(map, { expectEntry, fileExists }) {
  const problems = []

  for (const source of map.sources ?? []) {
    if (isSynthetic(source)) continue
    if (!fileExists(source)) problems.push(`${source} — not a file in this repository`)
  }

  if (expectEntry !== undefined && !(map.sources ?? []).includes(expectEntry)) {
    problems.push(`expected the entry module at ${expectEntry}, and no source matched it`)
  }

  return problems
}

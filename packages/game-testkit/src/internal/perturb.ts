/**
 * Action perturbation — the corpus generator behind the `accepted ⊆ offered`
 * direction of `legal-actions-agree` (ADR-0012).
 *
 * The rule is that an action a game validates as legal must be byte-identical,
 * after `actionSchema`, to one `getLegalActions` offered for that seat at that
 * state. One move has exactly one wire spelling. The direction that enforces it
 * used to draw its corpus from the subject's `probeActions` and from the
 * actions offered to the *other* seats — both sampling arguments, and neither
 * able to contain a spelling `getLegalActions` omits everywhere. That is
 * precisely the defect PER-198 found in chess, where `chess.js` silently drops
 * a `promotion` letter on a move that cannot promote, so every ordinary move
 * had a second spelling nothing enumerated.
 *
 * Perturbation builds the corpus *relative to the position* instead: take an
 * action the game itself offered here, add one field `actionSchema` declares
 * and the action does not carry, and re-parse. A payload the schema rejects is
 * dropped — the outer wall already stops it and the game never sees it — so
 * what survives measures exactly the gap between `actionSchema` and the offered
 * set, which is where this defect class lives.
 *
 * ## Why it reads zod's internals
 *
 * The schema already contains the answer, and asking the author to restate it
 * in a subject field is a second source of truth that drifts (ADR-0012 rejected
 * that as the primary mechanism). zod v3 exposes what we need on `_def`, so
 * that is what we read. This is real coupling, and the mitigation is the one
 * the ADR made the condition of approval: **absence is loud**. Everything here
 * reports what it could not read rather than returning an empty list, so a zod
 * upgrade that moves the internals makes the suite say "could not read
 * actionSchema" instead of quietly generating nothing. (Measured: a `zod/v4`
 * schema has no `_def.typeName` at all, so it takes the loud path.)
 *
 * Nothing here imports zod. The introspector is structural, so it works against
 * whichever copy of zod a game resolved.
 */

/**
 * Wrappers that change nothing about which keys the *input* declares, mapped to
 * the `_def` key holding the schema underneath. zod v3 does not use one name
 * for this: `.optional()` stores `innerType`, `.refine()` stores `schema`,
 * `.brand()` stores `type`, `.pipe()` stores `in`.
 *
 * `ZodEffects` and `ZodPipeline` are the subtle two, because they can change
 * the *output* type — `.transform()` and the right-hand side of `.pipe()`. That
 * is fine here, and deliberately so: perturbation builds its probe *before*
 * `actionSchema` runs and then re-parses it, and the `listedKeys` comparison
 * that follows is on the parsed value. So the thing this collector needs is the
 * set of keys the schema *accepts on the wire*, which is exactly what
 * `ZodEffects._def.schema` and `ZodPipeline._def.in` describe.
 *
 * Added in response to the CTO's review of PER-211: a `.superRefine()` checking
 * `from !== to`, or a `.brand()` stopping a raw object being passed as an
 * action, are both ordinary things to put on an action schema. Without these
 * four the introspector reports "cannot read actionSchema" on them, which would
 * make the declared fallback routine — a named revisit trigger in ADR-0012 —
 * for no better reason than four `_def` key names.
 */
const TRANSPARENT_WRAPPERS: ReadonlyMap<string, string> = new Map([
  ['ZodOptional', 'innerType'],
  ['ZodNullable', 'innerType'],
  ['ZodDefault', 'innerType'],
  ['ZodReadonly', 'innerType'],
  ['ZodCatch', 'innerType'],
  ['ZodEffects', 'schema'],
  ['ZodBranded', 'type'],
  ['ZodPipeline', 'in'],
])

/**
 * Wrappers that make a key omissible, which is what makes it perturbable: a
 * client may or may not send it, so the game has to have an opinion about the
 * spelling that does.
 */
const OMISSIBLE_WRAPPERS: ReadonlySet<string> = new Set(['ZodOptional', 'ZodDefault'])

const UNION_TYPES: ReadonlySet<string> = new Set(['ZodUnion', 'ZodDiscriminatedUnion'])

/**
 * Types that declare no keys *by construction*, so there is nothing in them to
 * perturb and nothing for an author to declare.
 *
 * This set is the difference between "covered, and there was nothing to do" and
 * "not covered". `z.union([z.object({…}), z.literal('resign')])` is an ordinary
 * action schema; reporting its `resign` variant as a gap would tell the author
 * to declare a perturbation for a schema that has no keys to carry one. Only a
 * node we cannot classify at all is a gap — and that distinction is load-bearing,
 * because the loud note is the whole enforcement mechanism of ADR-0012's
 * decision 3 and a note that cries gap on a covered schema is how that channel
 * gets tuned out.
 */
const KEYLESS_TYPES: ReadonlySet<string> = new Set([
  'ZodLiteral',
  'ZodString',
  'ZodNumber',
  'ZodBoolean',
  'ZodEnum',
  'ZodNativeEnum',
  'ZodNull',
  'ZodUndefined',
])

/**
 * How deep into nested objects the collector looks. Two is the number that
 * matters: chess's `promotion` lives at `move.promotion` inside a
 * discriminated-union member, so a top-level-keys-only collector would miss the
 * motivating defect entirely. Three leaves one level of headroom and keeps the
 * walk bounded, which is what makes the cost law in ADR-0012 hold.
 */
const MAX_NESTING = 3

/** Representative values for the unconstrained scalar types. */
const PROBE_STRING = 'atrium-probe'
const PROBE_NUMBER = 1

/** One field to add to an offered action, and the value to add. */
export interface PerturbationField {
  /** Dotted path from the action root: `face`, or `move.promotion`. */
  readonly path: string
  readonly segments: readonly string[]
  readonly value: unknown
  readonly source: 'actionSchema' | 'declared'
}

/** Something the introspector could not read. Each one becomes a loud note. */
export interface PerturbationGap {
  /** Names the thing, e.g. `optional field 'meta'` or `actionSchema`. */
  readonly subject: string
  /** Why it could not be read, e.g. `ZodRecord`. */
  readonly reason: string
}

export interface PerturbationPlan {
  /**
   * One entry per `(path, value)` probe to try against each offered action.
   * Deduplicated by path: a union whose members declare the same optional key
   * contributes it once, with the first readable representative value.
   */
  readonly fields: readonly PerturbationField[]
  readonly gaps: readonly PerturbationGap[]
  /** True when `actionSchema` was an introspectable zod object or union schema. */
  readonly schemaReadable: boolean
}

/** A perturbation the subject declares itself, for a schema we cannot read. */
export interface DeclaredPerturbation {
  /** Dotted path, so a nested field can be declared too. */
  readonly key: string
  readonly values: readonly unknown[]
}

/* -------------------------------------------------------------------------- */
/* zod v3 structural accessors                                                */
/* -------------------------------------------------------------------------- */

function defOf(node: unknown): Record<string, unknown> | null {
  if (typeof node !== 'object' || node === null) return null
  const def: unknown = (node as { _def?: unknown })._def
  if (typeof def !== 'object' || def === null) return null
  return def as Record<string, unknown>
}

function typeNameOf(node: unknown): string | null {
  const name = defOf(node)?.['typeName']
  return typeof name === 'string' ? name : null
}

/** The schema one transparent wrapper down, or `null` if this is not one. */
function innerOf(node: unknown): unknown | null {
  const name = typeNameOf(node)
  if (name === null) return null
  const key = TRANSPARENT_WRAPPERS.get(name)
  if (key === undefined) return null
  const inner: unknown = defOf(node)?.[key]
  return inner === undefined ? null : inner
}

/** Strips wrappers that leave the underlying shape alone. */
function unwrap(node: unknown): unknown {
  let current = node
  // Bounded rather than `while (true)`: a schema that somehow wraps itself must
  // not hang the gate.
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = innerOf(current)
    if (inner === null) return current
    current = inner
  }
  return current
}

/**
 * Whether a field may be omitted from the wire payload — which is what makes it
 * perturbable, since the game then has to have an opinion about the spelling
 * that sends it.
 *
 * Walks the wrapper chain rather than looking only at the outermost node:
 * `z.string().optional().refine(…)` is `ZodEffects(ZodOptional(ZodString))`, and
 * reading only the outside would classify it as required and then silently find
 * nothing inside it.
 */
function isOmissible(node: unknown): boolean {
  let current = node
  for (let depth = 0; depth < 8; depth += 1) {
    const name = typeNameOf(current)
    if (name === null) return false
    if (OMISSIBLE_WRAPPERS.has(name)) return true
    const inner = innerOf(current)
    if (inner === null) return false
    current = inner
  }
  return false
}

function shapeOf(node: unknown): Record<string, unknown> | null {
  if (typeNameOf(node) !== 'ZodObject') return null
  // `.shape` is a getter in zod v3; `_def.shape` is the thunk behind it.
  const shape: unknown = (node as { shape?: unknown }).shape
  if (typeof shape !== 'object' || shape === null) return null
  return shape as Record<string, unknown>
}

function optionsOf(node: unknown): readonly unknown[] | null {
  const name = typeNameOf(node)
  if (name === null || !UNION_TYPES.has(name)) return null
  const options: unknown = defOf(node)?.['options']
  return Array.isArray(options) ? (options as readonly unknown[]) : null
}

/** How to name a node we could not read, in a note a game author can act on. */
function describe(node: unknown): string {
  const name = typeNameOf(node)
  if (name !== null) return name
  if (typeof node !== 'object' || node === null) return `a ${typeof node}`
  if (defOf(node) !== null) {
    return 'an object with a _def but no zod v3 _def.typeName (zod v4, or a custom parser)'
  }
  return 'an object with no zod v3 _def (a custom parser, or a hand-rolled schema)'
}

/* -------------------------------------------------------------------------- */
/* Value sampling                                                             */
/* -------------------------------------------------------------------------- */

export type SampledValue =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }

/**
 * One representative value for a field type.
 *
 * A value the schema then rejects is not a problem — the perturbation is
 * dropped before `validateAction` is called — so this only has to be right
 * often enough to be useful, and loud when it is not right at all.
 */
export function sampleValue(node: unknown, unionDepth = 0): SampledValue {
  const bare = unwrap(node)
  const name = typeNameOf(bare)
  if (name === null) return { ok: false, reason: describe(bare) }
  const def = defOf(bare) ?? {}

  switch (name) {
    case 'ZodLiteral':
      return { ok: true, value: def['value'] }
    case 'ZodEnum': {
      const values: unknown = def['values']
      if (!Array.isArray(values) || values.length === 0) {
        return { ok: false, reason: 'ZodEnum with no values' }
      }
      return { ok: true, value: values[0] }
    }
    case 'ZodNativeEnum': {
      const values: unknown = def['values']
      if (typeof values !== 'object' || values === null) {
        return { ok: false, reason: 'ZodNativeEnum with no values' }
      }
      const first = Object.values(values)[0]
      if (first === undefined) return { ok: false, reason: 'ZodNativeEnum with no values' }
      return { ok: true, value: first }
    }
    case 'ZodString':
      return { ok: true, value: PROBE_STRING }
    case 'ZodNumber':
      return { ok: true, value: PROBE_NUMBER }
    case 'ZodBoolean':
      return { ok: true, value: true }
    default:
      break
  }

  // One option deep, as ADR-0012 specifies: enough for `z.union([z.literal(1),
  // z.string()])`, and bounded so a deeply nested union cannot make the corpus
  // grow without a matching line in the cost law.
  const options = optionsOf(bare)
  if (options !== null && unionDepth === 0) {
    for (const option of options) {
      const sampled = sampleValue(option, unionDepth + 1)
      if (sampled.ok) return sampled
    }
    return { ok: false, reason: `${name} with no option the value sampler can read` }
  }

  return { ok: false, reason: name }
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the optional fields `actionSchema` declares, with one representative
 * value each, and merges in whatever the subject declared itself.
 *
 * A declared perturbation wins over a schema-derived one on the same path: the
 * author is the one who knows the value that matters. The gaps are reported
 * either way, so a subject that papers over an unreadable schema with
 * `actionPerturbations` still says out loud that the schema could not be read.
 */
export function planPerturbations(
  schema: unknown,
  declared: readonly DeclaredPerturbation[] | undefined,
): PerturbationPlan {
  const fromSchema: PerturbationField[] = []
  const gaps: PerturbationGap[] = []
  const readability = collectFields(schema, [], 0, fromSchema, gaps)
  const schemaReadable = readability !== 'unreadable'

  if (!schemaReadable) {
    gaps.push({ subject: 'actionSchema', reason: describe(unwrap(schema)) })
  }

  const byPath = new Map<string, PerturbationField[]>()
  for (const field of fromSchema) {
    // First reader of a path wins: a discriminated union whose members declare
    // the same optional key contributes one probe, not one per member.
    if (!byPath.has(field.path)) byPath.set(field.path, [field])
  }
  for (const entry of declared ?? []) {
    const segments = entry.key.split('.').filter((segment) => segment.length > 0)
    if (segments.length === 0) continue
    byPath.set(
      segments.join('.'),
      entry.values.map((value) => ({
        path: segments.join('.'),
        segments,
        value,
        source: 'declared' as const,
      })),
    )
  }

  return { fields: [...byPath.values()].flat(), gaps, schemaReadable }
}

/**
 * What the collector was able to make of a node.
 *
 * `'keyless'` is the one that matters: it is a positive reading, not a failure.
 * Only `'unreadable'` becomes a loud note, because only `'unreadable'` leaves
 * the author with something to do.
 */
type Readability = 'keys' | 'keyless' | 'unreadable'

/**
 * Walks a schema for optional fields, returning how well it could read the
 * node. The caller turns `'unreadable'` into the loud note.
 */
function collectFields(
  node: unknown,
  prefix: readonly string[],
  depth: number,
  out: PerturbationField[],
  gaps: PerturbationGap[],
): Readability {
  const bare = unwrap(node)

  const shape = shapeOf(bare)
  if (shape !== null) {
    for (const key of Object.keys(shape)) {
      collectField(shape[key], [...prefix, key], depth, out, gaps)
    }
    return 'keys'
  }

  const options = optionsOf(bare)
  if (options !== null) {
    let readability: Readability = 'unreadable'
    for (const option of options) {
      const member = collectFields(option, prefix, depth, out, gaps)
      if (member === 'unreadable') {
        // Only a member we cannot classify at all. A `z.literal('resign')`
        // variant is covered with nothing to do, and saying otherwise would
        // send the author looking for a perturbation that cannot exist.
        gaps.push({
          subject:
            prefix.length === 0
              ? 'a variant of actionSchema'
              : `a variant of the field '${prefix.join('.')}'`,
          reason: describe(unwrap(option)),
        })
        continue
      }
      if (member === 'keys' || readability === 'unreadable') readability = member
    }
    return readability
  }

  const name = typeNameOf(bare)
  return name !== null && KEYLESS_TYPES.has(name) ? 'keyless' : 'unreadable'
}

function collectField(
  field: unknown,
  segments: readonly string[],
  depth: number,
  out: PerturbationField[],
  gaps: PerturbationGap[],
): void {
  const path = segments.join('.')

  if (isOmissible(field)) {
    const sampled = sampleValue(field)
    if (sampled.ok) {
      out.push({ path, segments, value: sampled.value, source: 'actionSchema' })
    } else {
      gaps.push({ subject: `optional field '${path}'`, reason: sampled.reason })
    }
    return
  }

  if (depth + 1 >= MAX_NESTING) return

  // A *required* nested object can declare optional keys of its own, and that
  // is where the motivating defect actually lives: chess sends
  // `{ type: 'move', move: { from, to, promotion? } }`.
  const bare = unwrap(field)
  if (shapeOf(bare) !== null || optionsOf(bare) !== null) {
    collectFields(bare, segments, depth + 1, out, gaps)
  }
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                   */
/* -------------------------------------------------------------------------- */

const OBJECT_PROTO: unknown = Object.getPrototypeOf({})

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === OBJECT_PROTO || proto === null
}

export type Perturbed =
  | { readonly ok: true; readonly value: unknown }
  /** Not applicable here: the path does not exist, or the action already carries it. */
  | { readonly ok: false }

/**
 * `{ ...action, [path]: value }`, for a dotted path, without touching the
 * original. Declines when the action already carries the key — adding a field
 * that is already there is not a second spelling — or when the parent on the
 * path is absent, which is what a `resign` action looks like to a probe aimed
 * at `move.promotion`.
 */
export function perturb(action: unknown, field: PerturbationField): Perturbed {
  const { segments, value } = field
  const leaf = segments[segments.length - 1]
  if (leaf === undefined) return { ok: false }

  const parents: Record<string, unknown>[] = []
  let cursor: unknown = action
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!isPlainRecord(cursor)) return { ok: false }
    parents.push(cursor)
    const key = segments[i]
    if (key === undefined) return { ok: false }
    cursor = cursor[key]
  }
  if (!isPlainRecord(cursor)) return { ok: false }
  if (Object.prototype.hasOwnProperty.call(cursor, leaf)) return { ok: false }

  let rebuilt: unknown = { ...cursor, [leaf]: value }
  for (let i = parents.length - 1; i >= 0; i -= 1) {
    const parent = parents[i]
    const key = segments[i]
    if (parent === undefined || key === undefined) return { ok: false }
    rebuilt = { ...parent, [key]: rebuilt }
  }
  return { ok: true, value: rebuilt }
}

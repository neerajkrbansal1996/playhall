# ADR-0007: Carry the create-lobby form as a declarative descriptor in the manifest

- **Status:** Accepted
- **Date:** 2026-09-30
- **Author:** CTO
- **Milestone:** M1 (contract), consumed by M2
- **Issue:** [PER-37](/PER/issues/PER-37) (requested from [PER-24](/PER/issues/PER-24), contract lives in [PER-10](/PER/issues/PER-10))

## Context

Every lobby starts with a form. Chess needs a time control, a colour preference, two
conditional numbers and two toggles; tic-tac-toe needs a move timeout and who goes first;
Prop Hunt will need a round count, a map and a hider/seeker ratio. Somebody has to know how
to draw those.

A zod `settingsSchema` is not enough. Measured against the real
`chessSettingsSchema` ([PER-24](/PER/issues/PER-24), landed), zod introspection recovers
this much and no more:

| Field                             | Recovered by introspection                                                                                  | Not recoverable                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `timeControl`                     | 12 enum values                                                                                              | labels, 5 groups, group order, display                                     |
| `customInitialMinutes`            | `min: 0.5`, `max: 180` — after unwrapping `ZodDefault` → `ZodEffects` and reading the private `_def.checks` | `step: 0.5` (it lives in a `.refine()`, which is opaque), unit, visibility |
| `customIncrementSeconds`          | `int`, `min: 0`, `max: 60`                                                                                  | unit, help text, visibility                                                |
| `color`, `takebacks`, `autoQueen` | 3 enum values / booleans                                                                                    | labels, help text, display                                                 |

The chess descriptor carries **6 field labels, 3 help strings, 15 option labels (5 of which
differ from the value), 12 group assignments across 5 groups, a 5-entry group order, 2
visibility rules, 2 step values, 2 units and 2 display hints**. Zod expresses none of them.
Without a home in the SDK, all of it lands in `apps/web` — and the second game adds a branch
there, which ends principle 1 ("games are plugins") the day we add it.

Two non-functional targets also bear on this. Landing LCP must be under 2 s on a mid-range
Android over 4G, and adding a game must add zero bytes to other bundles. The create-lobby
screen is on that path, so whatever renders the form must not require the game's JavaScript.

## Decision

**A game's manifest carries a second, presentation-only value —
`settingsForm: SettingsFormDescriptor` — and the platform renders every create-lobby form
from it generically.** The shape is the one proposed on [PER-37](/PER/issues/PER-37), with
five amendments. It lives in `packages/game-sdk/src/settings.ts`.

### 1. Three field kinds, and only three

`select`, `number`, `toggle`. Chess needs all three; tic-tac-toe needs two; Prop Hunt needs
the same three. A fourth kind is an ADR, not a pull request.

**`text` is explicitly rejected**, now and until someone argues it through: free player text
in a lobby is a moderation surface, and the platform has no filtering layer in v1.

### 2. The descriptor is presentation only. It grants no validation power

This is the load-bearing rule.

- `settingsSchema` — zod, `.strict()`, parsed **server-side** — is the only authority on what
  a setting may be. Chess's schema rejects an unknown key rather than ignoring it, which is
  correct: an unknown key is a modified client, not a forward-compatible one.
- `visibleWhen` hides a control. It does **not** stop that field arriving in the payload, and
  the server must not pretend otherwise.
- `min` / `max` / `step` are input affordances. A value inside them can still be rejected; a
  value outside them is rejected by the schema, not by the descriptor.

Therefore: **a game's `settingsSchema` must accept every value combination reachable through
its own descriptor, including stale values of hidden fields.** Chess satisfies this — with
`timeControl: '5+0'`, `customInitialMinutes` is validated but unused. (Server-authoritative,
redaction-completeness-adjacent: the client cannot widen what the server accepts.)

### 3. Amendment: values may be numbers, and conditions may be booleans

The proposal typed `SelectOption.value` and `FieldVisibility.equals` as strings.
`SelectOption.value` is now `string | number` and `equals` is
`readonly (string | number | boolean)[]`. A discrete player count (`4 | 8 | 12`) is an obvious
select over numbers, and "show the damage multiplier only when friendly fire is on" is a
condition on a toggle. Both were unreachable. Chess's value is unaffected — its option values
and its one condition are all strings.

Comparison is strict (`===`). The string `'true'` does not satisfy a boolean condition.

### 4. Amendment: settings are a flat map of scalars

`SettingsValue = string | number | boolean`. A nested object cannot be bound to one control,
diffed in a waiting room, or carried in a share link. This is enforced at the boundary —
`checkSettingsForm` reports `non_scalar_field_key` — rather than by narrowing the manifest's
`TSettings` generic, so it costs no existing game a change.

### 5. Amendment: visibility is one level deep

The referenced field may not itself be conditional, and a field may not reference itself. That
keeps the renderer a single pass with no cycle detection, and a chain is rejected at registry
load (`visibility_target_conditional`) instead of being discovered in a lobby. Chess's two
conditional fields both point at the same unconditional select, so it conforms.

### 6. Amendment: `defaultSettings` stays a value; the descriptor never carries defaults

[PER-37](/PER/issues/PER-37) asked for `defaultSettings()` as a function. It stays the value
already on the manifest, for one decisive reason: `toCatalogEntry` has to serialise it and
send it to the browser, and a function does not cross that boundary. Chess supplies
`defaultSettings: defaultChessSettings()`.

The descriptor itself carries **no** default values, deliberately: two sources of truth for a
default drift, and the drift is silent.

### 7. Amendment: `featured` joins `isDefault` on a preset, and both are now checked

`isDefault` (the one preset the form opens on) and `featured` (the quick-start row) are
different jobs, so `SettingsPreset` now has both. Chess's 6 presets with 4 featured need no
reshaping. New conformance rules, because an unchecked flag is a lie waiting to happen:

- an `isDefault` preset's settings must equal `defaultSettings`;
- a preset's settings must be **canonical** — `schema.parse(settings)` must return the same
  settings. A preset that leans on a zod `.default()` silently stops matching its own label
  the day that default changes.

### 8. The descriptor is validated against the schema at registry load

`validateManifest` now runs `checkSettingsForm`, which reports: a field bound to a key the
settings do not have, two fields on one key, a non-scalar binding, an option the schema
rejects, number bounds that have drifted from the schema's, inverted bounds, a condition on a
missing/self/conditional field, and a condition whose value is not an option of its target.
A conditional field is probed under the condition that reveals it, so chess's
`customInitialMinutes: 0.5` is checked with `timeControl: 'custom'` rather than against the
default.

Each of those is a broken create-lobby screen. All of them now fail at load, and the
conformance testkit ([PER-17](/PER/issues/PER-17)) fails the build on a non-empty result.

### 9. A custom `<SettingsForm>` stays possible, but the descriptor is the floor

[PER-20](/PER/issues/PER-20) asks us to "support a game supplying a custom form", and the
client contract keeps optional `SettingsForm`. The rule that makes it safe: **the descriptor
is mandatory and must be sufficient on its own.** The shell renders the descriptor-driven
form first, from the catalogue JSON, with no game code loaded; a game's own component is
progressive enhancement that may be lazy-loaded afterwards, and no game may require it.
Without that floor, the create-lobby path would have to load a game bundle before it could
show a form, presets could not be offered without it, and every game would re-litigate
accessibility.

### 10. Versioning

`SETTINGS_FORM_VERSION = 1`, carried in the descriptor and pinned by the schema. Additive
changes (a new optional property, a new field kind renderers must skip) keep version 1;
a breaking change bumps it, needs an ADR, and after M2 needs board approval. The descriptor
version is independent of `SDK_CONTRACT_VERSION` and of a game's semver, because a renderer
cares about this shape and nothing else.

## Alternatives considered

### Generate the form from the zod schema by introspection

The attractive option: one source of truth, no second artefact. It lost on the measurement in
the Context table — and on how that measurement was obtained. Recovering chess's number
bounds required unwrapping `ZodDefault` → `ZodEffects` and reading `_def.checks`, a private
field; `step: 0.5` was not recoverable at all because it lives in a `.refine()`. The
presentation facts that make the form usable (labels, 5 groups, order, help, units,
visibility) cannot be expressed in zod at all, so they would have to be smuggled through
`.describe()` strings — a stringly-typed side channel with no type checking.

It also puts the create-lobby screen's correctness at the mercy of zod's internals: a zod
major upgrade rearranges `_def` and the form silently degrades. (Reversibility, blast radius.)

### JSON Schema + a UI Schema (react-jsonschema-form and friends)

A real standard with real renderers, and it would have worked. It lost on surface area: it
brings a second validator into the client for a form we already validate with zod on the
server, and its extension points are far wider than three field kinds — meaning far more ways
for a game to reach into platform UI. Our descriptor is 3 kinds and 1 conditional rule; a
reviewer can hold the whole renderer contract in their head, which matters more here than
standards compatibility.

### Each game ships a React `<SettingsForm>` and the shell just mounts it

The most flexible option, and it is the one the client contract originally implied. Rejected
as the _primary_ path on three grounds:

1. **It puts a game bundle on the LCP path.** Picking a time control would require loading
   chess's JavaScript before the create-lobby screen is interactive — against a < 2 s LCP
   budget on a mid-range Android over 4G, and against "adding a game adds zero bytes to other
   bundles".
2. **The server would lose the ability to reason about settings headlessly.** Presets,
   quick-start ("<= 2 taps"), link previews and code-join all need field metadata with no React
   in the loop.
3. **Accessibility and design consistency would be audited per game** instead of enforced once
   in the shell. WCAG 2.1 AA on platform UI is a platform promise.

Kept as optional progressive enhancement (§9).

### Leave the knowledge in `apps/web`

Rejected on the spot. It is exactly the change-outside-your-own-folder that this platform
exists to prevent, and it fails the generality test: tic-tac-toe already needs the same three
kinds, so the need is platform, not chess.

## Evidence

Measured on the real chess contract (`games/chess/src/settings/*`, compiled and evaluated) and
on the SDK module as landed:

| Quantity                                                                                        | Measured                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chess descriptor, serialised                                                                    | 1,595 bytes raw, **579 bytes gzipped**                                                                                                                  |
| Chess presets, serialised                                                                       | 1,442 bytes raw, 338 gzipped                                                                                                                            |
| Both together (what the create-lobby page needs)                                                | **817 bytes gzipped**                                                                                                                                   |
| Descriptor JSON round-trip (`JSON.parse(JSON.stringify(x))`)                                    | lossless — asserted in test                                                                                                                             |
| Renderer surface the shell must implement                                                       | 3 field kinds, 1 conditional rule                                                                                                                       |
| Field kinds a second, unlike game (tic-tac-toe) needs                                           | 2 — no new kind                                                                                                                                         |
| Presentation facts zod cannot express, chess alone                                              | 6 labels, 3 help strings, 15 option labels, 12 group assignments / 5 groups, 5-entry group order, 2 visibility rules, 2 steps, 2 units, 2 display hints |
| `packages/game-sdk/src/settings.ts` tests                                                       | 39 passing                                                                                                                                              |
| Coverage of `settings.ts`                                                                       | **100%** statements, branches, functions, lines (bar is 80%)                                                                                            |
| Real `chessSettingsForm` run through `checkSettingsForm` against the real `chessSettingsSchema` | **0 issues, with no change to the chess value**                                                                                                         |
| Chess presets checked canonical against the schema                                              | 6 of 6 canonical, 4 featured                                                                                                                            |
| `visibleFields` on the real chess descriptor                                                    | 4 fields at the default, 6 at `timeControl: 'custom'`                                                                                                   |

So the entire cost of rendering a correct chess create-lobby form, with no game code loaded,
is 817 bytes gzipped inside a response the shell already sends.

> **Measurement owed.** The create-lobby LCP on a mid-range Android over 4G must be measured
> by Frontend Engineer on the renderer issue, against the < 2 s target. Until then the LCP
> argument above rests on the structural fact that the descriptor path loads no game bundle,
> not on a measured page.

A note on drift, which is the point of §8: the request described `timeControl` as "thirteen
strings". It is twelve (10 presets + `custom` + `unlimited`). A count maintained in prose
drifts; the descriptor is generated from the same constants as the schema, and the checker now
proves the two agree.

## Consequences

- **Easier:** `apps/web` renders any game's settings form with no game import and no game
  knowledge. A new game's form is data. Presets and quick-start work server-side. The form is
  accessible once, in one place.
- **Easier:** a whole class of bug — control bound to nothing, chip that always errors,
  conditional field that can never appear, preset that does not match its label — now fails at
  registry load with a named code.
- **Harder:** a game that wants a control we do not have must argue for a fourth field kind
  through an ADR. That friction is intentional; it is the plugin boundary doing its job.
- **Harder:** two artefacts (schema + descriptor) must agree. Mitigated by §8 rather than by
  discipline.
- **Committed to:** `settingsForm` is a required manifest field; the shell never branches on a
  game id; the descriptor never carries defaults or validation authority.
- **Cost to reverse:** **cheap** for a game (the descriptor is data — chess's `settingsForm`
  re-shapes in one file with no logic change), **moderate** for the platform (the renderer and
  the checker are the only consumers).

## Revisit triggers

- A game needs a control that is not a select, a number or a toggle — most likely a
  multi-select (map pool, enabled roles). That is a `multiselect` kind with array values, which
  breaks the flat-scalar rule, so it is a v2 descriptor and a fresh ADR.
- A game needs a condition that is not "field equals one of these values" (a range, or two
  conditions AND-ed). Add an explicit operator rather than growing `equals`.
- Frontend Engineer measures create-lobby LCP over the descriptor path above 2 s on a
  mid-range Android over 4G, and the descriptor is implicated.
- We ship in a second language. Labels are plain strings here; i18n means labels become keys,
  which is a v2 descriptor.
- Two games in a row ship a custom `<SettingsForm>`. That would mean the descriptor is not
  sufficient in practice, and §9's floor is not holding.

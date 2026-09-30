/**
 * Descriptor fixtures, as the JSON that actually arrives in a
 * `GameCatalogEntry`.
 *
 * **These are hand-written on purpose and must stay that way.** Importing
 * `chessSettingsForm` from `games/chess` to build them would violate the
 * dependency boundary ([ADR-0002](/PER/issues/PER-5)) that the whole descriptor
 * design exists to protect, and it would also weaken the test: the claim under
 * test is "the renderer draws any descriptor it is handed", so the descriptor
 * must arrive the way the browser gets it — as inert data over the wire — not as
 * a value the test resolved through the game's module graph.
 *
 * The chess fixture is transcribed from `games/chess/src/settings/form.ts` as it
 * serialises. A drift check between the two lives in the game's own suite and in
 * `checkSettingsForm` at registry load, which is the right place for it; this
 * file only needs to be a faithful *shape*.
 */

/**
 * The real chess descriptor: 6 fields, a grouped `timeControl` select
 * (Bullet / Blitz / Rapid / Classical / Other), two number fields conditional on
 * `timeControl === 'custom'`, and two toggles.
 *
 * Groups are derived in the game from `estimatedDurationSeconds`, so they are
 * transcribed here rather than guessed: 1+0 and 2+1 are Bullet (< 180 s),
 * 3+0 … 5+3 are Blitz (< 480 s), 10+0 … 15+10 are Rapid (< 1500 s), 30+0 is
 * Classical.
 */
export const chessSettingsFormFixture = {
  version: 1,
  fields: [
    {
      kind: 'select',
      key: 'timeControl',
      label: 'Time control',
      display: 'chips',
      options: [
        { value: '1+0', label: '1+0', group: 'Bullet' },
        { value: '2+1', label: '2+1', group: 'Bullet' },
        { value: '3+0', label: '3+0', group: 'Blitz' },
        { value: '3+2', label: '3+2', group: 'Blitz' },
        { value: '5+0', label: '5+0', group: 'Blitz' },
        { value: '5+3', label: '5+3', group: 'Blitz' },
        { value: '10+0', label: '10+0', group: 'Rapid' },
        { value: '10+5', label: '10+5', group: 'Rapid' },
        { value: '15+10', label: '15+10', group: 'Rapid' },
        { value: '30+0', label: '30+0', group: 'Classical' },
        { value: 'custom', label: 'Custom', group: 'Other' },
        { value: 'unlimited', label: 'No clock', group: 'Other' },
      ],
      groupOrder: ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Other'],
    },
    {
      kind: 'number',
      key: 'customInitialMinutes',
      label: 'Minutes per side',
      unit: 'min',
      min: 0.5,
      max: 180,
      step: 0.5,
      visibleWhen: { field: 'timeControl', equals: ['custom'] },
    },
    {
      kind: 'number',
      key: 'customIncrementSeconds',
      label: 'Increment',
      unit: 's',
      help: 'Added to your clock after each move you make.',
      min: 0,
      max: 60,
      step: 1,
      visibleWhen: { field: 'timeControl', equals: ['custom'] },
    },
    {
      kind: 'select',
      key: 'color',
      label: 'Colour',
      display: 'chips',
      options: [
        { value: 'white', label: 'White' },
        { value: 'black', label: 'Black' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      kind: 'toggle',
      key: 'takebacks',
      label: 'Allow takebacks',
      help: 'Your opponent can ask to take back their last move.',
    },
    {
      kind: 'toggle',
      key: 'autoQueen',
      label: 'Auto-promote to queen',
      help: 'Skip the promotion picker and always promote to a queen.',
    },
  ],
} as const

export const chessDefaultSettingsFixture = {
  timeControl: '5+0',
  customInitialMinutes: 5,
  customIncrementSeconds: 0,
  color: 'random',
  takebacks: false,
  autoQueen: false,
} as const

/** Chess's 6 presets, 4 of them featured. */
export const chessPresetsFixture = [
  {
    id: 'bullet-1-0',
    label: 'Bullet',
    description: '1 minute each, no increment.',
    settings: { ...chessDefaultSettingsFixture, timeControl: '1+0' },
    isDefault: false,
    featured: false,
  },
  {
    id: 'blitz-3-2',
    label: 'Blitz 3+2',
    description: '3 minutes each, 2 seconds a move.',
    settings: { ...chessDefaultSettingsFixture, timeControl: '3+2' },
    isDefault: false,
    featured: true,
  },
  {
    id: 'blitz-5-0',
    label: 'Blitz 5+0',
    description: '5 minutes each, no increment.',
    settings: { ...chessDefaultSettingsFixture, timeControl: '5+0' },
    isDefault: true,
    featured: true,
  },
  {
    id: 'rapid-10-0',
    label: 'Rapid 10+0',
    description: '10 minutes each, no increment.',
    settings: { ...chessDefaultSettingsFixture, timeControl: '10+0' },
    isDefault: false,
    featured: true,
  },
  {
    id: 'rapid-15-10',
    label: 'Rapid 15+10',
    description: '15 minutes each, 10 seconds a move.',
    settings: { ...chessDefaultSettingsFixture, timeControl: '15+10' },
    isDefault: false,
    featured: false,
  },
  {
    id: 'casual-no-clock',
    label: 'No clock',
    description: 'Take as long as you like.',
    settings: { ...chessDefaultSettingsFixture, timeControl: 'unlimited' },
    isDefault: false,
    featured: true,
  },
] as const

/**
 * Tic-tac-toe: 2 fields, no grouping, no conditions, and a dropdown rather than
 * chips. The second, unlike game that proves the renderer is generic — if it
 * needed one line of renderer change, the descriptor would not be doing its job.
 */
export const ticTacToeSettingsFormFixture = {
  version: 1,
  fields: [
    {
      kind: 'select',
      key: 'firstPlayer',
      label: 'Who goes first',
      options: [
        { value: 'host', label: 'Host' },
        { value: 'guest', label: 'Guest' },
        { value: 'random', label: 'Random' },
      ],
    },
    {
      kind: 'number',
      key: 'moveTimeoutSeconds',
      label: 'Time per move',
      unit: 's',
      min: 5,
      max: 120,
      step: 5,
    },
  ],
} as const

export const ticTacToeDefaultSettingsFixture = {
  firstPlayer: 'random',
  moveTimeoutSeconds: 30,
} as const

/**
 * A descriptor from a future SDK: one field kind this renderer has never heard
 * of, sandwiched between two it knows. ADR-0004 §10 requires the unknown kind to
 * be skipped and the rest of the form to render.
 */
export const forwardCompatibleFormFixture = {
  version: 1,
  fields: [
    {
      kind: 'toggle',
      key: 'friendlyFire',
      label: 'Friendly fire',
    },
    {
      kind: 'multiselect',
      key: 'mapPool',
      label: 'Map pool',
      options: [
        { value: 'warehouse', label: 'Warehouse' },
        { value: 'mansion', label: 'Mansion' },
      ],
    },
    {
      kind: 'number',
      key: 'rounds',
      label: 'Rounds',
      min: 1,
      max: 10,
      step: 1,
    },
  ],
} as const

export const forwardCompatibleDefaultsFixture = {
  friendlyFire: false,
  mapPool: 'warehouse',
  rounds: 5,
} as const

/** A select over numbers — ADR-0004 §3. The type must survive a round trip. */
export const numericSelectFormFixture = {
  version: 1,
  fields: [
    {
      kind: 'select',
      key: 'playerCount',
      label: 'Players',
      display: 'chips',
      options: [
        { value: 4, label: '4' },
        { value: 8, label: '8' },
        { value: 12, label: '12' },
      ],
    },
    {
      kind: 'toggle',
      key: 'damageMultiplierEnabled',
      label: 'Damage multiplier',
    },
    {
      kind: 'number',
      key: 'damageMultiplier',
      label: 'Multiplier',
      min: 1,
      max: 4,
      step: 0.5,
      // A condition on a *toggle* — the other half of amendment 3.
      visibleWhen: { field: 'damageMultiplierEnabled', equals: [true] },
    },
  ],
} as const

export const numericSelectDefaultsFixture = {
  playerCount: 8,
  damageMultiplierEnabled: false,
  damageMultiplier: 1,
} as const

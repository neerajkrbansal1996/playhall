/**
 * Quick-start lobby presets.
 *
 * "Landing page to playable lobby in <= 2 taps": these are the one-tap
 * configurations. Each is a complete, already-valid `ChessSettings`, so the
 * platform can create a lobby from one without opening the form at all.
 */

import { chessSettingsSchema, type ChessSettings } from './schema.js'

export interface ChessSettingsPreset {
  readonly id: string
  readonly label: string
  readonly description: string
  /** Offer this one on the quick-start row; the rest live behind "More". */
  readonly featured: boolean
  readonly settings: ChessSettings
}

function build(
  id: string,
  label: string,
  description: string,
  featured: boolean,
  settings: Partial<ChessSettings>,
): ChessSettingsPreset {
  // Parsing here means a malformed preset fails at import time, not in a lobby.
  return {
    id,
    label,
    description,
    featured,
    settings: chessSettingsSchema.parse(settings),
  }
}

export const CHESS_SETTINGS_PRESETS: readonly ChessSettingsPreset[] = [
  build('bullet-1-0', 'Bullet', '1 minute each, no increment.', false, {
    timeControl: '1+0',
  }),
  build('blitz-3-2', 'Blitz', '3 minutes each, 2 seconds a move.', true, {
    timeControl: '3+2',
  }),
  build('blitz-5-0', 'Blitz', '5 minutes each, no increment.', true, {
    timeControl: '5+0',
  }),
  build('rapid-10-0', 'Rapid', '10 minutes each, no increment.', true, {
    timeControl: '10+0',
  }),
  build('rapid-15-10', 'Rapid', '15 minutes each, 10 seconds a move.', false, {
    timeControl: '15+10',
  }),
  build('casual-no-clock', 'No clock', 'Take as long as you like.', true, {
    timeControl: 'unlimited',
  }),
]

const PRESETS_BY_ID = new Map(CHESS_SETTINGS_PRESETS.map((p) => [p.id, p]))

export function getChessSettingsPreset(
  id: string,
): ChessSettingsPreset | undefined {
  return PRESETS_BY_ID.get(id)
}

export function featuredChessSettingsPresets(): readonly ChessSettingsPreset[] {
  return CHESS_SETTINGS_PRESETS.filter((p) => p.featured)
}

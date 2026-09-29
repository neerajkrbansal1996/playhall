/**
 * Match records.
 *
 * `exportRecord` turns a finished match into something a player can download or
 * paste elsewhere — PGN for chess, a JSON log for a party game. It is optional,
 * runs only after `getResult` is non-null, and the platform treats the output
 * as an opaque blob it stores and serves. Games do not write files.
 */

import type { JsonObject } from './json.js'

export interface MatchRecord {
  /** Short format tag, e.g. `pgn`, `sgf`, `json`. Used for analytics and icons. */
  readonly format: string
  readonly mimeType: string
  /** Filename without a directory, e.g. `match.pgn`. The platform prefixes it. */
  readonly filenameHint: string
  readonly content: string
  /** Extras for the download page, e.g. `{ opening: 'Sicilian' }`. JSON-safe. */
  readonly metadata?: JsonObject
}

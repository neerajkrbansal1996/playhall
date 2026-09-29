// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with `pnpm registry:generate`. CI runs the same script with
// `--check` and fails if this file is stale.
//
// This is the ONE file in the repository allowed to reference a game package
// (ADR-0002 §3), and only through a dynamic `import()`. A static import here
// would pull every game into the shared chunk and break the promise that
// adding a game adds zero bytes to other bundles. `packages/platform-core`
// gets no such exception: it receives this list, it never builds it.
// ---------------------------------------------------------------------------

import type { GameRegistration } from '@playhall/platform-core'

/** No game package declares `playhall.gameEntry` yet. */
export const GAME_REGISTRATIONS: readonly GameRegistration[] = []

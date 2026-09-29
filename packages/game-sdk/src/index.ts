/**
 * @atrium/game-sdk — the ONLY package a game may import.
 *
 * The contracts themselves (GameModule, GameContext, getViewFor, action
 * validation, result shape) are owned by the CTO and land under an ADR in
 * `docs/adr`. This file is the M0 placeholder that keeps the workspace graph,
 * the dependency boundary rule (PER-5) and CI wired ahead of them; it is
 * expected to be replaced wholesale, not extended.
 */

/** Bumped whenever a contract change ships. Stored on every match record. */
export const GAME_SDK_VERSION = '0.1.0'

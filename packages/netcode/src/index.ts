/**
 * @atrium/netcode — real-time transport: fixed-tick loop, binary snapshots,
 * delta compression, interpolation, lag compensation.
 *
 * M6 is board-gated. Do NOT build the kit here ahead of that gate. The package
 * exists now only so the workspace graph, the boundary rule and CI already
 * account for it, and so protocol decisions made in M1 are made with a 30 Hz
 * tick in mind rather than retrofitted.
 */
export const NETCODE_VERSION = '0.0.0'

/** Target server tick rate for real-time rooms. Documented here, not yet used. */
export const TARGET_TICK_HZ = 30

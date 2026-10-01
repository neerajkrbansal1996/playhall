/**
 * Platform room surfaces: the invite block, join-by-code, and seats/presence.
 *
 * These are **presentational and prop-driven on purpose**. The live room state
 * they will be fed comes from the lobby protocol on
 * [PER-15](/PER/issues/PER-15), and the routes that mount them are
 * [PER-20](/PER/issues/PER-20) — neither has landed. Keeping the components
 * free of any transport lets the M2 E2E selector surface exist and be asserted
 * now, and leaves PER-20 wiring rather than rebuilding.
 */

export { JoinByCodeForm, type JoinByCodeFormProps } from './join-by-code-form'
export { RoomInvite, type RoomInviteProps } from './room-invite'
export { SeatList, type SeatListProps, type SeatView } from './seat-list'

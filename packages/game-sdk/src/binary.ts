/**
 * Binary encoding contract for real-time traffic.
 *
 * Types only in M1. `@atrium/netcode` implements the reader/writer in M6.
 *
 * Why this exists now: the budget is < 30 KB/s down per client for a 12-player
 * room at 30 Hz. That is ~1 KB per snapshot. JSON spends most of that on
 * property names and float digits before a single position is encoded, and
 * there is no delta story. Committing to a codec interface in M1 means the
 * real-time path is never retrofitted onto a JSON assumption that has spread
 * through the room runner and the transport adapter.
 *
 * zod still applies: `inputSchema` validates a decoded input before the game
 * sees it, exactly as `actionSchema` does for turn-based actions. Binary is
 * the wire format, not a reason to trust the client.
 */

export interface BinaryWriter {
  u8(value: number): void
  u16(value: number): void
  u32(value: number): void
  i8(value: number): void
  i16(value: number): void
  i32(value: number): void
  f32(value: number): void
  f64(value: number): void
  bool(value: boolean): void
  /** LEB128. Cheap for the small, frequently-zero fields deltas are made of. */
  varuint(value: number): void
  varint(value: number): void
  /** Quantised float: `value` clamped to `[min, max]` across `bits` steps. */
  quantised(value: number, min: number, max: number, bits: number): void
  bytes(value: Uint8Array): void
  string(value: string): void
}

export interface BinaryReader {
  u8(): number
  u16(): number
  u32(): number
  i8(): number
  i16(): number
  i32(): number
  f32(): number
  f64(): number
  bool(): boolean
  varuint(): number
  varint(): number
  quantised(min: number, max: number, bits: number): number
  bytes(length: number): Uint8Array
  string(): string
  readonly bytesRemaining: number
}

export interface BinaryCodec<T> {
  /** Stable identifier, versioned with the game. Used for wire-format pinning. */
  readonly id: string
  encode(value: T, out: BinaryWriter): void
  decode(input: BinaryReader): T
}

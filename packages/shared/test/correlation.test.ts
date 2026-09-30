import { describe, expect, it } from 'vitest'
import {
  CORRELATION_ID_FIELD,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_LENGTH,
  CorrelationIdSchema,
  mintCorrelationId,
  parseCorrelationId,
  resolveCorrelationId,
  webCryptoRandomBytes,
  type RandomBytes,
} from '../src/index'

const fixedBytes: RandomBytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256)

describe('correlation id', () => {
  it('is 26 base32 characters and schema-valid', () => {
    const id = mintCorrelationId(fixedBytes)
    expect(id).toHaveLength(CORRELATION_ID_LENGTH)
    expect(CorrelationIdSchema.safeParse(id).success).toBe(true)
    expect(id).toMatch(/^[a-z2-7]{26}$/)
  })

  it('is deterministic for a given byte source, so tests can assert on it', () => {
    expect(mintCorrelationId(fixedBytes)).toBe(mintCorrelationId(fixedBytes))
  })

  it('uses Web Crypto by default and does not repeat', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintCorrelationId()))
    expect(ids.size).toBe(100)
    expect(webCryptoRandomBytes(16)).toHaveLength(16)
  })

  it('rejects anything malformed instead of trusting the client', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'too-short',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', // uppercase is not the alphabet
      'abcdefghijklmnopqrstuvwxy1', // 1 and 0 are not base32
      'abcdefghijklmnopqrstuvwxyz\n"injected"',
    ]) {
      expect(parseCorrelationId(bad), String(bad)).toBeUndefined()
    }
  })

  it('accepts a well-formed inbound id', () => {
    const id = mintCorrelationId(fixedBytes)
    expect(parseCorrelationId(id)).toBe(id)
  })
})

describe('resolveCorrelationId', () => {
  it('keeps a valid inbound id and reports it was not minted', () => {
    const inbound = mintCorrelationId(fixedBytes)
    expect(resolveCorrelationId(inbound, fixedBytes)).toEqual({
      correlationId: inbound,
      minted: false,
    })
  })

  it('mints when the id is missing or malformed, and says so', () => {
    for (const inbound of [undefined, '', 'nope', { correlationId: 'nested' }]) {
      const resolved = resolveCorrelationId(inbound, fixedBytes)
      expect(resolved.minted).toBe(true)
      expect(CorrelationIdSchema.safeParse(resolved.correlationId).success).toBe(true)
    }
  })

  it('survives the web -> realtime hop as an explicit field, not ambient state', () => {
    // First hop: nothing inbound, so the edge mints.
    const edge = resolveCorrelationId(undefined)
    expect(edge.minted).toBe(true)

    // Serialise it the way a join/handshake message carries it. Crossing a
    // process (or a host) boundary must not lose it.
    const join = JSON.parse(
      JSON.stringify({ type: 'room:join', [CORRELATION_ID_FIELD]: edge.correlationId }),
    ) as Record<string, unknown>

    const realtime = resolveCorrelationId(join[CORRELATION_ID_FIELD])
    expect(realtime).toEqual({ correlationId: edge.correlationId, minted: false })
  })

  it('names the header the same way everywhere', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id')
    expect(CORRELATION_ID_FIELD).toBe('correlationId')
  })
})

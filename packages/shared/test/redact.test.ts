import { describe, expect, it } from 'vitest'
import {
  isSensitiveKey,
  REDACTED,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  scrubString,
  scrubValue,
} from '../src/index'

/**
 * ADR-0001 §8 asks this ticket to carry a test that asserts lobby codes and
 * invite URLs never reach a third-party vendor. Asserted, not inspected — the
 * leak check at the bottom fuzzes codes into every shape an event carries.
 */

function codeFrom(seed: number): string {
  let out = ''
  let n = seed
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += ROOM_CODE_ALPHABET.charAt(n % ROOM_CODE_ALPHABET.length)
    n = Math.floor(n / ROOM_CODE_ALPHABET.length) + 7 * (i + 1)
  }
  return out
}

describe('scrubString', () => {
  it('redacts a code out of an invite URL', () => {
    expect(scrubString('https://playhall.example/j/TCQ4MN')).toBe(
      `https://playhall.example/j/${REDACTED}`,
    )
  })

  it('redacts a code out of a query string', () => {
    expect(scrubString('/join?code=TCQ4MN&ref=whatsapp')).toBe(
      `/join?code=${REDACTED}&ref=whatsapp`,
    )
  })

  it('redacts a cued code in free-form prose', () => {
    expect(scrubString('guest joined room TCQ4MN')).toBe(`guest joined room ${REDACTED}`)
    expect(scrubString('lobby code: TCQ4MN')).toBe(`lobby code: ${REDACTED}`)
  })

  it('leaves ordinary prose alone', () => {
    // Both are legal room codes by shape. Blanket redaction would mangle them,
    // which is why structured fields carry codes and messages do not.
    const message = 'SERVER restart complete; CLIENT reconnected in 412 ms'
    expect(scrubString(message)).toBe(message)
  })

  it('is idempotent', () => {
    const once = scrubString('https://playhall.example/j/TCQ4MN')
    expect(scrubString(once)).toBe(once)
  })
})

describe('isSensitiveKey', () => {
  it('matches the capability and credential keys', () => {
    for (const key of [
      'code',
      'roomCode',
      'lobby_code',
      'inviteUrl',
      'Authorization',
      'set-cookie',
      'guestToken',
      'connectionId',
      'SENTRY_DSN',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
  })

  it('does not match innocent keys that merely contain "code"', () => {
    for (const key of ['errorCode', 'statusCode', 'countryCode', 'gameId', 'roomId']) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })
})

describe('scrubValue', () => {
  it('redacts sensitive keys at any depth', () => {
    const scrubbed = scrubValue({
      roomId: 'room_123',
      seat: { guestId: 'g_1', roomCode: 'TCQ4MN' },
      tags: { environment: 'staging' },
    }) as Record<string, Record<string, unknown>>

    expect(scrubbed['seat']?.['roomCode']).toBe(REDACTED)
    expect(scrubbed['seat']?.['guestId']).toBe('g_1')
    expect(scrubbed['roomId']).toBe('room_123')
    expect(scrubbed['tags']?.['environment']).toBe('staging')
  })

  it('flattens an Error instead of emitting {}', () => {
    const err = new Error('failed joining https://playhall.example/j/TCQ4MN')
    const scrubbed = scrubValue(err) as Record<string, unknown>
    expect(scrubbed['name']).toBe('Error')
    expect(scrubbed['message']).toBe(`failed joining https://playhall.example/j/${REDACTED}`)
    expect(typeof scrubbed['stack']).toBe('string')
  })

  it('survives a cycle and caps depth', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    expect(scrubValue(node)).toEqual({ name: 'a', self: '[circular]' })

    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 12; i += 1) deep = { nested: deep }
    expect(JSON.stringify(scrubValue(deep))).toContain('[depth-limit]')
  })

  it('handles Map, Set, Date, bigint and non-finite numbers', () => {
    const scrubbed = scrubValue({
      map: new Map([
        ['roomCode', 'TCQ4MN'],
        ['roomId', 'room_9'],
      ]),
      set: new Set(['a', 'b']),
      when: new Date('2026-09-30T00:00:00.000Z'),
      big: 10n,
      nan: Number.NaN,
      fn: () => undefined,
      gone: undefined,
    }) as Record<string, unknown>

    expect(scrubbed['map']).toEqual({ roomCode: REDACTED, roomId: 'room_9' })
    expect(scrubbed['set']).toEqual(['a', 'b'])
    expect(scrubbed['when']).toBe('2026-09-30T00:00:00.000Z')
    expect(scrubbed['big']).toBe('10')
    expect(scrubbed['nan']).toBe('NaN')
    expect(scrubbed['fn']).toBeUndefined()
    expect('gone' in scrubbed).toBe(false)
  })

  it('honours extraKeys', () => {
    const scrubbed = scrubValue({ customCapability: 'x' }, { extraKeys: ['customCapability'] })
    expect(scrubbed).toEqual({ customCapability: REDACTED })
  })
})

describe('no capability reaches a vendor event (fuzzed)', () => {
  it('holds for 200 generated codes across every event slot', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const code = codeFrom(seed * 31 + 5)
      const event = {
        message: `join failed for room ${code}`,
        request: {
          url: `https://playhall.example/j/${code}?ref=imessage`,
          query_string: `code=${code}`,
          headers: { Authorization: 'Bearer abc.def', Cookie: `gt=${code}` },
        },
        breadcrumbs: [
          { category: 'navigation', message: `to /j/${code}` },
          { category: 'room', data: { roomCode: code, roomId: 'room_9' } },
        ],
        tags: { roomCode: code },
        extra: { inviteUrl: `https://playhall.example/j/${code}`, nested: { joinCode: code } },
        exception: {
          values: [{ type: 'Error', value: `bad code ${code}`, stacktrace: { frames: [] } }],
        },
      }

      const serialized = JSON.stringify(scrubValue(event, { maxDepth: 16 }))
      expect(serialized, `leaked ${code}`).not.toContain(code)
    }
  })
})

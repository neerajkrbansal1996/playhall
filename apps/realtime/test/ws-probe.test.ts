import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  attachWsProbe,
  DEFAULT_PROBE_LIMITS,
  WS_PROBE_PATH,
  type AttachedProbe,
} from '../src/ws-probe'

/**
 * In-process tests for the M0 AC2a probe (ADR-0009).
 *
 * These attach the probe to a bare `node:http` server on an ephemeral port and
 * drive it with a real `ws` client — real handshake, real frames, real close
 * codes — so the assertions are about the transport and not about a mock. What
 * they buy over the spawned-process test in `ws-probe.integration.test.ts` is
 * the ability to inject a clock and shrink the bounds, which is how the idle
 * timeout gets asserted in milliseconds instead of in the configured 30 seconds.
 *
 * The end-to-end round trip against the artifact the deploy pipeline actually
 * runs lives in the integration file. Both run in the `unit` CI gate, because
 * the probe needs neither Redis nor Postgres — that is what the still-PENDING
 * `integration` gate is waiting on.
 */

interface Harness {
  readonly probe: AttachedProbe
  readonly url: string
  readonly server: Server
}

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()
    if (harness === undefined) continue
    await harness.probe.close()
    await new Promise<void>((resolve) => harness.server.close(() => resolve()))
  }
})

async function harness(options: Parameters<typeof attachWsProbe>[1] = {}): Promise<Harness> {
  const server = createServer((_req, res) => {
    // Mirrors the 404 fall-through in `src/index.ts`, so a request that reaches
    // a non-probe route here fails the same way the real service fails.
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'not_found' } }))
  })
  const probe = attachWsProbe(server, options)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const entry: Harness = { probe, server, url: `ws://127.0.0.1:${port}` }
  harnesses.push(entry)
  return entry
}

/** Resolves once the socket is open, or rejects on a failed handshake. */
function open(url: string, protocols?: string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: Buffer) => {
      try {
        resolve(JSON.parse(data.toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('unparseable server frame'))
      }
    })
    ws.once('close', () => reject(new Error('closed before a message arrived')))
  })
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number, reason: Buffer) =>
      resolve({ code, reason: reason.toString('utf8') }),
    )
  })
}

describe('ws probe — the round trip', () => {
  it('answers one ping with one pong carrying the same nonce', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: 'n-1', clientSentAtMs: 1 }))
    const pong = await nextMessage(ws)

    expect(pong).toMatchObject({ t: 'pong', nonce: 'n-1' })
    ws.close()
  })

  it('stamps serverRecvAtMs no later than serverSentAtMs', async () => {
    // Injected clock rather than a real one: with a real clock both stamps land
    // in the same millisecond and the assertion passes without ever having
    // ordered anything. A clock that advances proves the ordering is real.
    let tick = 1_000
    const { url } = await harness({ now: () => (tick += 5) })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: 'n-2', clientSentAtMs: 0 }))
    const pong = (await nextMessage(ws)) as { serverRecvAtMs: number; serverSentAtMs: number }

    expect(pong.serverRecvAtMs).toBe(1_005)
    expect(pong.serverSentAtMs).toBe(1_010)
    expect(pong.serverRecvAtMs).toBeLessThanOrEqual(pong.serverSentAtMs)
    ws.close()
  })

  it('reflects clientSentAtMs verbatim and never derives anything from it', async () => {
    // ADR-0009 §2. A client can put anything in this field — a negative number,
    // a value far in the future — and the only thing it may affect is the RTT
    // the caller prints for itself. Both server stamps must come from the
    // server's clock regardless, which is what the fixed expectations below
    // pin: they do not move when `clientSentAtMs` does.
    let tick = 0
    const { url } = await harness({ now: () => (tick += 7) })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    const lie = -8_640_000_000_000
    ws.send(JSON.stringify({ t: 'ping', nonce: 'n-3', clientSentAtMs: lie }))
    const pong = (await nextMessage(ws)) as {
      clientSentAtMs: number
      serverRecvAtMs: number
      serverSentAtMs: number
    }

    expect(pong.clientSentAtMs).toBe(lie)
    expect(pong.serverRecvAtMs).toBe(7)
    expect(pong.serverSentAtMs).toBe(14)
    ws.close()
  })

  it('answers repeated pings on the same socket without accumulating state', async () => {
    const { url, probe } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    for (const nonce of ['a', 'b', 'c']) {
      ws.send(JSON.stringify({ t: 'ping', nonce, clientSentAtMs: 0 }))
      expect(await nextMessage(ws)).toMatchObject({ t: 'pong', nonce })
    }

    // Still one socket, and the probe holds nothing per-ping.
    expect(probe.openSocketCount()).toBe(1)
    ws.close()
  })
})

describe('ws probe — no fan-out', () => {
  it('never relays a frame to another connection', async () => {
    // The gate the CTO named as the one they would push back hardest on. If the
    // probe can put a frame on a socket other than the one that sent it, it has
    // become a room.
    const { url, probe } = await harness()
    const a = await open(`${url}${WS_PROBE_PATH}`)
    const b = await open(`${url}${WS_PROBE_PATH}`)
    expect(probe.openSocketCount()).toBe(2)

    const seenByB: unknown[] = []
    b.on('message', (data: Buffer) => seenByB.push(data.toString('utf8')))

    a.send(JSON.stringify({ t: 'ping', nonce: 'only-mine', clientSentAtMs: 0 }))
    expect(await nextMessage(a)).toMatchObject({ nonce: 'only-mine' })

    // Give the loop room to deliver anything that was going to be delivered.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seenByB).toEqual([])

    a.close()
    b.close()
  })
})

describe('ws probe — rejected frames', () => {
  it('answers a non-JSON frame with an error and closes the socket', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send('not json at all')
    const error = await nextMessage(ws)
    const closed = await nextClose(ws)

    expect(error).toEqual({ t: 'error', reason: 'frame is not valid JSON' })
    expect(closed.code).toBe(1003)
  })

  it('answers an unknown message type with an error and closes the socket', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'room:join', roomCode: 'ABC234' }))
    const error = (await nextMessage(ws)) as { t: string; reason: string }
    const closed = await nextClose(ws)

    expect(error.t).toBe('error')
    expect(error.reason).toContain('not a valid ping')
    expect(closed.code).toBe(1003)
  })

  it('rejects a ping carrying an extra field rather than ignoring it', async () => {
    // `.strict()`. An ignored extra key is how a second message type gets in
    // without anyone deciding to add one.
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: 'n', clientSentAtMs: 0, seq: 12 }))
    const error = (await nextMessage(ws)) as { t: string; reason: string }

    expect(error.t).toBe('error')
    expect(error.reason).toContain('seq')
    expect((await nextClose(ws)).code).toBe(1003)
  })

  it('never echoes a received value back in the error reason', async () => {
    // The reason string is built from field paths only. Reflecting the received
    // value would make the probe a reflector for whatever a caller puts in it.
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: '<script>alert(1)</script>', clientSentAtMs: 'x' }))
    const error = (await nextMessage(ws)) as { reason: string }

    expect(error.reason).toContain('clientSentAtMs')
    expect(error.reason).not.toContain('script')
  })

  it('rejects a binary frame instead of guessing at a codec', async () => {
    // The binary path belongs to the real-time codec in M6. This probe must not
    // prejudice it by accepting one shape of bytes today.
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(Buffer.from([0x01, 0x02, 0x03]))
    const error = (await nextMessage(ws)) as { t: string; reason: string }

    expect(error).toEqual({ t: 'error', reason: 'binary frames are not supported by the probe' })
    expect((await nextClose(ws)).code).toBe(1003)
  })

  it('rejects an empty nonce', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: '', clientSentAtMs: 0 }))
    expect((await nextMessage(ws)) as { reason: string }).toMatchObject({ t: 'error' })
  })
})

describe('ws probe — bounds', () => {
  it('closes a socket that sends a frame over the size limit', async () => {
    const { url } = await harness({ limits: { maxFrameBytes: 64 } })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    ws.send(JSON.stringify({ t: 'ping', nonce: 'x'.repeat(128), clientSentAtMs: 0 }))

    // 1009 "message too big" comes from `ws` itself via `maxPayload`, before the
    // frame reaches our handler — an oversized frame is never buffered whole.
    expect((await nextClose(ws)).code).toBe(1009)
  })

  it('refuses an upgrade past the concurrent socket limit', async () => {
    const { url, probe } = await harness({ limits: { maxSockets: 2 } })
    const a = await open(`${url}${WS_PROBE_PATH}`)
    const b = await open(`${url}${WS_PROBE_PATH}`)
    expect(probe.openSocketCount()).toBe(2)

    await expect(open(`${url}${WS_PROBE_PATH}`)).rejects.toThrow(/503/)

    a.close()
    b.close()
  })

  it('frees a slot when a socket closes, so the cap is concurrency and not a quota', async () => {
    const { url, probe } = await harness({ limits: { maxSockets: 1 } })
    const first = await open(`${url}${WS_PROBE_PATH}`)
    await expect(open(`${url}${WS_PROBE_PATH}`)).rejects.toThrow(/503/)

    first.close()
    await nextClose(first)
    // The server-side `close` handler runs on its own turn of the loop.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(probe.openSocketCount()).toBe(0)

    const second = await open(`${url}${WS_PROBE_PATH}`)
    second.send(JSON.stringify({ t: 'ping', nonce: 'reused', clientSentAtMs: 0 }))
    expect(await nextMessage(second)).toMatchObject({ nonce: 'reused' })
    second.close()
  })

  it('closes a socket that has been silent for the idle budget', async () => {
    // This is the mechanism behind the idle number reported on PER-94. Asserted
    // at 120 ms; configured at 30 s.
    const { url } = await harness({ limits: { idleTimeoutMs: 120 } })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    const closed = await nextClose(ws)
    expect(closed.code).toBe(1000)
    expect(closed.reason).toBe('probe idle timeout')
  })

  it('resets the idle budget on every frame', async () => {
    const { url } = await harness({ limits: { idleTimeoutMs: 150 } })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    // Three pings at 60 ms cross the 150 ms budget in total elapsed time; a
    // non-resetting timer would close the socket partway through.
    for (const nonce of ['t1', 't2', 't3']) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      ws.send(JSON.stringify({ t: 'ping', nonce, clientSentAtMs: 0 }))
      expect(await nextMessage(ws)).toMatchObject({ nonce })
    }

    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('leaves a socket open indefinitely when the idle timer is disabled', async () => {
    // `idleTimeoutMs: 0` exists for the measurement script only; asserted so it
    // cannot quietly start meaning "close immediately".
    const { url } = await harness({ limits: { idleTimeoutMs: 0 } })
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('ships bounds that are all finite and small', async () => {
    // A bound that got raised to something unbounded is the failure this
    // catches. The probe is not a load-bearing endpoint.
    expect(DEFAULT_PROBE_LIMITS.maxFrameBytes).toBeLessThanOrEqual(4_096)
    expect(DEFAULT_PROBE_LIMITS.maxSockets).toBeLessThanOrEqual(32)
    expect(DEFAULT_PROBE_LIMITS.idleTimeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_PROBE_LIMITS.idleTimeoutMs).toBeLessThanOrEqual(60_000)
  })
})

describe('ws probe — route scope', () => {
  it('declines an upgrade on any path other than the probe route', async () => {
    const { url } = await harness()

    await expect(open(`${url}/ws/anything-else`)).rejects.toThrow(/404/)
    await expect(open(`${url}/`)).rejects.toThrow(/404/)
  })

  it('ignores a query string on the probe route rather than reading it', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}?room=ABC234&seat=2`)

    ws.send(JSON.stringify({ t: 'ping', nonce: 'q', clientSentAtMs: 0 }))
    expect(await nextMessage(ws)).toMatchObject({ t: 'pong', nonce: 'q' })
    ws.close()
  })

  it('selects no subprotocol, so a client that offers one fails the handshake', async () => {
    // Without `handleProtocols`, `ws` echoes back the *first* subprotocol a
    // client offers — the probe would confirm `playhall.v1` as a live protocol
    // name before that protocol exists. Selecting none is the mechanical form of
    // "no subprotocol negotiation" (ADR-0009 §3), and the RFC-conformant `ws`
    // client then refuses the connection itself. That refusal is the assertion:
    // there is no handshake in which this probe blesses a protocol name.
    const { url } = await harness()

    await expect(open(`${url}${WS_PROBE_PATH}`, ['playhall.v1'])).rejects.toThrow(/no subprotocol/i)
  })

  it('connects normally for a client that offers no subprotocol', async () => {
    const { url } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    expect(ws.protocol).toBe('')
    ws.close()
  })
})

/**
 * Tighter than the suite default on purpose. The regression the stalled-peer test
 * guards is a 30 s stall, so it has to fail fast rather than sit inside the 20 s
 * default and report as an ordinary slow test.
 */
const STALLED_PEER_TIMEOUT_MS = 5_000

describe('ws probe — shutdown', () => {
  it('closes live sockets and stops accepting upgrades', async () => {
    const { url, probe } = await harness()
    const ws = await open(`${url}${WS_PROBE_PATH}`)

    // The listener goes on *before* the shutdown that triggers the event. This
    // read the other way round first and passed locally for the worst reason:
    // shutdown happened to resolve before the client saw its close, so the
    // listener still caught it. On a slower runner the order flipped, the event
    // had already fired by the time the listener attached, and the await hung
    // until the 20 s test timeout. A promise for an event must exist before the
    // action that emits it.
    const closed = nextClose(ws)
    await probe.close()

    expect((await closed).code).toBe(1001)

    // Listener detached: nothing handles the upgrade, so the handshake fails.
    await expect(open(`${url}${WS_PROBE_PATH}`)).rejects.toThrow()
  })

  it(
    'resolves even when a peer never answers the close frame',
    async () => {
      // `ws` tracks clients by default, and `WebSocketServer.close()` then
      // withholds its callback until every client has reached CLOSED — a full
      // graceful close handshake per socket, bounded only by ws's 30 s
      // `closeTimeout`. A peer that simply stops reading therefore holds
      // shutdown open for half a minute, and a service that must come back in
      // ten seconds cannot let a client decide that. The probe turns the
      // tracking off and relies on its own socket set instead.
      //
      // The peer here is a raw TCP socket that completes the upgrade and then
      // never speaks again — no `ws` client will reproduce this, because it
      // answers a close frame automatically, and an assertion against a
      // cooperative peer passes with the tracking either way. That is exactly
      // how the default slipped past a green local run.
      const { url, probe } = await harness()
      const port = Number(new URL(url).port)
      const peer = connect({ host: '127.0.0.1', port })

      await new Promise<void>((resolve, reject) => {
        peer.once('error', reject)
        peer.once('data', (chunk: Buffer) => {
          // 101 means the probe upgraded us and its side of the socket is OPEN.
          if (chunk.includes('101 Switching Protocols')) {
            resolve()
            return
          }
          reject(new Error(`peer was not upgraded: ${chunk.toString('utf8').split('\r\n')[0]}`))
        })
        peer.write(
          [
            `GET ${WS_PROBE_PATH} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            // Any 16-byte base64 nonce; the probe does no auth and does not care.
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version: 13',
            '\r\n',
          ].join('\r\n'),
        )
      })
      // From here the peer reads nothing and writes nothing. The close frame the
      // probe is about to send will never be acknowledged.
      peer.pause()

      const startedAt = Date.now()
      await probe.close()
      const elapsed = Date.now() - startedAt

      // With client tracking on this waits out `closeTimeout` (30 s) instead.
      expect(elapsed).toBeLessThan(1_000)

      peer.destroy()
    },
    STALLED_PEER_TIMEOUT_MS,
  )

  it('is idempotent, so a second shutdown is not an error', async () => {
    const { url, probe } = await harness()
    await open(`${url}${WS_PROBE_PATH}`)

    await probe.close()
    await expect(probe.close()).resolves.toBeUndefined()
    expect(probe.openSocketCount()).toBe(0)
  })
})

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { z } from 'zod'

/**
 * M0 AC2a — WebSocket transport probe (ADR-0009).
 *
 * This file exists to answer two questions that no amount of reading can answer:
 * does a WebSocket round trip actually complete against our built artifact, and
 * how long does a silent socket survive before something closes it. The second
 * number sets the heartbeat interval in M1.6.
 *
 * It is diagnostics, in the same category as `/health` — NOT a preview of the
 * wire protocol. ADR-0009 §3 is explicit about what it must never grow into:
 *
 *   * no `room:*`, `game:action`, `game:view`, `game:events`, `timer:sync`
 *   * no framing, codec, sequence numbers, deltas, snapshots, or binary path
 *   * no auth, no persistence, no state that outlives the socket
 *   * no fan-out: one socket receives exactly one reply, to itself
 *
 * **Scheduled demolition.** ADR-0009 commits us to deleting this file and the
 * `REALTIME_WS_PROBE` flag when the transport adapter in M1.6 lands, or folding
 * it into that adapter's conformance test. Adding a second message type here is
 * the ADR's revisit trigger: stop, and take the design to M1.6 instead.
 */

/** The single route. Anything else is not this probe's business. */
export const WS_PROBE_PATH = '/ws/probe'

/**
 * Bounds, because an unbounded diagnostic endpoint is an abuse surface. Each is
 * small on purpose: this exists to prove a round trip, not to carry load.
 */
export interface ProbeLimits {
  /** Frames larger than this are closed by `ws` before we see them (1009). */
  readonly maxFrameBytes: number
  /** Concurrent probe sockets. Further upgrades get 503 and are destroyed. */
  readonly maxSockets: number
  /** Silence budget per socket. `0` disables the timer — measurement only. */
  readonly idleTimeoutMs: number
}

export const DEFAULT_PROBE_LIMITS: ProbeLimits = {
  maxFrameBytes: 1_024,
  maxSockets: 8,
  idleTimeoutMs: 30_000,
}

/**
 * The only inbound shape. `.strict()` so an extra key is a rejection rather
 * than something we silently ignore and someone later depends on.
 *
 * `clientSentAtMs` is **reflected, never consumed** (ADR-0009 §2). Nothing in
 * this file reads, compares, or derives anything from it. Echoing it is what
 * lets the caller compute RTT against its own clock; consuming it would let a
 * modified client move a server-side number, which is the whole thing we do not
 * do. It is typed `number` and nothing narrower for the same reason — the
 * server has no opinion about its value because the server never uses it.
 */
const PingFrame = z
  .object({
    t: z.literal('ping'),
    nonce: z.string().min(1).max(128),
    clientSentAtMs: z.number(),
  })
  .strict()

/** Outbound shape, validated too — house rule is both directions, not just in. */
const PongFrame = z
  .object({
    t: z.literal('pong'),
    nonce: z.string(),
    clientSentAtMs: z.number(),
    serverRecvAtMs: z.number(),
    serverSentAtMs: z.number(),
  })
  .strict()

const ErrorFrame = z.object({ t: z.literal('error'), reason: z.string() }).strict()

export type PingFrame = z.infer<typeof PingFrame>
export type PongFrame = z.infer<typeof PongFrame>
export type ErrorFrame = z.infer<typeof ErrorFrame>

export interface ProbeOptions {
  readonly limits?: Partial<ProbeLimits>
  /** Injected so a test can assert the clock ordering without racing a real one. */
  readonly now?: () => number
}

export interface AttachedProbe {
  readonly limits: ProbeLimits
  /** Live socket count. Exposed for assertions, not for any request path. */
  openSocketCount(): number
  /** Closes every live probe socket and detaches the upgrade listener. */
  close(): Promise<void>
}

/**
 * Attaches `GET /ws/probe` to an existing server via the `upgrade` event.
 *
 * Call this **only** when the probe is enabled. When it is not called the server
 * keeps exactly today's behaviour: no upgrade listener, so Node destroys an
 * upgrade attempt, and a plain `GET /ws/probe` falls through to the 404 in the
 * normal request handler. That is why there is no `enabled` branch in here —
 * "off" means this code is never attached, not that it is attached and inert.
 */
export function attachWsProbe(server: Server, options: ProbeOptions = {}): AttachedProbe {
  const limits: ProbeLimits = { ...DEFAULT_PROBE_LIMITS, ...options.limits }
  const now = options.now ?? Date.now

  // `noServer` keeps `ws` out of the request path entirely: it never sees a
  // normal HTTP request, only the sockets we hand it.
  //
  // `handleProtocols` returning false is not decoration. With no hook, `ws`
  // selects the *first* subprotocol a client offers and echoes it back, so a
  // client asking for `playhall.v1` would be told it got it — this probe
  // answering to a name from a protocol that does not exist yet. Returning
  // false selects none and sends no `Sec-WebSocket-Protocol` header, which is
  // what "no subprotocol negotiation" (ADR-0009 §3) has to mean mechanically.
  //
  // `clientTracking: false` because we keep our own `sockets` set, and ws's
  // duplicate of it changes what `close()` means: with tracking on, `close()`
  // does not resolve until every client has reached CLOSED, which means waiting
  // out a *graceful* close handshake per socket — up to ws's 30 s
  // `closeTimeout` if a peer never answers. Shutdown must not be hostage to a
  // client's cooperation. With tracking off, `close()` resolves on the next
  // tick and each socket still gets its clean 1001 from the loop below.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxFrameBytes,
    handleProtocols: () => false,
    clientTracking: false,
  })
  const sockets = new Set<WebSocket>()

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0]

    // Not our route. Today an upgrade to any path is destroyed by Node because
    // nothing listens; answering 404 is the same outcome, stated rather than
    // implied, and it does not leave a caller waiting on a timeout.
    if (path !== WS_PROBE_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }

    if (sockets.size >= limits.maxSockets) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }

    // No `handleProtocols`, so no subprotocol is ever negotiated. A probe that
    // negotiates a subprotocol has started to define the wire protocol.
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      handleSocket(ws)
    })
  }

  const handleSocket = (ws: WebSocket): void => {
    let idleTimer: NodeJS.Timeout | undefined

    const armIdleTimer = (): void => {
      if (limits.idleTimeoutMs <= 0) return
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => ws.close(1000, 'probe idle timeout'), limits.idleTimeoutMs)
      // A pending probe timer must not hold the process open at shutdown.
      idleTimer.unref()
    }

    armIdleTimer()

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const serverRecvAtMs = now()
      armIdleTimer()

      // Binary is not a supported shape here. The binary path belongs to the
      // real-time codec in M6 and must stay unprejudiced by this file.
      if (isBinary) {
        fail(ws, 'binary frames are not supported by the probe')
        return
      }

      const parsed = parseFrame(data)
      if (!parsed.ok) {
        fail(ws, parsed.reason)
        return
      }

      const pong: PongFrame = {
        t: 'pong',
        nonce: parsed.frame.nonce,
        // Reflected verbatim. Not read, not compared, not trusted.
        clientSentAtMs: parsed.frame.clientSentAtMs,
        serverRecvAtMs,
        serverSentAtMs: now(),
      }

      // One socket, one reply, to itself. There is deliberately no reference to
      // `sockets` in this handler: fan-out is impossible here by construction,
      // not by discipline.
      send(ws, PongFrame.parse(pong))
    })

    ws.on('close', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      sockets.delete(ws)
    })

    // A transport error is not a server error; drop the socket and move on.
    ws.on('error', () => ws.close(1011, 'probe socket error'))
  }

  const fail = (ws: WebSocket, reason: string): void => {
    // `send` then `close` is ordered by `ws`: the error frame is flushed before
    // the close frame, so the caller always learns why.
    send(ws, ErrorFrame.parse({ t: 'error', reason }))
    ws.close(1003, 'probe rejected frame')
  }

  server.on('upgrade', onUpgrade)

  return {
    limits,
    openSocketCount: () => sockets.size,
    close: async () => {
      server.off('upgrade', onUpgrade)
      for (const ws of sockets) ws.close(1001, 'probe shutting down')
      sockets.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

type ParseResult = { ok: true; frame: PingFrame } | { ok: false; reason: string }

/**
 * Unparseable and unknown collapse to the same outcome on purpose: the caller
 * gets a reason and the socket closes either way, and distinguishing them would
 * mean shipping a second inbound type.
 */
function parseFrame(data: RawData): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(rawDataToString(data)) as unknown
  } catch {
    return { ok: false, reason: 'frame is not valid JSON' }
  }

  const parsed = PingFrame.safeParse(json)
  if (!parsed.success) {
    // Field names only — never the received values, which are attacker-supplied
    // and would make the error frame a reflector. An `unrecognized_keys` issue
    // carries no path (the object as a whole is wrong), so its rejected key
    // names are named explicitly; otherwise every strictness failure reads
    // "(root)" and tells the caller nothing about what to remove.
    const detail = parsed.error.issues
      .map((issue) =>
        issue.code === 'unrecognized_keys'
          ? `unexpected ${issue.keys.join(', ')}`
          : issue.path.join('.') || '(root)',
      )
      .join(', ')
    return { ok: false, reason: `frame is not a valid ping: ${detail}` }
  }
  return { ok: true, frame: parsed.data }
}

/**
 * Normalises the three arms of `ws`'s `RawData`.
 *
 * Under the options above a complete text message always arrives as one Buffer —
 * `ws` reassembles fragments before `message` fires, and `maxPayload` caps the
 * whole message rather than a frame. The other two arms are in the `RawData` type
 * for receivers configured otherwise; they are normalised rather than assumed
 * away, and marked as the unreachable branches they are so the coverage number
 * stays a statement about tested code rather than about a type's shape.
 */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  /* v8 ignore next 2 -- unreachable under the options above; see the note. */
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function send(ws: WebSocket, frame: PongFrame | ErrorFrame): void {
  if (ws.readyState !== ws.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Declines an upgrade with a real HTTP status rather than a bare socket drop, so
 * a caller learns whether it was refused (404, wrong route) or shed (503, at the
 * socket cap) instead of seeing an indistinguishable reset.
 *
 * `end` rather than `write` + `destroy`: destroying immediately can discard the
 * buffered response, which turns a 503 into an ECONNRESET under exactly the load
 * that produces 503s. `end` flushes, then FINs; `destroy` on the flush guarantees
 * the socket is released even if the peer never reads.
 */
function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`, () => socket.destroy())
}

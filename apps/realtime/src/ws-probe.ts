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
 *
 * Delete this in the **same commit** that attaches a second `upgrade` listener.
 * Node fires `upgrade` on every listener, and `onUpgrade` below answers 404 for
 * every path that is not ours — so while both are attached this probe writes
 * `HTTP/1.1 404` onto the socket the new adapter is about to use. The probe is
 * enabled in dev and staging by design, so the symptom looks like an adapter
 * bug, in the one environment where the adapter is first tried.
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

    // `handleProtocols` above refuses every offer, so no subprotocol is ever
    // negotiated. A probe that negotiates one has started to define the wire
    // protocol, which is M1.6's to define.
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

    // Everything that can produce a reply lives in `respondTo`, at module scope.
    // The socket set is not in its lexical scope at all, so fan-out from the
    // reply path is a compile error rather than something a reviewer has to
    // notice. All that stays in this closure is the idle timer, which needs it.
    ws.on('message', (data: RawData, isBinary: boolean) => {
      armIdleTimer()
      respondTo(ws, data, isBinary, now)
    })

    ws.on('close', () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      sockets.delete(ws)
    })

    // A transport error is not a server error; drop the socket and move on.
    ws.on('error', () => ws.close(1011, 'probe socket error'))
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

/**
 * The whole reply path: one socket in, exactly one frame back to that same
 * socket. Deliberately at module scope — `attachWsProbe`'s socket set is not
 * reachable from here, so "no fan-out" (ADR-0009 §3) is enforced by what this
 * function can see rather than by what nobody wrote.
 */
function respondTo(ws: WebSocket, data: RawData, isBinary: boolean, now: () => number): void {
  const serverRecvAtMs = now()

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

  send(ws, PongFrame.parse(pong))
}

function fail(ws: WebSocket, reason: string): void {
  // `send` then `close` is ordered by `ws`: the error frame is flushed before
  // the close frame, so the caller always learns why.
  send(ws, ErrorFrame.parse({ t: 'error', reason }))
  ws.close(1003, 'probe rejected frame')
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
    return { ok: false, reason: `frame is not a valid ping: ${shapeRejection(parsed.error)}` }
  }
  return { ok: true, frame: parsed.data }
}

/**
 * Renders a rejection as **field names only, never field values**, with every
 * name bounded in amount and in alphabet.
 *
 * Values are attacker-supplied and would make the error frame a reflector.
 * `maxFrameBytes` alone bounds a name loosely enough to echo ~1 KiB back, so the
 * bounds live here instead: `MAX_REPORTED_ISSUES` and `MAX_REPORTED_KEYS` /
 * `MAX_REPORTED_KEY_CHARS` bound how *much* comes back, and `quoteKey` bounds
 * *what*.
 *
 * **Exported for the schema it is not used with.** Every bound below is
 * unconditional in this function, but for `PingFrame` two of them are
 * unreachable — three fields plus `.strict()` cannot exceed `MAX_REPORTED_ISSUES`,
 * and no `PingFrame` path segment is caller-supplied — so driving this through
 * the socket cannot pin them and a mutation that deletes them passes. The test
 * drives it directly against a `z.record()` fixture instead. That is also the
 * honest shape of the thing: this helper is what M1.6's transport adapter
 * inherits, and it is being asked to hold for schemas that do not exist yet.
 *
 * Every arm goes through `quoteKey`, unconditionally, and that is the point. For
 * `PingFrame` only the `unrecognized_keys` arm can carry caller bytes: it has no
 * path (the object as a whole is wrong), so naming the rejected keys is the only
 * way the caller learns what to remove. A *path segment* is caller-supplied only
 * under `z.record()` / `z.object().catchall()` — the one pair of zod constructs
 * that puts a caller's own key into `issue.path`. An array index arrives as a
 * number, and an object key is schema-derived. No such schema exists in this
 * tree today, so quoting the segments changes no reason this file can currently
 * produce, which is precisely why it is worth doing now instead of writing the
 * caveat down: shaping that holds only *given this schema* does not survive the
 * move into M1.6's schema set, because the caveat does not travel with the code
 * and there fan-out exists. Quote per segment rather than the joined string, so
 * `.` stays structural.
 */
export function shapeRejection(error: z.ZodError): string {
  return summarise(
    error.issues.map((issue) =>
      issue.code === 'unrecognized_keys'
        ? `unexpected ${summarise(issue.keys.map(quoteKey), MAX_REPORTED_KEYS)}`
        : issue.path.map((segment) => quoteKey(String(segment))).join('.') || '(root)',
    ),
    MAX_REPORTED_ISSUES,
  )
}

/**
 * How many rejected *issues* the error frame may list.
 *
 * `MAX_REPORTED_KEYS` bounds the key list inside **one** `unrecognized_keys`
 * issue, which leaves the number of issues bounded by a property of the schema
 * rather than of this function: `PingFrame` has three fields, so it cannot
 * exceed four issues (each field, plus the one `.strict()` arm) and this cap is
 * a measured no-op today. A schema with a `z.record()` has no such ceiling — one
 * issue per caller-supplied entry — so a sender picks the length of the reason.
 * A bounded alphabet over an unbounded list is still an unbounded echo.
 */
const MAX_REPORTED_ISSUES = 4

/** How much of a caller-supplied key set the error frame may quote back. */
const MAX_REPORTED_KEYS = 3
const MAX_REPORTED_KEY_CHARS = 32

/**
 * Everything a quoted key may *not* contribute. An allowlist rather than a
 * blocklist of known-bad characters: the set of characters that are inert in
 * every sink a reason string can reach is not knowable from here, but the set a
 * legitimate protocol field name needs is — identifier characters, and the two
 * separators (`.`, `:`) a nested path can carry.
 */
const UNQUOTABLE_KEY_CHAR = /[^A-Za-z0-9_.:-]/g

/**
 * `{"": 1}` is legal JSON, and quoting that key contributes nothing — the reason
 * would read `unexpected ` and trail off. Name it instead.
 */
const EMPTY_KEY = '(empty)'

/**
 * The one `(+N more)` idiom, shared by both caps so a reader does not have to
 * check whether the issue list and the key list elide the same way. Callers pass
 * already-quoted parts — this function bounds amount only, never alphabet.
 */
function summarise(parts: readonly string[], max: number): string {
  const shown = parts.slice(0, max)
  const hidden = parts.length - shown.length
  return hidden > 0 ? `${shown.join(', ')} (+${hidden} more)` : shown.join(', ')
}

/**
 * Renders one caller-supplied key name as something safe to put on the wire.
 *
 * The count/length caps above bound how *much* comes back; they say nothing
 * about *what*. A 32-character slice of a caller's key still carries a newline,
 * a `\r`, or an ANSI escape introducer verbatim, and that is a property of the
 * sink, not of this file: today the reason reaches only the socket that sent the
 * frame, so there is nothing to inject into, but the next sink to be given this
 * string — a structured log line, a terminal, a CI annotation, an HTML error
 * panel — gets to be wrong about it. Shaping the string at the source is the
 * only place that choice does not have to be re-made per sink.
 *
 * `MAX_REPORTED_KEY_CHARS` bounds bytes and not only characters, and the
 * invariant that buys that is **the allowlist is single-byte**, not the order of
 * the two steps below. `UNQUOTABLE_KEY_CHAR` admits ASCII alone, so the clip only
 * ever sees one byte per character, and a lone surrogate half is itself outside
 * the allowlist and lands as `?` whichever step runs first — a 32-character key
 * costs 32 bytes rather than the up-to-128 a multi-byte one would. Widening the
 * alphabet to admit a non-ASCII field name (`\p{L}`, say) gives that up with the
 * order untouched, so widen the test in `ws-probe.test.ts` with it. Classing
 * before clipping buys only that the `…` marker is not itself quoted into `?`,
 * which is cosmetic; the marker is three bytes, so a clipped result measures
 * `MAX_REPORTED_KEY_CHARS` bytes plus that fixed three.
 */
function quoteKey(key: string): string {
  const safe = key.replace(UNQUOTABLE_KEY_CHAR, '?')
  if (safe.length === 0) return EMPTY_KEY
  return safe.length > MAX_REPORTED_KEY_CHARS ? `${safe.slice(0, MAX_REPORTED_KEY_CHARS)}…` : safe
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

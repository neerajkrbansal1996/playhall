/**
 * Hidden Hand — the testkit's reference game.
 *
 * Tic-tac-toe is the SDK's reference game, and it is perfect-information: a
 * leak is not expressible in it, so it cannot prove that the leak fuzzer
 * works. Hidden Hand exists to close that gap, and to give `platform-core`
 * something to drive the room runner with that is not a real shipping game.
 *
 * The rules are the smallest thing with a secret in it: each seat is dealt a
 * private hand from a deck shuffled with `ctx.rng`, seats play one card each
 * per trick in seating order, the highest card takes the trick, and the seat
 * with the most tricks wins. Hands are hidden; played cards are public.
 *
 * Two deliberate design details, both of which are advice for real games:
 *
 *   - card ids are **distinctive strings** (`c07`), not bare small integers.
 *     The leak fuzzer matches secrets by value, so a secret that is the
 *     number `2` collides with every score, index and count in the view and
 *     produces false positives.
 *   - the per-seat opening hand is delivered as an event with a
 *     `seats([...])` audience rather than being folded into the public
 *     opening view, which is what the audience mechanism is for.
 */

import {
  DEFAULT_DISCONNECT_POLICY,
  PUBLIC,
  type GameContext,
  type GameEvent,
  type GameManifest,
  type MatchResult,
  type SeatId,
  type SeatRoster,
  type Standing,
  type TurnBasedGameServer,
  type Viewer,
  asTimerId,
  invalid,
  setTimer,
  toSeats,
} from '@playhall/game-sdk'
import { z } from 'zod'

export const settingsSchema = z.object({
  /** Cards dealt to each seat; also the number of tricks played. */
  handSize: z.number().int().min(2).max(8),
  /** Seconds a seat has to play a card. */
  moveTimeoutSeconds: z.number().int().min(5).max(300),
})

export type HiddenHandSettings = z.infer<typeof settingsSchema>

/**
 * A card. A `type` alias rather than an `interface` on purpose: TypeScript
 * gives object type aliases an implicit index signature, so this is
 * assignable to `JsonValue` and can ride inside an event payload. An
 * `interface` with the same members is not. Every game author hits this.
 */
export type Card = {
  readonly id: string
  readonly rank: number
}

export interface HiddenHandState {
  /** Seating order. Everything else keys off this. */
  readonly order: readonly SeatId[]
  /** Private. Only the owning seat may ever see these ids. */
  readonly hands: readonly { readonly seatId: SeatId; readonly cards: readonly Card[] }[]
  /** Public: the cards played so far in the current trick, in play order. */
  readonly trick: readonly { readonly seatId: SeatId; readonly card: Card }[]
  readonly tricksWon: readonly { readonly seatId: SeatId; readonly count: number }[]
  /** Index into `order` of the seat that leads the current trick. */
  readonly leaderIndex: number
  readonly tricksPlayed: number
  readonly totalTricks: number
  readonly moveTimeoutMs: number
}

export const actionSchema = z.object({
  type: z.literal('play'),
  cardId: z.string().min(1).max(8),
})

export type HiddenHandAction = z.infer<typeof actionSchema>

export interface HiddenHandView {
  /** Your own cards. Null for a spectator; full deck order for a replay. */
  readonly hand: readonly Card[] | null
  readonly trick: readonly { readonly seatId: SeatId; readonly card: Card }[]
  readonly handSizes: readonly { readonly seatId: SeatId; readonly count: number }[]
  readonly tricksWon: readonly { readonly seatId: SeatId; readonly count: number }[]
  readonly toMove: SeatId | null
  readonly tricksPlayed: number
  readonly totalTricks: number
}

export type HiddenHandEvent =
  | GameEvent<'dealt', { readonly seatId: SeatId; readonly cards: readonly Card[] }>
  | GameEvent<'card_played', { readonly seatId: SeatId; readonly card: Card }>
  | GameEvent<'trick_won', { readonly seatId: SeatId; readonly trick: number }>
  | GameEvent<
      'match_ended',
      { readonly tricksWon: readonly { readonly seatId: SeatId; readonly count: number }[] }
    >

const MOVE_TIMER = asTimerId('play')

/** Whose turn it is, derived rather than stored so it cannot drift. */
export function toMoveOf(state: HiddenHandState): SeatId | null {
  if (state.tricksPlayed >= state.totalTricks) return null
  const index = (state.leaderIndex + state.trick.length) % state.order.length
  return state.order[index] ?? null
}

function handOf(state: HiddenHandState, seatId: SeatId): readonly Card[] | null {
  return state.hands.find((entry) => entry.seatId === seatId)?.cards ?? null
}

export const manifest: GameManifest<HiddenHandSettings> = {
  id: 'hidden-hand',
  slug: 'hidden-hand',
  name: 'Hidden Hand',
  shortDescription: 'A trick-taking reference game with real hidden information.',
  thumbnail: 'assets/thumbnail.png',
  category: 'card',
  minPlayers: 2,
  maxPlayers: 4,
  teams: 'none',
  turnModel: 'sequential',
  hasHiddenInformation: true,
  usesRandomness: true,
  supportsSpectators: true,
  supportsBots: false,
  settingsSchema,
  defaultSettings: { handSize: 4, moveTimeoutSeconds: 30 },
  presets: [
    {
      id: 'standard',
      label: 'Standard',
      settings: { handSize: 4, moveTimeoutSeconds: 30 },
      isDefault: true,
    },
    { id: 'short', label: 'Short', settings: { handSize: 2, moveTimeoutSeconds: 15 } },
  ],
  timers: [
    {
      id: 'play',
      kind: 'turn',
      description: 'Per-move deadline for the seat to play a card.',
      pausesOnDisconnect: true,
    },
  ],
  status: 'beta',
  version: '1.0.0',
  sdkContractVersion: 1,
}

export const server: TurnBasedGameServer<
  HiddenHandState,
  HiddenHandAction,
  HiddenHandView,
  HiddenHandSettings,
  HiddenHandEvent
> = {
  actionSchema,

  createInitialState(ctx: GameContext, settings: HiddenHandSettings, seats: SeatRoster) {
    const order = seats.map((seat) => seat.seatId)
    const deckSize = order.length * settings.handSize
    const deck: Card[] = Array.from({ length: deckSize }, (_unused, index) => ({
      id: `c${String(index + 1).padStart(2, '0')}`,
      rank: index + 1,
    }))
    const shuffled = ctx.rng.shuffle(deck)

    const hands = order.map((seatId, seatIndex) => ({
      seatId,
      cards: shuffled.slice(seatIndex * settings.handSize, (seatIndex + 1) * settings.handSize),
    }))

    const state: HiddenHandState = {
      order,
      hands,
      trick: [],
      tricksWon: order.map((seatId) => ({ seatId, count: 0 })),
      leaderIndex: 0,
      tricksPlayed: 0,
      totalTricks: settings.handSize,
      moveTimeoutMs: settings.moveTimeoutSeconds * 1000,
    }

    return {
      state,
      // One private event per seat. This is the whole reason `audience` is
      // required on every event.
      events: hands.map((hand): HiddenHandEvent => ({
        type: 'dealt',
        payload: { seatId: hand.seatId, cards: hand.cards },
        audience: toSeats(hand.seatId),
      })),
      timers: [setTimer(MOVE_TIMER, state.moveTimeoutMs, order[0] ?? null)],
    }
  },

  validateAction(_ctx, state, seatId, action) {
    const hand = handOf(state, seatId)
    if (hand === null) return invalid('not_seated')
    if (state.tricksPlayed >= state.totalTricks) return invalid('match_over')
    if (toMoveOf(state) !== seatId) return invalid('not_your_turn')
    if (!hand.some((card) => card.id === action.cardId)) {
      return invalid('illegal_action', 'card is not in the seat’s hand', { cardId: action.cardId })
    }
    // `{ ok: true }` rather than the SDK's `VALID`: that constant is typed
    // `ValidationResult<string>`, which does not narrow to a game's error-code
    // union. Tracked with the CTO; see the note in the conformance README.
    return { ok: true }
  },

  applyAction(_ctx, state, seatId, action) {
    const hand = handOf(state, seatId)
    const card = hand?.find((entry) => entry.id === action.cardId)
    if (card === undefined) throw new Error('applyAction called with a card the seat does not hold')

    const hands = state.hands.map((entry) =>
      entry.seatId === seatId
        ? { seatId: entry.seatId, cards: entry.cards.filter((held) => held.id !== card.id) }
        : entry,
    )
    const trick = [...state.trick, { seatId, card }]
    const events: HiddenHandEvent[] = [
      { type: 'card_played', payload: { seatId, card }, audience: PUBLIC },
    ]

    if (trick.length < state.order.length) {
      const next: HiddenHandState = { ...state, hands, trick }
      return {
        state: next,
        events,
        timers: [setTimer(MOVE_TIMER, state.moveTimeoutMs, toMoveOf(next))],
      }
    }

    // Trick complete: highest rank takes it and leads the next one.
    let best = trick[0]
    if (best === undefined) throw new Error('unreachable: a complete trick has at least one card')
    for (const played of trick) {
      if (played.card.rank > best.card.rank) best = played
    }
    const winner = best.seatId
    const tricksPlayed = state.tricksPlayed + 1
    const next: HiddenHandState = {
      ...state,
      hands,
      trick: [],
      tricksWon: state.tricksWon.map((entry) =>
        entry.seatId === winner ? { seatId: entry.seatId, count: entry.count + 1 } : entry,
      ),
      leaderIndex: state.order.indexOf(winner),
      tricksPlayed,
    }
    events.push({
      type: 'trick_won',
      payload: { seatId: winner, trick: tricksPlayed },
      audience: PUBLIC,
    })

    const over = tricksPlayed >= state.totalTricks
    if (over) {
      events.push({ type: 'match_ended', payload: { tricksWon: next.tricksWon }, audience: PUBLIC })
    }

    return {
      state: next,
      events,
      timers: over
        ? [{ op: 'clear', timerId: MOVE_TIMER }]
        : [setTimer(MOVE_TIMER, state.moveTimeoutMs, toMoveOf(next))],
    }
  },

  getViewFor(state, viewer: Viewer): HiddenHandView {
    return {
      // The one redaction in the game. Everything else is public by design.
      hand:
        viewer.kind === 'seat'
          ? handOf(state, viewer.seatId)
          : viewer.kind === 'replay'
            ? state.hands.flatMap((entry) => entry.cards)
            : null,
      trick: state.trick,
      handSizes: state.hands.map((entry) => ({ seatId: entry.seatId, count: entry.cards.length })),
      tricksWon: state.tricksWon,
      toMove: toMoveOf(state),
      tricksPlayed: state.tricksPlayed,
      totalTricks: state.totalTricks,
    }
  },

  getLegalActions(state, seatId) {
    if (state.tricksPlayed >= state.totalTricks) return []
    if (toMoveOf(state) !== seatId) return []
    return (handOf(state, seatId) ?? []).map((card) => ({ type: 'play' as const, cardId: card.id }))
  },

  onTimer(ctx, state, _timerId, seatId) {
    // Out of time: the platform plays the seat's lowest card, so a dropped
    // phone still ends the match instead of parking the room forever.
    const hand = seatId === null ? null : handOf(state, seatId)
    if (seatId === null || hand === null || hand.length === 0) {
      return { state, events: [], timers: [] }
    }
    const lowest = [...hand].sort((a, b) => a.rank - b.rank)[0]
    if (lowest === undefined) return { state, events: [], timers: [] }
    return server.applyAction(ctx, state, seatId, { type: 'play', cardId: lowest.id })
  },

  disconnectPolicy: { ...DEFAULT_DISCONNECT_POLICY, onGraceExpired: 'nothing' },

  getResult(state): MatchResult | null {
    if (state.tricksPlayed < state.totalTricks) return null

    const sorted = [...state.tricksWon].sort((a, b) => b.count - a.count)
    const standings: Standing[] = []
    let rank = 1
    let index = 0
    while (index < sorted.length) {
      const entry = sorted[index]
      if (entry === undefined) break
      const tied = sorted.filter((other) => other.count === entry.count)
      for (const member of tied) {
        standings.push({
          seatId: member.seatId,
          rank,
          outcome: rank === 1 ? (tied.length === sorted.length ? 'draw' : 'win') : 'loss',
          score: member.count,
        })
      }
      rank += tied.length
      index += tied.length
    }
    return { reason: 'completed', standings }
  },
}

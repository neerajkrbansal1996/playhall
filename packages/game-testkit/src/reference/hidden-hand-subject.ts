/**
 * Hidden Hand as a conformance subject.
 *
 * This is the worked example a game author should copy: the only thing the
 * game has to explain to the suite is *what is secret and who may see it*.
 * Everything else the suite gets from the contract.
 */

import type {
  HiddenHandAction,
  HiddenHandEvent,
  HiddenHandSettings,
  HiddenHandState,
  HiddenHandView,
} from './hidden-hand.js'
import { manifest, server } from './hidden-hand.js'
import { type TurnBasedConformanceSubject, perSeatSecret } from '../subject.js'

export const hiddenHandSubject: TurnBasedConformanceSubject<
  HiddenHandState,
  HiddenHandAction,
  HiddenHandView,
  HiddenHandSettings,
  HiddenHandEvent
> = {
  manifest,
  server,
  secrets: [
    // Each seat's remaining cards, visible to that seat and nobody else.
    // Played cards leave the hand, so they stop being secret at exactly the
    // moment they become public — which is what makes the fuzzer precise.
    perSeatSecret('seat hand', (state) =>
      state.hands.map((entry) => ({
        seatId: entry.seatId,
        values: entry.cards.map((card) => card.id),
      })),
    ),
  ],
  // Two card ids from the smallest possible deck, so the reverse half of
  // `legal-actions-agree` has something real to try at every position.
  probeActions: [
    { type: 'play', cardId: 'c01' },
    { type: 'play', cardId: 'c04' },
  ],
  malformedActions: [
    { type: 'play' },
    { type: 'play', cardId: '' },
    { type: 'play', cardId: 42 },
    { type: 'play', cardId: 'this-card-id-is-far-too-long' },
    { type: 'discard', cardId: 'c01' },
  ],
}

/**
 * PER-242 / PER-250 — `extractRoomCode`, the rule by which a paste that carries
 * more than a code yields the code.
 *
 * The rule is "exactly one **distinct** run of exactly six alphabet
 * characters". These cases pin the rule itself;
 * `apps/web/test/room/join-code-prose-paste.test.tsx` pins what
 * `JoinByCodeForm` does with each answer, which is the half a helper-level test
 * cannot reach.
 */

import { describe, expect, it } from 'vitest'

import { APPROVED_NAME } from '../src/brand'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, extractRoomCode } from '../src/room-code'

const CODE = 'ABC234'

/** The successful outcome, spelled once so the tables below stay readable. */
const found = (code: string) => ({ outcome: 'extracted', code })

describe('extractRoomCode', () => {
  it('is pinned to an alphabet that excludes 0 1 I L O', () => {
    // The whole rule rests on this: if any of these were admitted, `JOIN`,
    // `HTTPS://` and most English words would stop shattering into short runs
    // and would start producing six-runs of their own. The exclusion is the
    // mechanism, not an incidental property, so it is asserted here rather than
    // left as a comment.
    for (const excluded of '01ILO') expect(ROOM_CODE_ALPHABET).not.toContain(excluded)
    expect(ROOM_CODE_LENGTH).toBe(6)
  })

  it('returns a bare code unchanged, and lower-cases up', () => {
    expect(extractRoomCode(CODE)).toEqual(found(CODE))
    expect(extractRoomCode('abc234')).toEqual(found(CODE))
  })

  describe('finds the code with prose or URL chrome in front of it', () => {
    // `example.test` here: these rows are about the *chrome*, not the host, and
    // the rule parses no URLs. The brand's own survival is measured separately
    // below, against `APPROVED_NAME` rather than a stand-in, because a
    // fixture host cannot tell us anything about the name we actually ship.
    const CARRIERS = [
      'https://example.test/join/ABC234',
      'example.test/join/ABC234',
      'https://example.test/r/ABC234',
      'Code: ABC234',
      'join with ABC234',
      'ABC234 join me',
      'Join my game: ABC234 - see you there',
    ] as const

    for (const raw of CARRIERS) {
      it(JSON.stringify(raw), () => {
        expect(extractRoomCode(raw)).toEqual(found(CODE))
      })
    }
  })

  describe('survives the approved brand name, not just a fixture host', () => {
    // The one way this rule could be silently un-fixed is a product domain
    // whose name forms a six-run of its own — then every invite link carries
    // two candidates and extraction declines on the commonest paste there is.
    // `APPROVED_NAME` is read, not spelled, so the day the board changes it
    // this test changes answer instead of staying green against a stale string.
    // The TLDs are stand-ins: the domain is still open (PER-2), and a TLD is
    // too short to form a six-run anyway — the name is where the risk is.
    const NAME = APPROVED_NAME.toLowerCase()

    it(`shatters ${JSON.stringify(APPROVED_NAME)} into runs shorter than a code`, () => {
      // Playhall survives on its two `L`s: `P` + `AYHA`. Stated as its own
      // assertion so a rename that happens to produce a six-run fails *here*,
      // naming the cause, rather than six rows down naming only the symptom.
      const runs = APPROVED_NAME.toUpperCase()
        .split(new RegExp(`[^${ROOM_CODE_ALPHABET}]`))
        .filter((run) => run !== '')
      for (const run of runs) expect(run.length).not.toBe(ROOM_CODE_LENGTH)
    })

    const BRANDED = [
      `https://${NAME}.gg/join/ABC234`,
      `${NAME}.gg/join/ABC234`,
      `https://www.${NAME}.games/join/ABC234`,
      `https://${NAME}.gg/join/ABC234?utm_source=whatsapp`,
      `https://${NAME}.gg/join/ABC234#seat=2`,
      `Join my ${APPROVED_NAME} game: https://${NAME}.gg/join/ABC234`,
    ] as const

    for (const raw of BRANDED) {
      it(JSON.stringify(raw), () => {
        expect(extractRoomCode(raw)).toEqual(found(CODE))
      })
    }
  })

  describe('the same code twice is one candidate, not two', () => {
    // PER-250 B1. We hand every host *both* a link and a code, so a message
    // carrying the code twice is a shape the product itself causes — and before
    // the dedupe it was the one shape where a well-formed invite lost to the
    // cap and landed something like `HEREST`.
    const DOUBLED = [
      `Here's the link https://${APPROVED_NAME.toLowerCase()}.gg/join/ABC234 — code is ABC234`,
      'https://example.test/join/ABC234\nCode: ABC234',
      'ABC234 — https://example.test/join/ABC234',
    ] as const

    for (const raw of DOUBLED) {
      it(JSON.stringify(raw), () => {
        expect(extractRoomCode(raw)).toEqual(found(CODE))
      })
    }

    it('dedupes on the canonical value, so case and punctuation do not split it', () => {
      expect(extractRoomCode('abc234 / ABC234')).toEqual(found(CODE))
    })

    it('still declines when the two six-runs disagree', () => {
      // The dedupe must not become "take the first": `ABCDEF` and `ABC234` are
      // two genuinely different candidates and guessing between them is the
      // coin flip this rule exists to refuse.
      expect(extractRoomCode('ABCDEF https://example.test/join/ABC234')).toEqual({
        outcome: 'ambiguous',
        codes: ['ABCDEF', CODE],
      })
    })
  })

  describe('declines rather than guessing', () => {
    it('declines a seven-run, so the caller still drops and announces the 7th', () => {
      // The load-bearing refusal. A substring search returns `ABC234` here and
      // turns a reported typo into a silent wrong room — see PER-214.
      expect(extractRoomCode('ABC2345')).toEqual({ outcome: 'declined' })
      expect(extractRoomCode('Code: ABC2345')).toEqual({ outcome: 'declined' })
    })

    it('reports two different six-runs as ambiguous, which is not the same as declined', () => {
      // `SECRET` is six alphabet characters. Nothing distinguishes it from the
      // code, so returning either would be a coin flip presented as certainty —
      // but the caller can still say *why*, which is what separates this
      // outcome from `declined`. PER-250 call 3.
      expect(extractRoomCode('Secret code ABC234')).toEqual({
        outcome: 'ambiguous',
        codes: ['SECRET', CODE],
      })
      expect(extractRoomCode('ABCDEF GHJKMN')).toEqual({
        outcome: 'ambiguous',
        codes: ['ABCDEF', 'GHJKMN'],
      })
    })

    it('declines a short run, an empty input, and input with no code in it', () => {
      expect(extractRoomCode('ABC23')).toEqual({ outcome: 'declined' })
      expect(extractRoomCode('ABC-234')).toEqual({ outcome: 'declined' })
      expect(extractRoomCode('')).toEqual({ outcome: 'declined' })
      expect(extractRoomCode('lol')).toEqual({ outcome: 'declined' })
    })
  })

  it('treats every non-alphabet character as a boundary, not only whitespace', () => {
    // `ABC-234` is the PER-197 shape: two short runs, so extraction declines and
    // the caller's `normalizeRoomCode` + cap resolves it to `ABC234` as before.
    // Extraction must not join runs across a separator, or `ABC-2345` — eight
    // raw characters carrying a seven-character typo — would come back as a code.
    expect(extractRoomCode('ABC-2345')).toEqual({ outcome: 'declined' })
    expect(extractRoomCode('ABC-234-5')).toEqual({ outcome: 'declined' })
  })

  it('ignores excluded letters without letting them join two runs', () => {
    // `O` is not in the alphabet, so `ABCO234` is `ABC` + `234`: two runs of
    // three, not one run of six. Folding it away first would produce `ABC234`
    // and accept a code with a character that cannot be in one.
    expect(extractRoomCode('ABCO234')).toEqual({ outcome: 'declined' })
  })

  describe('the family this rule is silently wrong about', () => {
    /**
     * PER-250 B3. A six-letter word of prose standing next to a code that is
     * *not* six is the only six-run present, so extraction accepts the prose
     * confidently and the field says nothing. Before extraction the cap landed
     * the same wrong value but at least announced a loss, so for this family
     * the residual risk is **larger**, not "strictly smaller" as the first
     * version of this rule's doc comment claimed.
     *
     * These rows are pinned, not fixed. The block below is why.
     */
    const SILENTLY_WRONG = [
      { raw: 'Secret code ABC2345', takes: 'SECRET' },
      { raw: 'Secret code ABC23', takes: 'SECRET' },
      { raw: 'Your answer: ABC2345', takes: 'ANSWER' },
    ] as const

    for (const { raw, takes } of SILENTLY_WRONG) {
      it(`takes ${takes} from ${JSON.stringify(raw)} and cannot tell`, () => {
        expect(extractRoomCode(raw)).toEqual(found(takes))
      })
    }

    /**
     * Both candidate fixes measured against the shapes we must not lose. Each
     * is the rule plus one extra refusal, and each refusal costs more than the
     * three rows above are worth — so the hole stays open and documented rather
     * than closed at the price of a common paste.
     *
     * This is a measurement, not a guard on shipped behaviour: nothing in
     * `src/` implements either candidate. It fails if someone adds one.
     */
    const runsOf = (input: string) =>
      input
        .toUpperCase()
        .split(new RegExp(`[^${ROOM_CODE_ALPHABET}]`))
        .filter((run) => run !== '')

    const CANDIDATES = [
      {
        name: 'decline when any run is longer than six',
        declines: (input: string) => runsOf(input).some((run) => run.length > ROOM_CODE_LENGTH),
        // `WHATSAPP` is an eight-run, and it is in the query string of every
        // link we will ever share into the app most of our players use.
        breaks: `https://${APPROVED_NAME.toLowerCase()}.gg/join/ABC234?utm_source=whatsapp`,
      },
      {
        name: 'decline when another run is within one of code length',
        declines: (input: string) =>
          runsOf(input).filter((run) => run.length === 5 || run.length === 7).length > 0,
        // `HTTPS` is a five-run. This one throws away every link with a scheme,
        // which is to say the primary share artifact.
        breaks: 'https://example.test/join/ABC234',
      },
    ] as const

    for (const candidate of CANDIDATES) {
      it(`"${candidate.name}" is rejected: it loses ${JSON.stringify(candidate.breaks)}`, () => {
        // The candidate would fire on a paste that currently works…
        expect(extractRoomCode(candidate.breaks)).toEqual(found(CODE))
        expect(candidate.declines(candidate.breaks)).toBe(true)

        // …and the shipped rule does not, which is the whole point.
        expect(extractRoomCode(candidate.breaks).outcome).toBe('extracted')
      })
    }

    it('neither candidate even rescues the whole family', () => {
      // `Secret code ABC23` has no run longer than six, so candidate 1 leaves
      // it exactly as wrong as it is today. A fix that is both expensive and
      // partial is not a fix.
      const [longRunCandidate] = CANDIDATES
      expect(longRunCandidate.declines('Secret code ABC23')).toBe(false)
      expect(extractRoomCode('Secret code ABC23')).toEqual(found('SECRET'))
    })
  })
})

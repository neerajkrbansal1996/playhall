/**
 * PER-242 / PER-250 — `extractRoomCode`, the rule by which a paste that carries
 * more than a code yields the code.
 *
 * The rule is "exactly one **distinct** run of exactly six alphabet
 * characters". These cases pin the rule itself;
 * `apps/web/test/room/join-code-prose-paste.test.tsx` and
 * `join-code-link-paste.test.tsx` pin what `JoinByCodeForm` does with each
 * answer, which is the half a helper-level test cannot reach.
 *
 * This file is deliberately separate from `room-code.test.ts`, which
 * [PER-228](/PER/issues/PER-228) owns and which covers `ROOM_CODE_ALPHABET`,
 * `normalizeRoomCode` and `isValidRoomCode`. One file per rule, so the two
 * changes do not collide in the same new file on the way to `main`.
 */

import { describe, expect, it } from 'vitest'

import { APPROVED_NAME } from '../src/brand'
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  capWouldKeepNoise,
  extractRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '../src/room-code'

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

    it('orders the candidates as they appear, which is what the field shows', () => {
      // `JoinByCodeForm` puts `codes[0]` in the field rather than the cap's
      // answer, so document order is a contract and not an accident of the
      // implementation. The shape that makes it matter is an invite link with a
      // six-character query value: the path's code comes first, and the cap's
      // answer for the same input is `HTTPSP` — the scheme, which is not a
      // candidate at all and is not a value the player has ever seen.
      const reading = extractRoomCode('https://playhall.app/r/ABC234?ref=XYZ789')
      expect(reading).toEqual({ outcome: 'ambiguous', codes: [CODE, 'XYZ789'] })

      // Pinned as the negative too: a change that sorted or reversed the list
      // would still satisfy a `toContain`, and would silently start showing the
      // referrer as the room code.
      if (reading.outcome !== 'ambiguous') throw new Error('expected ambiguous')
      expect(reading.codes[0]).toBe(CODE)
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

/**
 * PER-277 — `capWouldKeepNoise`, the rule by which the caller's fallback is
 * refused rather than trusted.
 *
 * `extractRoomCode` declining is not one situation but two, and the difference
 * is in what the *caller's* fallback would produce. `normalizeRoomCode` + a
 * six-character cap turns `ABC2345` into `ABC234` — the player's code with the
 * seventh character trimmed, which is what PER-214's overflow note was written
 * to report. It turns `https://playhall.app/play/chess` into `HTTPSP`, which is
 * the scheme plus one character and no part of anything the player was sent.
 * Both used to get the same note. One of them was lying.
 *
 * These cases pin the rule; `apps/web/test/room/join-code-link-paste.test.tsx`
 * pins what `JoinByCodeForm` does with the answer, which is the half a
 * helper-level test cannot reach — it empties the field and says so.
 */
describe('capWouldKeepNoise', () => {
  /** What the caller does when this returns false: normalise, then keep six. */
  const capKeeps = (input: string) => normalizeRoomCode(input).slice(0, ROOM_CODE_LENGTH)

  /**
   * The family. `keeps` is spelled out per row rather than computed, for the
   * same reason the `capWouldKeep` column in the component tests is: the point
   * is that each one is a plausible code bearing no relation to the paste, and
   * a computed expectation would restate the implementation instead of pinning
   * that.
   *
   * The hosts are mixed on purpose and none of them is read. `www.playhall.app`
   * is the row that matters most to the mechanism: it has no scheme and no
   * slash, so every "does this look like a link" signal misses it, and it is the
   * form a chat app delivers once it has stripped `https://`.
   */
  const NOISE = [
    { raw: 'https://playhall.app', keeps: 'HTTPSP' },
    { raw: 'https://playhall.app/', keeps: 'HTTPSP' },
    { raw: 'https://playhall.app/play/chess', keeps: 'HTTPSP' },
    { raw: 'https://playhall.app/r/ABC23', keeps: 'HTTPSP' },
    { raw: 'https://playhall.app/r/ABC2345', keeps: 'HTTPSP' },
    { raw: 'www.playhall.app', keeps: 'WWWPAY' },
    { raw: 'https://example.com/some/article', keeps: 'HTTPSE' },
    { raw: 'https://ab2.cde/play/chess', keeps: 'HTTPSA' },
    // Not a link at all, and in this family all along — the ticket's table only
    // listed links. `CODE:` contributes `C` and `DE`, so the cap stitches
    // `CDEABC` out of two runs and the seven-character typo is never reached.
    { raw: 'Code: ABC2345', keeps: 'CDEABC' },
  ] as const

  it('is a table of values that all pass the length check', () => {
    // The property that makes the family a defect rather than cosmetic: nothing
    // downstream of the field can tell any of these is not a code.
    for (const { raw, keeps } of NOISE) {
      expect(capKeeps(raw)).toBe(keeps)
      expect(isValidRoomCode(keeps)).toBe(true)
    }
  })

  it('only ever speaks about input extraction has already declined', () => {
    // The precondition. If any row grew a six-run, the component would extract
    // it and never consult this rule, so the row would be measuring nothing.
    for (const { raw } of NOISE) expect(extractRoomCode(raw).outcome).toBe('declined')
  })

  for (const { raw, keeps } of NOISE) {
    it(`refuses ${keeps} for ${JSON.stringify(raw)}`, () => {
      expect(capWouldKeepNoise(raw)).toBe(true)
    })
  }

  /**
   * The other half of every declined input: the cap's answer *is* the player's
   * code, damaged, and PER-214's note is the right thing to say about it. Each
   * row is here because one clause of the rule exists to save it — delete that
   * clause and exactly these fail.
   */
  const SALVAGEABLE = [
    // PER-214: one run, one character too many. Saved by "not all from the
    // first run" — the whole canonical value is one run of seven.
    { raw: 'ABC2345', keeps: 'ABC234' },
    // …and the same at greater length. An over-long code is still a code the
    // player typed, however far it ran on, so the note stays true of it. This
    // is the row that rules out "dropped more than one" as a rule on its own.
    { raw: 'ABC23456', keeps: 'ABC234' },
    { raw: 'ABC234567', keeps: 'ABC234' },
    // PER-197: a real code typed with separators. Stitched out of two runs, so
    // saved by the other clause — only one character was discarded.
    { raw: 'ABC-2345', keeps: 'ABC234' },
    { raw: 'ABC-234-5', keeps: 'ABC234' },
  ] as const

  for (const { raw, keeps } of SALVAGEABLE) {
    it(`trusts the cap's ${keeps} for ${JSON.stringify(raw)}`, () => {
      expect(extractRoomCode(raw).outcome).toBe('declined')
      expect(capKeeps(raw)).toBe(keeps)
      expect(capWouldKeepNoise(raw)).toBe(false)
    })
  }

  it('says nothing about input the cap never sees', () => {
    // Below the cap there is nothing to discard, so the question does not
    // arise. Asserted rather than assumed because the component calls this
    // before it normalises, on every keystroke, and a `true` here would empty
    // the field mid-type.
    for (const raw of ['', 'lol', 'ABC23', 'ABC234', 'ABC-234', '  abc-234  ', '3.14159']) {
      expect(capWouldKeepNoise(raw)).toBe(false)
    }
  })

  it('trusts a first run of exactly six, which is the clause boundary', () => {
    // `< ROOM_CODE_LENGTH` and `<= ROOM_CODE_LENGTH` differ only here, and the
    // component cannot tell them apart: a six-run means extraction extracted or
    // reported ambiguity, so the fallback is never reached and no rendered case
    // can fail. Caught by mutating the comparison, pinned here because this is
    // the only level at which it is observable.
    //
    // The answer has to be `false`. A first run of exactly six is the one case
    // where the cap keeps a whole token, untrimmed — the most trustworthy thing
    // it can do, not the least.
    expect(capWouldKeepNoise('ABCDEF GHJKMN')).toBe(false)
    expect(capKeeps('ABCDEF GHJKMN')).toBe('ABCDEF')
    expect(extractRoomCode('ABCDEF GHJKMN').outcome).toBe('ambiguous')
  })

  it('reads no domain, so the naming decision stays open', () => {
    // The same guard `extractRoomCode` carries, for the same reason (PER-2).
    // Two hosts nobody will ship, one with a scheme and one without: if either
    // clause grew a host allowlist or a domain constant, these diverge.
    expect(capWouldKeepNoise('https://zzz.invalid/play/chess')).toBe(true)
    expect(capWouldKeepNoise('zzz.invalid/play/chess')).toBe(true)
  })

  /**
   * The measurement, in the form the ticket asked for: both of PER-277's
   * proposed rules run over the pinned corpus, with the rows they get wrong
   * named. Neither is implemented in `src/` — this fails if someone adds one.
   *
   * The corpus is the two tables above, which between them are every paste in
   * `join-code-link-paste.test.tsx`, `join-code-prose-paste.test.tsx` and
   * `join-code-overflow.test.tsx` that reaches the cap at all.
   */
  const runsOf = (input: string) =>
    input
      .toUpperCase()
      .split(new RegExp(`[^${ROOM_CODE_ALPHABET}]`))
      .filter((run) => run !== '')

  const CANDIDATES = [
    {
      // PER-277's second idea: clear only when nothing in the paste could
      // plausibly be a mistyped code.
      name: 'no run of 4-6 characters',
      fires: (input: string) => !runsOf(input).some((r) => r.length >= 4 && r.length <= 6),
      // It misses every codeless link, because `HTTPS` is a five-run and
      // `PLAYHALL` shatters into `P` + `AYHA` on its two `L`s — a four-run.
      misses: 'https://playhall.app/play/chess',
      // And it clears PER-214's row, because `ABC2345` is a seven-run.
      wrecks: 'ABC2345',
    },
    {
      // PER-277's first idea: a signal that the input was a link. The weakest
      // form, which is the only form the PER-242 ruling leaves available — a
      // stronger one would be the URL parsing that ruling declined.
      name: 'the input contains ://',
      fires: (input: string) => input.includes('://'),
      // Clean on everything it fires on, but it cannot see a schemeless host —
      // and `contains /` misses this row too.
      misses: 'www.playhall.app',
      wrecks: undefined,
    },
  ] as const

  for (const candidate of CANDIDATES) {
    it(`"${candidate.name}" is rejected: it misses ${JSON.stringify(candidate.misses)}`, () => {
      expect(candidate.fires(candidate.misses)).toBe(false)
      // …where the shipped rule does not, which is the whole point.
      expect(capWouldKeepNoise(candidate.misses)).toBe(true)
    })

    if (candidate.wrecks !== undefined) {
      const wrecks: string = candidate.wrecks
      it(`"${candidate.name}" is rejected: it also clears ${JSON.stringify(wrecks)}`, () => {
        expect(candidate.fires(wrecks)).toBe(true)
        // A row the cap gets right and PER-214 exists to announce.
        expect(capWouldKeepNoise(wrecks)).toBe(false)
      })
    }
  }

  it('scores both candidates over the whole corpus, not one row each', () => {
    // The row-at-a-time cases above name a failure; this one bounds it, so a
    // candidate cannot be waved through on the grounds that its one counter-
    // example is unusual. The first is wrong about twelve of the fourteen rows,
    // in both directions: it misses every link in the family it was proposed to
    // fix, and clears every over-long code the cap gets right.
    const corpus = [
      ...NOISE.map((row) => ({ raw: row.raw, noise: true })),
      ...SALVAGEABLE.map((row) => ({ raw: row.raw, noise: false })),
    ]
    const wrongFor = (fires: (input: string) => boolean) =>
      corpus.filter((row) => fires(row.raw) !== row.noise).map((row) => row.raw)

    const [noRun46, hasScheme] = CANDIDATES
    expect(wrongFor(noRun46.fires)).toEqual([
      'https://playhall.app',
      'https://playhall.app/',
      'https://playhall.app/play/chess',
      'https://playhall.app/r/ABC23',
      'https://playhall.app/r/ABC2345',
      'www.playhall.app',
      'https://example.com/some/article',
      'https://ab2.cde/play/chess',
      'ABC2345',
      'ABC23456',
      'ABC234567',
      'ABC-234-5',
    ])
    expect(wrongFor(hasScheme.fires)).toEqual(['www.playhall.app', 'Code: ABC2345'])

    // The shipped rule, measured the same way. Exact over the corpus is the
    // claim this fix is made on, and it is one assertion rather than a column
    // of green ticks.
    expect(wrongFor(capWouldKeepNoise)).toEqual([])
  })
})

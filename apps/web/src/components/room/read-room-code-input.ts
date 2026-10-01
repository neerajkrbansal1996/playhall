import { ROOM_CODE_LENGTH, isValidRoomCode, normalizeRoomCode } from '@playhall/shared'

/**
 * What the join-code field made of the raw string it was handed.
 *
 * `source` is the field's whole account of the input, which is why it is a
 * discriminator and not a pair of booleans: the three cases need three
 * different messages, and a boolean pair admits a fourth state that cannot
 * happen.
 */
export interface RoomCodeInputReading {
  /**
   * The value the field should display: canonical, and never longer than
   * `ROOM_CODE_LENGTH`. Empty when the input was a link we could not read a
   * code out of — see `source`.
   */
  readonly code: string
  /**
   * - `characters` — the ordinary path. The input was read as code characters,
   *   exactly as it always has been.
   * - `link` — the input contained a URL and `code` was lifted out of it.
   * - `link-without-code` — the input contained a URL with no code-shaped
   *   segment in it, so there was nothing to lift and `code` is empty.
   */
  readonly source: 'characters' | 'link' | 'link-without-code'
  /**
   * True when the length cap discarded canonical characters. Only ever true
   * for `characters`: lifting a code out of a link discards the rest of the
   * link by design, and reporting that as an overflow would describe a
   * success as a loss.
   */
  readonly overflowed: boolean
}

/**
 * Something in the pasted string that is a URL rather than prose.
 *
 * Deliberately **not** anchored, so `Join: https://…/r/ABC234` — a forwarded
 * WhatsApp message, the single most likely shape — is recognised, and
 * deliberately **narrow about what counts**, which is the part that carries the
 * risk. A rule as loose as "contains a slash" would swallow `ABC234 and/or`,
 * and `ABC234 join me` already joins the right room today
 * ([PER-234](/PER/issues/PER-234) pins that); turning either into "that looks
 * like a link" would be a worse bug than the one this fixes. So a match needs a
 * scheme, a `www.` label, or a dotted host followed by a path — none of which
 * prose produces by accident.
 *
 * There is no host in here on purpose. The brand and the domain are still a
 * board decision, and a link pasted from staging, a preview deploy, a URL
 * shortener or a future rename has to work the same day it exists. The shape of
 * a URL is what we recognise, never which URL it is.
 */
const URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/i

/** Sentence punctuation that ends up glued to a URL in a chat message. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»]+$/

/**
 * Read a candidate room code out of a URL's path, then its query values.
 *
 * Path segments are scanned **last to first** because the code is the leaf of
 * every invite shape we have (`/r/ABC234`, and the illustrative `/join/ABC234`
 * from [PER-235](/PER/issues/PER-235)), and query values only after the whole
 * path has missed — so `/r/ABC234?ref=XYZ789` reads the room and not the
 * referrer. No route or parameter name appears here: `/r/[code]` is not built
 * yet ([PER-20](/PER/issues/PER-20) owns it), and a reader keyed on the segment
 * *shape* keeps working when it lands under a different name.
 *
 * Returns `undefined` when no part of the URL is a well-formed code, which is a
 * real outcome and not a failure — a game link, a bare host, or a landing-page
 * URL all legitimately carry no code.
 */
function liftCodeFromUrl(url: string): string | undefined {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const [beforeHash = ''] = withoutScheme.split('#')
  const [pathPart = '', queryPart = ''] = beforeHash.split('?')

  // `slice(1)` drops the host: `playhall.app` normalises to `PAYHAAPP`, which
  // is not code-shaped, but a two-label host under a six-character brand would
  // be, and reading the host as a room code is never right.
  const segments = pathPart.split('/').slice(1)
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeRoomCode(segments[i] ?? '')
    if (isValidRoomCode(candidate)) return candidate
  }

  for (const pair of queryPart.split('&')) {
    const candidate = normalizeRoomCode(pair.split('=')[1] ?? '')
    if (isValidRoomCode(candidate)) return candidate
  }

  return undefined
}

/**
 * Turn whatever arrived in the join-code field into the value to display.
 *
 * ## Why a link is read as a link
 *
 * Share-first (principle 4) gives every lobby a link *and* a code, so a player
 * holding the link is the normal case — and the landing page puts "Join with a
 * code" right next to it, so pasting the link into the code box is a thing
 * people do. Before [PER-235](/PER/issues/PER-235) that paste was read as code
 * characters, and because `ROOM_CODE_ALPHABET` excludes `0 O 1 I L`, `https://`
 * normalises to `HTTPS` — five perfectly ordinary code characters. The field
 * showed `HTTPSP`, `isValidRoomCode` accepted it, and the press sent it. The
 * code the player was holding was *literally in the string they pasted* and we
 * sent six characters of the scheme instead.
 *
 * So the rule is: **if the input contains a URL, the field reads the URL and
 * nothing else.** Two consequences worth stating, because both are deliberate:
 *
 * - Characters outside the URL are dropped, including a code that happens to
 *   sit beside an unrelated link. That shape ("see https://example.com/post
 *   ABC234") is far rarer than the one this fixes, and the
 *   `link-without-code` message tells the player exactly what to do about it.
 * - A URL with no code in it clears the field rather than leaving a plausible
 *   six characters in it. An empty field plus "that looks like a link" is an
 *   outcome connected to what the player did; `HTTPSP` was not.
 *
 * Everything that is not a URL is read exactly as before — normalise, then cap,
 * and flag the cap — so the prose shapes PER-234 pins are untouched.
 *
 * ## Why this is a pure function and not inline in the component
 *
 * The decision is "which of three readings is this string", and the three are
 * worth enumerating against directly: a case table is the only way to show
 * that `ABC234 and/or something` is still read as characters while
 * `Join: https://h/r/ABC234` is not. Through the component each row would cost
 * a render and an event, and the near-misses are the half that matter.
 */
export function readRoomCodeInput(raw: string): RoomCodeInputReading {
  const match = URL_IN_TEXT.exec(raw)

  if (match) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '')
    const lifted = liftCodeFromUrl(url)
    return lifted === undefined
      ? { code: '', source: 'link-without-code', overflowed: false }
      : { code: lifted, source: 'link', overflowed: false }
  }

  const canonical = normalizeRoomCode(raw)
  return {
    code: canonical.slice(0, ROOM_CODE_LENGTH),
    source: 'characters',
    overflowed: canonical.length > ROOM_CODE_LENGTH,
  }
}

/**
 * Display-name profanity screen.
 *
 * Deliberately small and mechanical. A large blocklist looks thorough and is
 * mostly false positives; what actually protects a lobby is that a name is one
 * line of text next to a report button, not that the filter is exhaustive. The
 * list below covers the words that would get a lobby closed in a school or a
 * workplace, and the service accepts `extraTerms` so Product can tune it
 * without a platform release.
 *
 * The screen folds the input before matching, so `f.u.c.k`, `FÜCK` and `fuq`
 * all collapse onto the same candidate string. That folding is what creates
 * false positives ("Scunthorpe"), so `SAFE_SUBSTRINGS` re-permits the innocent
 * words that contain a blocked term. Matching is substring-based on purpose:
 * word boundaries disappear once punctuation is stripped.
 *
 * Folding and allowlisting both happen **per word** before they happen on the
 * whole name. Folding the whole name first concatenates across spaces, which
 * makes an exact-match allowlist unreachable the moment a second word appears
 * ("Emily Dickinson" folds to `emilydickinson`, which is not `dickinson`) while
 * leaving the substring blocklist perfectly able to fire. The whole-name pass
 * is still run, over the words the allowlist did *not* clear, because that is
 * what catches a term split across a space ("Fu ck").
 */

/**
 * Characters people substitute to dodge a filter, mapped back to the letter
 * they stand in for. Applied after diacritic stripping.
 */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
}

/**
 * Blocked terms, already in folded form (lower case, letters only). Keep them
 * >= 3 characters: shorter terms match inside too many ordinary words for the
 * allowlist to keep up.
 */
const BLOCKED_TERMS: readonly string[] = [
  'anal',
  'anus',
  'arse',
  'bastard',
  'bitch',
  'blowjob',
  'bollock',
  'boner',
  'chink',
  'clit',
  'cock',
  'coon',
  'cunt',
  'dick',
  'dildo',
  'dyke',
  'fag',
  'fuck',
  'fuk',
  'gook',
  'handjob',
  'jizz',
  'kike',
  'nigg',
  'paki',
  'penis',
  'piss',
  'porn',
  'pussy',
  'rape',
  'retard',
  'scrotum',
  'semen',
  'shit',
  'slut',
  'spic',
  'tits',
  'tranny',
  'twat',
  'vagina',
  'wank',
  'whore',
]

/**
 * Folded words that contain a blocked term but are not profanity. Matched
 * exactly, against each folded word and against the folded whole name, so
 * "cockfaceshuttlecock" — one word, and not an entry here — does not get a
 * free pass off the back of "shuttlecock".
 */
const SAFE_SUBSTRINGS: readonly string[] = [
  'scunthorpe',
  'penistone',
  'cockburn',
  'cocktail',
  'shuttlecock',
  'peacock',
  'hancock',
  'woodcock',
  'dickens',
  'dickinson',
  'analysis',
  'analyst',
  'analog',
  'analogue',
  'canalboat',
  'assassin',
  'classic',
  'grape',
  'grapes',
  'therapist',
  'titan',
  'titanic',
  'titans',
  'clitheroe',
  'mishit',
  'sussex',
  'essex',
  'middlesex',
]

const DIACRITIC_RANGE = /[\u0300-\u036F]/g
const NON_LETTERS = /[^a-z]/g

/**
 * Collapses a display name to the form the blocklist is written in: lower
 * case, diacritics removed, leet-speak reversed, everything that is not a
 * latin letter dropped. Repeated letters are *not* collapsed — doing so turns
 * "Anna" into "ana" and creates more false positives than it prevents evasions.
 */
export function foldForProfanity(value: string): string {
  const deaccented = value.normalize('NFD').replace(DIACRITIC_RANGE, '').toLowerCase()
  let out = ''
  for (const ch of deaccented) out += LEET[ch] ?? ch
  return out.replace(NON_LETTERS, '')
}

export interface ProfanityOptions {
  /** Additional folded terms to block. Folded automatically if not already. */
  readonly extraTerms?: readonly string[]
  /**
   * Words to allow even though they contain a blocked term. An entry with a
   * space in it allows that whole phrase and nothing else: `'Pea Cock'` permits
   * exactly "Pea Cock", where `'peacock'` permits the single word and does not
   * let "Pea Cock" through the back door.
   */
  readonly extraAllowed?: readonly string[]
}

const WORD_SPLIT = /\s+/

interface Allowlist {
  /** Folded single words. Matched against each word of the name. */
  readonly words: ReadonlySet<string>
  /** Folded multi-word entries. Matched against the whole folded name. */
  readonly phrases: ReadonlySet<string>
}

function buildAllowlist(extra: readonly string[]): Allowlist {
  const words = new Set<string>(SAFE_SUBSTRINGS)
  const phrases = new Set<string>()
  for (const entry of extra) {
    const folded = foldForProfanity(entry)
    if (folded.length === 0) continue
    if (WORD_SPLIT.test(entry.trim())) phrases.add(folded)
    else words.add(folded)
  }
  return { words, phrases }
}

/** The folded words of a name, in order, with empty folds dropped. */
function foldWords(value: string): string[] {
  const words: string[] = []
  for (const word of value.split(WORD_SPLIT)) {
    const folded = foldForProfanity(word)
    if (folded.length > 0) words.push(folded)
  }
  return words
}

function firstMatch(candidate: string, terms: readonly string[]): string | undefined {
  for (const term of terms) {
    if (candidate.includes(term)) return term
  }
  return undefined
}

/**
 * Returns the blocked term that matched, or `undefined` if the name is clean.
 * Returning the term (not just a boolean) keeps the moderation log useful
 * without having to re-run the screen.
 *
 * Three passes, in this order:
 *
 * 1. An allowlisted *phrase* matching the whole folded name clears everything.
 *    Only a configured multi-word entry can do this — a single-word entry must
 *    not, or "Pea Cock" walks in behind "peacock".
 * 2. Each folded word the allowlist did not clear is screened on its own.
 *    "Peacock Jim" gets here as `peacock` (cleared) and `jim` (clean).
 * 3. The cleared words are dropped and what is left is concatenated and
 *    screened as one string. That catches a term written across a space
 *    ("Fu ck" -> `fuck`) without resurrecting one that only exists because two
 *    innocent words were spliced together ("Grape Ape" -> `ape`, not `grapeape`).
 *
 * Pass 3 still has cross-word false positives for words that are not on the
 * allowlist ("Bo Nerdy" folds to `bonerdy`). That is the same trade the old
 * whole-name fold made, minus the allowlisted cases; `extraAllowed` is the
 * release valve, and a name is one line of text next to a report button.
 */
export function findProfanity(value: string, options: ProfanityOptions = {}): string | undefined {
  const words = foldWords(value)
  if (words.length === 0) return undefined

  const allowed = buildAllowlist(options.extraAllowed ?? [])
  if (allowed.phrases.has(words.join(''))) return undefined

  const terms = [...BLOCKED_TERMS, ...(options.extraTerms ?? []).map(foldForProfanity)].filter(
    (term) => term.length > 0,
  )

  const uncleared: string[] = []
  for (const word of words) {
    if (allowed.words.has(word)) continue
    const hit = firstMatch(word, terms)
    if (hit !== undefined) return hit
    uncleared.push(word)
  }

  return firstMatch(uncleared.join(''), terms)
}

export function isProfane(value: string, options: ProfanityOptions = {}): boolean {
  return findProfanity(value, options) !== undefined
}

/** Exposed so the fun-name generator can assert its own word lists are clean. */
export const PROFANITY_TERMS: readonly string[] = BLOCKED_TERMS

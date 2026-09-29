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
 * Folded strings that contain a blocked term but are not profanity. If the
 * whole folded name is one of these, it passes. Exact-match rather than
 * substring, so "cockfaceshuttlecock" does not get a free pass.
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
  /** Folded whole-name strings to allow even if they contain a blocked term. */
  readonly extraAllowed?: readonly string[]
}

/**
 * Returns the blocked term that matched, or `undefined` if the name is clean.
 * Returning the term (not just a boolean) keeps the moderation log useful
 * without having to re-run the screen.
 */
export function findProfanity(value: string, options: ProfanityOptions = {}): string | undefined {
  const folded = foldForProfanity(value)
  if (folded.length === 0) return undefined

  const allowed = new Set<string>([
    ...SAFE_SUBSTRINGS,
    ...(options.extraAllowed ?? []).map(foldForProfanity),
  ])
  if (allowed.has(folded)) return undefined

  const terms = [...BLOCKED_TERMS, ...(options.extraTerms ?? []).map(foldForProfanity)]
  for (const term of terms) {
    if (term.length > 0 && folded.includes(term)) return term
  }
  return undefined
}

export function isProfane(value: string, options: ProfanityOptions = {}): boolean {
  return findProfanity(value, options) !== undefined
}

/** Exposed so the fun-name generator can assert its own word lists are clean. */
export const PROFANITY_TERMS: readonly string[] = BLOCKED_TERMS

/**
 * Pre-filled guest names.
 *
 * Principle 3 is zero friction: landing page to playable lobby in two taps.
 * An empty, required name field is a tap and a keyboard, so the field arrives
 * filled with something a player is happy to keep. Adjective + animal, because
 * it is short, reads on a 360 px-wide seat chip, and cannot accidentally name
 * a real person.
 *
 * Generation runs through the SDK's seeded `Rng`, not `Math.random`: seeding it
 * from the fresh `guestId` means a guest who reloads before choosing a name
 * sees the same suggestion instead of a new one each paint, and a test can pin
 * the output.
 *
 * Both word lists are screened by the profanity tests: every one of the
 * `ADJECTIVES.length * ANIMALS.length` combinations is asserted to be a valid
 * display name, so the generator can never propose a name the server rejects.
 */

import { type Rng, createRng, deriveSeed } from '@playhall/game-sdk'
import { DISPLAY_NAME_MAX_LENGTH } from './display-name.js'

/**
 * Kept to <= 9 characters so `adjective + ' ' + animal` always fits inside
 * `DISPLAY_NAME_MAX_LENGTH`. The exhaustive test enforces it.
 */
export const ADJECTIVES: readonly string[] = [
  'Amber',
  'Bold',
  'Brave',
  'Bright',
  'Calm',
  'Clever',
  'Cosmic',
  'Crimson',
  'Curious',
  'Daring',
  'Eager',
  'Electric',
  'Fearless',
  'Fleet',
  'Gentle',
  'Golden',
  'Happy',
  'Hidden',
  'Jolly',
  'Keen',
  'Lucky',
  'Merry',
  'Mighty',
  'Nimble',
  'Noble',
  'Polar',
  'Quiet',
  'Rapid',
  'Royal',
  'Silent',
  'Silver',
  'Sly',
  'Solar',
  'Spry',
  'Sunny',
  'Swift',
  // "Tidy" is absent on purpose: "Tidy Kestrel" folds to "tidykestrel", which
  // contains a slur on the blocklist. The exhaustive test in
  // `fun-names.test.ts` is what found it, and is what will find the next one.
  'Turbo',
  'Velvet',
  'Witty',
]

export const ANIMALS: readonly string[] = [
  'Badger',
  'Bison',
  'Cheetah',
  'Cobra',
  'Condor',
  'Coyote',
  'Dingo',
  'Dolphin',
  'Falcon',
  'Ferret',
  'Gecko',
  'Gibbon',
  'Heron',
  'Ibex',
  'Impala',
  'Jaguar',
  'Kestrel',
  'Lemur',
  'Lynx',
  'Magpie',
  'Manta',
  'Marmot',
  'Meerkat',
  'Narwhal',
  'Ocelot',
  'Osprey',
  'Otter',
  'Panda',
  'Panther',
  'Pelican',
  'Puffin',
  'Quokka',
  'Raven',
  'Rhino',
  'Salmon',
  'Tapir',
  'Tiger',
  'Toucan',
  'Viper',
  'Walrus',
]

/** Every name this generator can produce. Used by the exhaustive test. */
export function allFunNames(): string[] {
  const names: string[] = []
  for (const adjective of ADJECTIVES) {
    for (const animal of ANIMALS) names.push(`${adjective} ${animal}`)
  }
  return names
}

/**
 * Picks a suggestion from a caller-supplied stream. Use this when you already
 * hold an `Rng` (the room runner does); use `suggestDisplayNameFor` otherwise.
 */
export function suggestDisplayName(rng: Rng): string {
  return `${rng.pick(ADJECTIVES)} ${rng.pick(ANIMALS)}`
}

/**
 * The suggestion for a given guest. Deterministic: same `guestId`, same name,
 * across reloads and across server instances.
 */
export function suggestDisplayNameFor(guestId: string): string {
  return suggestDisplayName(createRng(deriveSeed('guest-name', guestId)))
}

/** Longest name the generator can emit. Asserted against the limit in tests. */
export const MAX_FUN_NAME_LENGTH: number =
  Math.max(...ADJECTIVES.map((word) => word.length)) +
  1 +
  Math.max(...ANIMALS.map((word) => word.length))

/** True while every generated name fits the field. The exhaustive test proves it. */
export const FUN_NAMES_FIT: boolean = MAX_FUN_NAME_LENGTH <= DISPLAY_NAME_MAX_LENGTH

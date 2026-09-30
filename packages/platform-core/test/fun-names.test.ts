import { createRng } from '@playhall/game-sdk'
import { describe, expect, it } from 'vitest'
import {
  ADJECTIVES,
  ANIMALS,
  FUN_NAMES_FIT,
  MAX_FUN_NAME_LENGTH,
  allFunNames,
  suggestDisplayName,
  suggestDisplayNameFor,
} from '../src/identity/fun-names.js'
import { DISPLAY_NAME_MAX_LENGTH, validateDisplayName } from '../src/identity/display-name.js'

describe('the generated name space', () => {
  it('is large enough that a lobby rarely sees a collision', () => {
    expect(ADJECTIVES.length * ANIMALS.length).toBeGreaterThanOrEqual(1000)
  })

  it('has no duplicate words', () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length)
    expect(new Set(ANIMALS).size).toBe(ANIMALS.length)
  })

  it('cannot propose a name the server would reject', () => {
    // Exhaustive, not sampled: a suggestion that fails validation is a dead end
    // for the player, and the two-tap path is the whole point of pre-filling.
    const failures = allFunNames().filter((name) => !validateDisplayName(name).ok)
    expect(failures).toEqual([])
  })

  it('always fits the display-name field', () => {
    expect(MAX_FUN_NAME_LENGTH).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH)
    expect(FUN_NAMES_FIT).toBe(true)
    for (const name of allFunNames()) {
      expect(name.length, name).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH)
    }
  })

  it('survives sanitisation unchanged', () => {
    for (const name of allFunNames()) {
      const result = validateDisplayName(name)
      expect(result.ok && result.value).toBe(name)
    }
  })
})

describe('suggestDisplayNameFor', () => {
  it('is stable for a guest id, so a reload does not shuffle the field', () => {
    const first = suggestDisplayNameFor('guest-abc')
    for (let i = 0; i < 100; i += 1) {
      expect(suggestDisplayNameFor('guest-abc')).toBe(first)
    }
  })

  it('differs across guests', () => {
    const names = new Set<string>()
    for (let i = 0; i < 500; i += 1) names.add(suggestDisplayNameFor(`guest-${i}`))
    // Birthday collisions are expected in a 1600-name space; near-total
    // duplication would mean the seeding is broken.
    expect(names.size).toBeGreaterThan(300)
  })

  it('produces "Adjective Animal"', () => {
    const [adjective, animal] = suggestDisplayNameFor('guest-abc').split(' ')
    expect(ADJECTIVES).toContain(adjective)
    expect(ANIMALS).toContain(animal)
  })
})

describe('suggestDisplayName', () => {
  it('draws from a caller-supplied stream', () => {
    const name = suggestDisplayName(createRng('fixed-seed'))
    expect(suggestDisplayName(createRng('fixed-seed'))).toBe(name)
    expect(validateDisplayName(name).ok).toBe(true)
  })

  it('reaches every word given enough draws', () => {
    const adjectives = new Set<string>()
    const animals = new Set<string>()
    for (let i = 0; i < 20_000; i += 1) {
      const [adjective, animal] = suggestDisplayName(createRng(`seed-${i}`)).split(' ') as [
        string,
        string,
      ]
      adjectives.add(adjective)
      animals.add(animal)
    }
    expect(adjectives.size).toBe(ADJECTIVES.length)
    expect(animals.size).toBe(ANIMALS.length)
  })
})

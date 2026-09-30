import { describe, expect, it } from 'vitest'
import { pathOf } from '../src/http'

describe('pathOf', () => {
  it('strips a query string', () => {
    // The regression this exists for: `/debug/throw?code=…` used to 404.
    expect(pathOf('/debug/throw?code=TCQ4MN')).toBe('/debug/throw')
  })

  it('strips a fragment', () => {
    expect(pathOf('/health#top')).toBe('/health')
  })

  it('strips a fragment that precedes a question mark', () => {
    expect(pathOf('/health#a?b')).toBe('/health')
  })

  it('leaves a bare path alone', () => {
    expect(pathOf('/health')).toBe('/health')
  })

  it.each([
    [undefined, '/'],
    ['', '/'],
    ['?only=query', '/'],
  ])('normalises %s to the root path', (input, expected) => {
    expect(pathOf(input)).toBe(expected)
  })
})

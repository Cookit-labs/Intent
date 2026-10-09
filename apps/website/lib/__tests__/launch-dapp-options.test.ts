import { describe, expect, it } from 'vitest'

import { UNAVAILABLE, dappHref } from '../launch-dapp-options'

/**
 * "Launch dApp" is one link, built from one environment variable at build time.
 * It goes to the dApp's origin and nothing deeper, because the dApp decides where
 * to open and has its own chain menu. When the variable is unset the button is
 * disabled, with a label for a visitor and not the name of the variable someone
 * forgot to set.
 */
describe('the Launch dApp link', () => {
  it('goes to the dApp origin, and nothing deeper', () => {
    expect(dappHref('https://app.example.com')).toBe('https://app.example.com')
    expect(dappHref('https://localhost:3001')).toBe('https://localhost:3001')
  })

  it('tolerates a trailing slash and surrounding whitespace on the origin', () => {
    expect(dappHref(' https://app.example.com/ ')).toBe('https://app.example.com')
    expect(dappHref('https://app.example.com///')).toBe('https://app.example.com')
  })

  it('is not configured when the origin is unset or blank', () => {
    for (const value of [undefined, '', '   ', '/']) {
      expect(dappHref(value)).toBeNull()
    }
  })

  it('says so in words for a visitor, never naming the variable', () => {
    expect(UNAVAILABLE).toBe('Not available yet')
    expect(UNAVAILABLE).not.toContain('NEXT_PUBLIC')
  })
})

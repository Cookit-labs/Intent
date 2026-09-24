import { describe, expect, it } from 'vitest'

import { chainOptions } from '../launch-dapp-options'

/**
 * The Launch dApp menu is built from one environment variable at build time.
 * When it is set, each chain links into its own segment of the dApp. When it
 * is not, both options are disabled — and the label says so in words meant
 * for a visitor, not in the name of the variable someone forgot to set.
 */
describe('the Launch dApp menu', () => {
  it('links each chain into its own segment of the dApp when the origin is configured', () => {
    const options = chainOptions('http://localhost:3001')
    expect(options.map((o) => o.href)).toEqual([
      'http://localhost:3001/arc/intents',
      'http://localhost:3001/stellar/intents',
    ])
    expect(options.map((o) => o.tagline)).toEqual(['Arc testnet · live', 'Stellar testnet · live'])
  })

  it('tolerates a trailing slash and surrounding whitespace on the origin', () => {
    const options = chainOptions(' https://app.example.com/ ')
    expect(options[0]?.href).toBe('https://app.example.com/arc/intents')
  })

  it('disables both chains with a label written for the visitor when the origin is unset', () => {
    for (const value of [undefined, '', '   ']) {
      const options = chainOptions(value)
      expect(options.every((o) => o.href === null)).toBe(true)
      expect(options.every((o) => o.tagline === 'Not available yet')).toBe(true)
      // The variable's name is a note for whoever deploys the site, not for a visitor.
      expect(JSON.stringify(options)).not.toContain('NEXT_PUBLIC')
    }
  })
})

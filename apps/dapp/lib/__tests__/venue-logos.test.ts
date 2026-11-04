import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { chainMarkFor } from '../chain-mark'
import { venues } from '../venues'

const PUBLIC = join(__dirname, '../../public/images')

/** Draws the Stellar mark itself, with no file: see `VenueLogo`. */
const DRAWN = new Set(['horizon'])

describe('Apps page logos', () => {
  it('has a logo file for every venue on every chain', () => {
    const missing = venues
      .filter((v) => !DRAWN.has(v.id))
      .filter((v) => !existsSync(join(PUBLIC, 'venues', `${v.id}.webp`)))
      .map((v) => `${v.family}/${v.id}`)
    expect(missing).toEqual([])
  })

  it('can draw the badge of every chain a venue names', () => {
    const chains = [...new Set(venues.flatMap((v) => v.chains))]
    const missing = chains.filter((chain) => {
      const mark = chainMarkFor(chain)
      return mark.kind === 'file' && !existsSync(join(PUBLIC, 'chains', `${mark.slug}.webp`))
    })
    expect(missing).toEqual([])
  })

  it('draws the chains that have an official mark', () => {
    expect(chainMarkFor('Sui')).toEqual({ kind: 'mark', chain: 'sui' })
    expect(chainMarkFor('Solana')).toEqual({ kind: 'mark', chain: 'solana' })
    expect(chainMarkFor('NEAR')).toEqual({ kind: 'mark', chain: 'near' })
    expect(chainMarkFor('Arc')).toEqual({ kind: 'mark', chain: 'arc' })
  })

  it('uses a file for a chain with no drawn mark', () => {
    expect(chainMarkFor('Ethereum')).toEqual({ kind: 'file', slug: 'ethereum' })
    expect(chainMarkFor('dYdX Chain')).toEqual({ kind: 'file', slug: 'dydx' })
  })
})

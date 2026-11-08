import { describe, expect, it } from 'vitest'

import { asVarial } from '../varial'

const kitModule = () => ({
  productId: 'freighter',
  productName: 'Freighter',
  productUrl: 'https://freighter.app',
})

describe('the wallet that was Freighter', () => {
  it('is named Varial and links to its own site', () => {
    const wallet = asVarial(kitModule())
    expect(wallet.productName).toBe('Varial')
    expect(wallet.productUrl).toBe('https://varialwallet.com')
  })

  it('keeps the id a connected wallet was saved under, so nobody is disconnected', () => {
    expect(asVarial(kitModule()).productId).toBe('freighter')
  })
})

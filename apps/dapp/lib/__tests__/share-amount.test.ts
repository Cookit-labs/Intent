import { describe, expect, it } from 'vitest'

import { findShare, shareOfCoin, sizeShare, unitsForShare } from '../chat/share-amount'

describe('findShare', () => {
  it.each([
    ['Swap 100% ofmy usdc to naira', 100, 'usdc'],
    ['swap 100 % of my USDC to naira', 100, 'USDC'],
    ['cash out all my usdc', 100, 'usdc'],
    ['send all of my SOL to an address', 100, 'SOL'],
    ['swap everything in my usdc to sol', 100, 'usdc'],
    ['deposit my entire usdc on aave', 100, 'usdc'],
    ['swap half my avax to usdc', 50, 'avax'],
    ['swap half of my avax to usdc', 50, 'avax'],
    ['swap 25% of my sui to usdc', 25, 'sui'],
    ['swap 12.5 percent of my near to usdc', 12.5, 'near'],
    ['swap a quarter of my sol to usdc', 25, 'sol'],
  ])('reads "%s"', (text, percent, word) => {
    expect(findShare(text)).toMatchObject({ percent, word })
  })

  it.each([
    'swap 5 usdc to sol',
    'what is all this',
    'swap 0% of my usdc',
    'swap 150% of my usdc to sol',
    'cash out',
  ])('finds nothing in "%s"', (text) => {
    expect(findShare(text)).toBeUndefined()
  })
})

describe('unitsForShare', () => {
  it('takes the share, rounded down to the places held, never more', () => {
    expect(unitsForShare('5.115078', 100)).toBe('5.115078')
    expect(unitsForShare('5.115078', 50)).toBe('2.557539')
    expect(unitsForShare('0.086874181223044652', 100)).toBe('0.086874181223044652')
    expect(unitsForShare('3', 33)).toBe('0.99')
    expect(unitsForShare('0.000001', 50)).toBeUndefined()
    expect(unitsForShare('0', 100)).toBeUndefined()
  })
})

describe('sizeShare', () => {
  const held = { USDC: '5.115078', AVAX: '0.086874181223044652' }

  it('writes the figure into the sentence and says how it was worked out', () => {
    expect(sizeShare('Swap 100% ofmy usdc to naira', held)).toEqual({
      text: 'Swap 5.115078 USDC to naira',
      line: '100% of your USDC is 5.115078 USDC.',
    })
    expect(sizeShare('swap half my avax to usdc', held)).toEqual({
      text: 'swap 0.043437090611522326 AVAX to usdc',
      line: '50% of your AVAX is 0.043437090611522326 AVAX.',
    })
  })

  it('refuses a share of a coin the wallet does not hold', () => {
    expect(sizeShare('swap all my sol to usdc', held)).toEqual({
      refusal:
        'Your wallet holds no SOL here, so there is nothing to take all of. Nothing was signed or sent.',
    })
  })

  it('leaves a sentence with no share alone', () => {
    expect(sizeShare('swap 5 usdc to sol', held)).toBeUndefined()
  })
})

describe('shareOfCoin', () => {
  it.each([
    ['all', 'all of my USDC'],
    ['All of it.', 'all of my USDC'],
    ['everything', 'all of my USDC'],
    ['half', 'half of my USDC'],
    ['50%', '50% of my USDC'],
    ['25 percent', '25 percent of my USDC'],
  ])('reads "%s" as a share of the coin asked about', (answer, read) => {
    expect(shareOfCoin(answer, 'USDC')).toBe(read)
    expect(findShare(shareOfCoin(answer, 'USDC'))).toBeDefined()
  })

  it('leaves any other answer as it was', () => {
    expect(shareOfCoin('5', 'USDC')).toBe('5')
    expect(shareOfCoin('swap 5 SOL to USDC', 'USDC')).toBe('swap 5 SOL to USDC')
  })
})

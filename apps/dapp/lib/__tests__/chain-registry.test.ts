import { describe, expect, it } from 'vitest'

import {
  CHAIN_DESCRIPTORS,
  CHAIN_ORDER,
  accountExplorerUrl,
  isChainSlug,
} from '@intent/config'

describe('chain registry', () => {
  it('accepts only known slugs', () => {
    expect(isChainSlug('arc')).toBe(true)
    expect(isChainSlug('stellar')).toBe(true)
    expect(isChainSlug('ethereum')).toBe(false)
    expect(isChainSlug('')).toBe(false)
  })

  it('describes both chains with the right family', () => {
    expect(CHAIN_DESCRIPTORS.arc.family).toBe('evm')
    expect(CHAIN_DESCRIPTORS.stellar.family).toBe('stellar')
  })

  it('lists every descriptor in the display order', () => {
    expect([...CHAIN_ORDER].sort()).toEqual(Object.keys(CHAIN_DESCRIPTORS).sort())
  })

  it('builds explorer URLs in each chain’s own format', () => {
    // The two explorers disagree on path shape, which is why callers must not
    // concatenate these by hand.
    expect(accountExplorerUrl('arc', '0xabc')).toContain('/address/0xabc')
    expect(accountExplorerUrl('stellar', 'GABC')).toContain('/account/GABC')
  })
})

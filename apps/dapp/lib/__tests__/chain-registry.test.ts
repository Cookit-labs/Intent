import { describe, expect, it } from 'vitest'

import {
  CHAIN_DESCRIPTORS,
  CHAIN_ORDER,
  CONNECT_CHAINS,
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

  it('describes each chain with the right family', () => {
    expect(CHAIN_DESCRIPTORS.arc.family).toBe('evm')
    expect(CHAIN_DESCRIPTORS.stellar.family).toBe('stellar')
    expect(CHAIN_DESCRIPTORS.solana.family).toBe('solana')
    expect(CHAIN_DESCRIPTORS.avalanche.family).toBe('evm')
    expect(CHAIN_DESCRIPTORS.sui.family).toBe('sui')
    expect(CHAIN_DESCRIPTORS.monad.family).toBe('evm')
    expect(CHAIN_DESCRIPTORS.near.family).toBe('near')
  })

  it('offers the six connectable chains in order, without Arc', () => {
    expect(CONNECT_CHAINS).toEqual(['stellar', 'solana', 'avalanche', 'sui', 'monad', 'near'])
  })

  it('lists every descriptor in the display order', () => {
    expect([...CHAIN_ORDER].sort()).toEqual(Object.keys(CHAIN_DESCRIPTORS).sort())
  })

  it('builds explorer URLs in each chain’s own format', () => {
    // The two explorers disagree on path shape, which is why callers must not
    // concatenate these by hand.
    expect(accountExplorerUrl('arc', '0xabc')).toContain('/address/0xabc')
    expect(accountExplorerUrl('stellar', 'GABC')).toContain('/account/GABC')
    expect(accountExplorerUrl('solana', 'abc')).toBe('https://solscan.io/account/abc')
    expect(accountExplorerUrl('avalanche', '0xabc')).toBe('https://snowtrace.io/address/0xabc')
    expect(accountExplorerUrl('sui', '0xabc')).toBe('https://suiscan.xyz/mainnet/account/0xabc')
    expect(accountExplorerUrl('monad', '0xabc')).toBe('https://monadvision.com/address/0xabc')
    expect(accountExplorerUrl('near', 'a.near')).toBe('https://nearblocks.io/address/a.near')
  })
})

import { describe, expect, it } from 'vitest'

import {
  BETA_NOTICE_POINTS,
  chainLabelWithBeta,
  isBetaChain,
  rememberBetaNotice,
  shouldShowBetaNotice,
} from '../chain-beta'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const held = new Map<string, string>()
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value)
    },
  }
}

const refusing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('which chains are in beta', () => {
  it.each(['solana', 'sui', 'near', 'avalanche', 'monad'] as const)('%s is', (slug) => {
    expect(isBetaChain(slug)).toBe(true)
  })

  it('Stellar is not', () => {
    expect(isBetaChain('stellar')).toBe(false)
  })

  it('says so to a screen reader, on the beta chains only', () => {
    expect(chainLabelWithBeta('monad', 'Monad mainnet')).toBe('Monad mainnet, beta')
    expect(chainLabelWithBeta('stellar', 'Stellar mainnet')).toBe('Stellar mainnet')
  })
})

describe('when the notice shows', () => {
  it('shows once per chain', () => {
    const storage = memoryStorage()
    expect(shouldShowBetaNotice('solana', storage)).toBe(true)
    rememberBetaNotice('solana', storage)
    expect(shouldShowBetaNotice('solana', storage)).toBe(false)
    expect(shouldShowBetaNotice('sui', storage)).toBe(true)
  })

  it('never shows on Stellar', () => {
    expect(shouldShowBetaNotice('stellar', memoryStorage())).toBe(false)
  })

  it('does not come back on every page when the browser refuses storage', () => {
    expect(shouldShowBetaNotice('solana', refusing)).toBe(false)
    expect(() => rememberBetaNotice('solana', refusing)).not.toThrow()
  })
})

describe('what the notice says', () => {
  it('warns that a transaction can fail and costs a fee', () => {
    expect(BETA_NOTICE_POINTS.join(' ')).toMatch(/transaction can fail.*network fee/)
  })
})

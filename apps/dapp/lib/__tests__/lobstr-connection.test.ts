import { describe, expect, it } from 'vitest'

import { LOBSTR_CONNECTION_KEY, lobstrNeedsConnection } from '../wallet/lobstr'

function storage(values: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (k) => values[k] ?? null }
}

describe('lobstrNeedsConnection', () => {
  it('asks LOBSTR for access when this tab has no connection key', () => {
    expect(lobstrNeedsConnection('lobstr', storage({}))).toBe(true)
    expect(lobstrNeedsConnection('lobstr', storage({ [LOBSTR_CONNECTION_KEY]: '' }))).toBe(true)
  })

  it('signs straight away when the key is there', () => {
    expect(lobstrNeedsConnection('lobstr', storage({ [LOBSTR_CONNECTION_KEY]: 'abc' }))).toBe(false)
  })

  it('treats unreadable storage as no key', () => {
    expect(lobstrNeedsConnection('lobstr', undefined)).toBe(true)
  })

  it('leaves other wallets alone', () => {
    expect(lobstrNeedsConnection('freighter', storage({}))).toBe(false)
    expect(lobstrNeedsConnection(undefined, storage({}))).toBe(false)
  })
})

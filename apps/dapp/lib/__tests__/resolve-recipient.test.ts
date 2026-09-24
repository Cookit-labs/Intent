import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { NameNotFound, UnsupportedRecipient } from '../names/errors'
import { recipientKind, resolveRecipient } from '../names/resolve'

/**
 * One resolver for the three ways a recipient can be written.
 *
 * The lookups themselves are injected. What is pinned here is the routing —
 * which form goes to which resolver — and the refusals: a contract or a
 * muxed account is a valid Stellar address that a classic payment cannot
 * reach, and refusing it by name beats a network error at submission.
 */

const G = Keypair.random().publicKey()
const C = StrKey.encodeContract(Buffer.alloc(32, 1))
const M = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 2))

describe('recipientKind', () => {
  it('tells the three forms apart', () => {
    expect(recipientKind(G)).toBe('address')
    expect(recipientKind('deon.xlm')).toBe('soroban-domain')
    expect(recipientKind('alice*lobstr.co')).toBe('federation')
  })

  it('reads a contract and a muxed account as addresses, so they are refused later by name', () => {
    expect(recipientKind(C)).toBe('address')
    expect(recipientKind(M)).toBe('address')
  })

  it('reads nothing into a word, a number or a URL', () => {
    expect(recipientKind('my friend')).toBeUndefined()
    expect(recipientKind('50')).toBeUndefined()
    expect(recipientKind('https://lobstr.co')).toBeUndefined()
  })
})

describe('resolveRecipient', () => {
  it('passes an account address through untouched', async () => {
    const resolved = await resolveRecipient(` ${G} `)
    expect(resolved).toEqual({ input: G, kind: 'address', address: G })
  })

  it('refuses a contract address, saying only accounts can be paid', async () => {
    await expect(resolveRecipient(C)).rejects.toThrow(UnsupportedRecipient)
    await expect(resolveRecipient(C)).rejects.toThrow(/account/)
  })

  it('refuses a muxed address', async () => {
    await expect(resolveRecipient(M)).rejects.toThrow(UnsupportedRecipient)
  })

  it('refuses something that is neither an address nor a name', async () => {
    await expect(resolveRecipient('my friend')).rejects.toThrow(UnsupportedRecipient)
    await expect(resolveRecipient('my friend')).rejects.toThrow(/not an address or a name/)
  })

  it('resolves a .xlm name on mainnet and says so', async () => {
    const asked: string[] = []
    const resolved = await resolveRecipient('Deon.xlm', {
      resolveDomain: async (name) => {
        asked.push(name)
        return { address: G, expiresAt: 1 }
      },
    })
    expect(asked).toEqual(['deon.xlm'])
    expect(resolved).toEqual({
      input: 'Deon.xlm',
      kind: 'soroban-domain',
      address: G,
      resolvedOn: 'stellar-mainnet',
    })
  })

  it('resolves a federation address and carries its memo', async () => {
    const resolved = await resolveRecipient('alice*lobstr.co', {
      resolveFederation: async () => ({ address: G, memo: '4242', memoType: 'id' }),
    })
    expect(resolved).toEqual({
      input: 'alice*lobstr.co',
      kind: 'federation',
      address: G,
      memo: '4242',
      memoType: 'id',
      resolvedOn: 'federation',
    })
  })

  it('carries no memo fields when federation named none', async () => {
    const resolved = await resolveRecipient('alice*lobstr.co', {
      resolveFederation: async () => ({ address: G }),
    })
    expect(resolved).toEqual({
      input: 'alice*lobstr.co',
      kind: 'federation',
      address: G,
      resolvedOn: 'federation',
    })
  })

  it('refuses a name that resolves to something other than an account', async () => {
    await expect(
      resolveRecipient('deon.xlm', {
        resolveDomain: async () => ({ address: C, expiresAt: 1 }),
      })
    ).rejects.toThrow(UnsupportedRecipient)
  })

  it('lets a not-found from the lookup through unchanged', async () => {
    await expect(
      resolveRecipient('deon.xlm', {
        resolveDomain: async () => {
          throw new NameNotFound('deon.xlm is not registered')
        },
      })
    ).rejects.toThrow(NameNotFound)
  })
})

import { describe, expect, it } from 'vitest'

import { venues } from '../venues'

/**
 * What the Apps page claims the app can do.
 *
 * The page listed venues as links, which told a user nothing about whether an
 * intent could actually route through one. Soroswap and Phoenix appeared
 * identically, though the app executes on the first and has never spoken to
 * the second.
 *
 * These tests exist because the claim is easy to get wrong in the direction
 * that matters: marking something `executes` when no builder reaches it is a
 * promise the app cannot keep, and a user would only discover it at signing.
 */

const byId = (id: string) => venues.find((v) => v.id === id)

describe('integration status is claimed accurately', () => {
  it('marks the Stellar DEX as executing', () => {
    // Path payments through Horizon: the original execution path.
    expect(byId('stellarx')?.integration).toBe('executes')
  })

  it('marks Soroswap as executing', () => {
    // Reached through the Soroban builder, verified against the live router.
    expect(byId('soroswap')?.integration).toBe('executes')
  })

  it('marks Etherfuse as executing', () => {
    // Tokenized treasuries settle through the same path payments as any other
    // classic asset, so no new execution path was needed.
    expect(byId('etherfuse')?.integration).toBe('executes')
  })

  it('marks Blend as quoting only', () => {
    // Its testnet pools are real, but nothing signs a supply yet — and its
    // USDC is a third distinct issuer from Circle's and Soroswap's.
    expect(byId('blend')?.integration).toBe('quotes')
  })

  it('leaves an unintegrated venue unclaimed', () => {
    // Phoenix is a real Stellar DEX the app has never called.
    expect(byId('phoenix')?.integration ?? 'listed').toBe('listed')
  })

  it('gives every integrated venue a capability line', () => {
    // A badge saying "executes" with no explanation of what it executes is
    // decoration. The sentence is the useful half.
    for (const v of venues) {
      if (v.integration === 'executes' || v.integration === 'quotes') {
        expect(v.capability, `${v.id} claims ${v.integration} but says nothing`).toBeTruthy()
      }
    }
  })

  it('does not claim capability for something merely listed', () => {
    for (const v of venues) {
      if ((v.integration ?? 'listed') === 'listed') {
        expect(v.capability, `${v.id} is only listed but claims a capability`).toBeUndefined()
      }
    }
  })
})

describe('the integrated venues are on the right chain', () => {
  it('keeps every executing venue on Stellar', () => {
    // Execution is Stellar-only today. An EVM venue marked executable would
    // send a user to a confirm screen that cannot build anything.
    for (const v of venues) {
      if (v.integration === 'executes') {
        expect(v.family, `${v.id} claims execution but is ${v.family}`).toBe('stellar')
      }
    }
  })
})

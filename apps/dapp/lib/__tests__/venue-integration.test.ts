import { describe, expect, it } from 'vitest'

import { venues } from '../venues'

/**
 * What the Apps page claims the app can do.
 *
 * The page listed venues as links, which told a user nothing about whether an
 * intent could actually route through one. Soroswap and Aquarius appear
 * identically, though the app can sign a swap on the first and only price one
 * on the second.
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

  it('marks Blend as executing, now that a supply can be signed', () => {
    // XLM only. Its USDC is a third distinct issuer from Circle's and
    // Soroswap's, which is why a lend target is read from the pool's own
    // reserve list rather than derived from a ticker.
    expect(byId('blend')?.integration).toBe('executes')
  })

  it('does not claim Blend can borrow', () => {
    // Deliberate scope, not an omission. A supply-only position cannot be
    // liquidated, and that stays true only while nothing here opens a
    // liability — so the capability text must not imply otherwise.
    const capability = byId('blend')?.capability ?? ''
    expect(capability).toMatch(/borrow/i)
    expect(capability).toMatch(/out of scope/i)
  })

  it('lists the Soroswap aggregator as its own venue, in the aggregator category', () => {
    // A different product from the Soroswap AMM above: it splits a swap
    // across venues through a hosted route-finder, and several of its routes
    // originate from routers already listed here on their own. Its card must
    // say so rather than fold into the AMM's.
    const aggregator = byId('soroswap-aggregator')
    expect(aggregator?.category).toBe('aggregator')
    expect(aggregator?.family).toBe('stellar')
    expect(aggregator?.integration).toBe('executes')
    // The gate is named: without a key the venue quotes nothing, and a card
    // that promised execution unconditionally would be wrong for every
    // deployment that has not registered one.
    expect(aggregator?.capability).toMatch(/SOROSWAP_API_KEY/)
  })

  it('marks Aquarius as executing, now that a swap can be signed', () => {
    // Was 'listed' while the builder existed but the submit route re-checked
    // its envelope with Soroswap's source-only assertion, which never read
    // the recipient argument the router pays. Now every Aquarius envelope is
    // re-asserted with its own check before broadcast, and a swap has been
    // signed and settled on testnet against the live router.
    expect(byId('aquarius')?.integration).toBe('executes')
  })

  it('lists no Stellar venue the app cannot reach at all', () => {
    // A venue earns its place by being reachable — quotable at least, and
    // ideally signable. Phoenix and Lumenswap were neither: Phoenix's testnet
    // router resolves to a contract that does not exist, so a route through it
    // would be priced and then fail at signing, and Lumenswap has been
    // unmaintained since 2024 with an API that no longer answers. Listing
    // either one offered the agents a venue no intent could ever use.
    const gone = ['phoenix', 'lumenswap']
    for (const id of gone) {
      expect(byId(id)).toBeUndefined()
    }
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

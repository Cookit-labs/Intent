import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { readSimulatedOpen } from '../perps/simulate-order'

/**
 * Reading the position the contract would open, from a simulation.
 *
 * The gateway's prepare returns the envelope and nothing about the position
 * it opens. The contract's `open_position` returns the `Position` it created
 * — entry price and liquidation price included — so simulating the prepared
 * envelope against the RPC yields both, computed by the contract itself at
 * the current oracle price. Field names are the Rust struct's, as
 * `scValToNative` renders them.
 */

const ACCOUNT = 'GDA4JVVUE6CTF7FEGOFMKA3YE4E5J7SAAK7RACZLNIMXYF24OLLR3KZO'

function position(over: Record<string, unknown> = {}): xdr.ScVal {
  const fields: Record<string, xdr.ScVal> = {
    id: nativeToScVal(BigInt(22499), { type: 'u64' }),
    trader: new Address(ACCOUNT).toScVal(),
    asset: nativeToScVal('XLM', { type: 'symbol' }),
    collateral: nativeToScVal(BigInt('500000000'), { type: 'i128' }),
    size: nativeToScVal(BigInt('5000000000'), { type: 'i128' }),
    entry_price: nativeToScVal(BigInt('2132453'), { type: 'i128' }),
    direction: nativeToScVal(0, { type: 'u32' }),
    leverage: nativeToScVal(10, { type: 'u32' }),
    liquidation_price: nativeToScVal(BigInt('1972519'), { type: 'i128' }),
    opened_at: nativeToScVal(BigInt(1790167527), { type: 'u64' }),
  }
  for (const [k, v] of Object.entries(over)) fields[k] = v as xdr.ScVal
  // Built as an explicit map with symbol keys, which is how the contract's
  // struct arrives and how `scValToNative` renders it back into an object.
  return xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
    )
  )
}

describe('readSimulatedOpen', () => {
  it('reads entry and liquidation price from the returned Position', async () => {
    const out = await readSimulatedOpen('AAAA', async () => ({ ok: true, retval: position() }))
    expect(out).toEqual({
      ok: true,
      position: {
        entryPrice: '2132453',
        liquidationPrice: '1972519',
        size: '5000000000',
        collateral: '500000000',
      },
    })
  })

  it('passes the simulation failure through as the reason', async () => {
    const out = await readSimulatedOpen('AAAA', async () => ({
      ok: false,
      error: 'HostError: Error(Contract, #7)',
    }))
    expect(out).toEqual({ ok: false, reason: 'HostError: Error(Contract, #7)' })
  })

  it('reports a return value that is not a position', async () => {
    const out = await readSimulatedOpen('AAAA', async () => ({
      ok: true,
      retval: nativeToScVal(BigInt(1), { type: 'i128' }),
    }))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/position/)
  })

  it('reports a simulation that returned nothing', async () => {
    const out = await readSimulatedOpen('AAAA', async () => ({ ok: true }))
    expect(out.ok).toBe(false)
  })

  it('does not throw when the simulator does', async () => {
    const out = await readSimulatedOpen('AAAA', async () => {
      throw new Error('rpc down')
    })
    expect(out).toEqual({ ok: false, reason: 'rpc down' })
  })
})

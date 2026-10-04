import { describe, expect, it } from 'vitest'

import { parseActivity, parseHoldings } from '../wallet/account-activity'

const ME = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H'
const OTHER = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ'
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('parseHoldings', () => {
  it('puts XLM first, names issued assets by code, and drops empty ones', () => {
    const holdings = parseHoldings([
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        balance: '12.5000000',
      },
      { asset_type: 'native', balance: '22133.4800000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'CETES',
        asset_issuer: ISSUER,
        balance: '0.0000000',
      },
      { asset_type: 'liquidity_pool_shares', balance: '5.0000000' },
    ])
    expect(holdings.map((h) => h.code)).toEqual(['XLM', 'USDC'])
    expect(holdings[0]).toMatchObject({ native: true, balance: '22133.48' })
    expect(holdings[1]).toMatchObject({ native: false, issuer: ISSUER, balance: '12.5' })
  })

  it('still shows XLM at zero for an account that holds nothing else', () => {
    expect(parseHoldings([{ asset_type: 'native', balance: '0.0000000' }])).toEqual([
      { code: 'XLM', native: true, balance: '0' },
    ])
  })
})

describe('parseActivity', () => {
  const base = { transaction_hash: 'h1', created_at: '2026-10-01T10:00:00Z' }

  it('reads a payment to the account as received, and from it as sent', () => {
    const [inc, out] = parseActivity(
      [
        {
          ...base,
          id: '1',
          type: 'payment',
          from: OTHER,
          to: ME,
          amount: '5.0000000',
          asset_type: 'native',
        },
        {
          ...base,
          id: '2',
          type: 'payment',
          from: ME,
          to: OTHER,
          amount: '1.2500000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
        },
      ],
      ME
    )
    expect(inc).toMatchObject({ kind: 'received', amount: '5', code: 'XLM', counterparty: OTHER })
    expect(out).toMatchObject({ kind: 'sent', amount: '1.25', code: 'USDC', counterparty: OTHER })
  })

  it('reads a path payment to itself as a swap, with both sides', () => {
    const [swap] = parseActivity(
      [
        {
          ...base,
          id: '3',
          type: 'path_payment_strict_send',
          from: ME,
          to: ME,
          amount: '6.2140000',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          source_amount: '50.0000000',
          source_asset_type: 'native',
        },
      ],
      ME
    )
    expect(swap).toMatchObject({
      kind: 'swap',
      amount: '6.214',
      code: 'USDC',
      sourceAmount: '50',
      sourceCode: 'XLM',
    })
  })

  it('reads create_account for this account as funding', () => {
    const [funded] = parseActivity(
      [
        {
          ...base,
          id: '4',
          type: 'create_account',
          funder: OTHER,
          account: ME,
          starting_balance: '10.0000000',
        },
      ],
      ME
    )
    expect(funded).toMatchObject({
      kind: 'received',
      amount: '10',
      code: 'XLM',
      counterparty: OTHER,
    })
  })

  it('keeps the hash and time, and skips records it does not understand', () => {
    const out = parseActivity(
      [
        {
          ...base,
          id: '5',
          type: 'payment',
          from: OTHER,
          to: ME,
          amount: '1.0000000',
          asset_type: 'native',
        },
        { ...base, id: '6', type: 'set_options' },
      ],
      ME
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ hash: 'h1', at: '2026-10-01T10:00:00Z' })
  })
})

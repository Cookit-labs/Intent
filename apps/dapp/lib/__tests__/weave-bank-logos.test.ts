import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NIGERIAN_BANKS } from '../naira/banks'
import { WEAVE_BANK_LOGOS } from '../weave/bank-logos'
import { withBankLogos } from '../weave/cashout-view'

const DIR = join(process.cwd(), 'public', 'bank-logos', 'weave')

describe('bank logos', () => {
  const entries = Object.entries(WEAVE_BANK_LOGOS).flatMap(([currency, banks]) =>
    Object.entries(banks).map(([name, slug]) => ({ currency, name, slug }))
  )

  it('has a list for every country a payout can go to', () => {
    expect(Object.keys(WEAVE_BANK_LOGOS).sort()).toEqual(['KES', 'NGN', 'TZS', 'UGX'])
  })

  it('has a file for every entry', () => {
    const missing = entries.filter(({ slug }) => !existsSync(join(DIR, `${slug}.webp`)))
    expect(missing).toEqual([])
  })

  it('keeps no file that nothing uses', () => {
    const used = new Set(entries.map(({ slug }) => `${slug}.webp`))
    expect(readdirSync(DIR).filter((file) => !used.has(file))).toEqual([])
  })

  it('keeps each file small, since a picker loads many at once', () => {
    const large = readdirSync(DIR).filter((file) => statSync(join(DIR, file)).size > 30_000)
    expect(large).toEqual([])
  })

  it.each([
    ['KES', 'M-PESA'],
    ['KES', 'Equity Bank'],
    ['UGX', 'MTN Mobile Money'],
    ['UGX', 'Airtel Money'],
    ['TZS', 'CRDB Bank PLC'],
    ['TZS', 'Tigo Pesa'],
    ['NGN', 'OPay'],
    ['NGN', 'PalmPay'],
    ['NGN', 'Access Bank'],
  ])('shows a logo for %s %s, which many people will pick', (currency, name) => {
    const [bank] = withBankLogos(
      [{ code: 'X', name, type: 'bank' }],
      currency === 'NGN' ? NIGERIAN_BANKS : [],
      currency
    )
    expect(bank?.logo).toBeDefined()
  })
})

import { describe, expect, it } from 'vitest'

import {
  accountHint,
  accountMismatch,
  afterSubmit,
  afterWallet,
  canSign,
  CASHOUT_STATUSES,
  cleanIdentifier,
  depositConfirmed,
  depositExplorerUrl,
  cashoutChoices,
  explorerName,
  formatPayout,
  formatUsdc,
  isLocked,
  isRealHolderName,
  isValidAmount,
  nextAttempt,
  orderPhase,
  shouldPoll,
  awaitsPaidAmount,
  statusText,
  unsupportedCurrencyReply,
  unsupportedTokenReply,
  withBankLogos,
  type CashoutOrderView,
} from '../weave/cashout-view'

const order = (over: Partial<CashoutOrderView> = {}): CashoutOrderView => ({
  id: 'o1',
  chain: 'near',
  status: 'waiting',
  currency: 'KES',
  amount: '25',
  estimatedDest: '3200',
  institutionName: 'M-Pesa',
  accountName: 'Jane',
  accountMask: '***678',
  depositAddress: 'deposit',
  ...over,
})

describe('formatting', () => {
  it('groups USDC without changing its digits', () => {
    expect(formatUsdc('1000.123456')).toBe('1,000.123456')
    expect(formatUsdc('25')).toBe('25')
    expect(formatUsdc('1250000')).toBe('1,250,000')
  })

  it('writes naira the way the naira form does', () => {
    expect(formatPayout('4121.25', 'NGN')).toBe('₦4,121.25')
    expect(formatPayout(4121, 'NGN')).toBe('₦4,121.00')
  })

  it('writes the other currencies with their own marks', () => {
    expect(formatPayout('3200.456', 'KES')).toBe('KSh 3,200.46')
    expect(formatPayout(100, 'UGX')).toBe('USh 100.00')
    expect(formatPayout(100, 'TZS')).toBe('TSh 100.00')
    expect(formatPayout(100, 'XYZ')).toBe('100.00 XYZ')
  })

  it('does not take a bare OK for a holder’s name', () => {
    expect(isRealHolderName('OK')).toBe(false)
    expect(isRealHolderName(' ok ')).toBe(false)
    expect(isRealHolderName('JANE ADEYEMI')).toBe(true)
  })

  it('names each chain’s explorer', () => {
    expect(explorerName('stellar')).toBe('Stellar Expert')
    expect(explorerName('sui')).toBe('Suiscan')
  })
})

describe('cashoutChoices', () => {
  const kes = { code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', country: 'Kenya' }
  const ngn = { code: 'NGN', name: 'Nigerian naira', symbol: '₦', country: 'Nigeria' }

  it('takes what Weave offers on a chain', () => {
    expect(cashoutChoices('sui', [ngn, kes])).toEqual([ngn, kes])
    expect(cashoutChoices('sui', [])).toEqual([])
  })

  it('offers naira first on stellar, which Linq pays even with Weave off', () => {
    expect(cashoutChoices('stellar', [kes]).map((c) => c.code)).toEqual(['NGN', 'KES'])
    expect(cashoutChoices('stellar', []).map((c) => c.code)).toEqual(['NGN'])
  })
})

describe('withBankLogos', () => {
  const list = [
    { code: 'ZEN', name: 'Zenith Bank', type: 'bank' as const },
    { code: 'ABNGNGLA', name: 'ACCESS BANK', type: 'bank' as const },
    { code: 'NEW', name: 'New Bank', type: 'bank' as const },
  ]
  const known = [
    { code: '044', name: 'Access Bank', logo: '/access.png' },
    { code: '057', name: 'Zenith Bank' },
  ]

  it('sorts A to Z and keeps the provider’s codes', () => {
    expect(withBankLogos(list, known, 'XXX').map((b) => b.code)).toEqual(['ABNGNGLA', 'NEW', 'ZEN'])
  })

  it('takes the logo from the same bank, however its name is written', () => {
    const banks = withBankLogos(list, known, 'XXX')
    expect(banks[0]).toEqual({ code: 'ABNGNGLA', name: 'ACCESS BANK', logo: '/access.png' })
  })

  it('leaves a bank with no known logo without one', () => {
    const banks = withBankLogos(list, known, 'XXX')
    expect(banks[1]).toEqual({ code: 'NEW', name: 'New Bank' })
    expect(banks[2]).toEqual({ code: 'ZEN', name: 'Zenith Bank' })
  })

  it('takes the logo held for that country', () => {
    const [bank] = withBankLogos([{ code: 'MP', name: 'M-PESA', type: 'mobile_money' }], [], 'KES')
    expect(bank?.logo).toMatch(/^\/bank-logos\/weave\/.+\.webp$/)
    const [elsewhere] = withBankLogos(
      [{ code: 'MP', name: 'M-PESA', type: 'mobile_money' }],
      [],
      'UGX'
    )
    expect(elsewhere?.logo).toBeUndefined()
  })

  it('keeps the naira form’s own logo for a bank it already has', () => {
    const [bank] = withBankLogos(
      [{ code: 'KU', name: 'Kuda Microfinance Bank', type: 'bank' }],
      [{ name: 'Kuda Microfinance Bank', logo: '/bank-logos/090267.png' }],
      'NGN'
    )
    expect(bank?.logo).toBe('/bank-logos/090267.png')
  })
})

describe('isValidAmount', () => {
  it.each(['25', '0.5', '25.123456'])('takes %s', (a) => expect(isValidAmount(a)).toBe(true))
  it.each(['', '0', '0.00', '.', '1.', '1.1234567', 'abc', '-1'])('refuses %j', (a) =>
    expect(isValidAmount(a)).toBe(false)
  )
})

describe('status', () => {
  it('has a sentence for each status', () => {
    for (const status of CASHOUT_STATUSES) expect(statusText(status).length).toBeGreaterThan(10)
  })

  it('tells a failed payout where the money goes', () => {
    expect(statusText('failed')).toMatch(/due back to your connected wallet/)
  })

  it.each(['failed', 'expired'] as const)('promises no refund it has not seen on %s', (status) => {
    expect(statusText(status)).toMatch(/none has run in this app yet/)
  })

  it('gives a refund as what Weave says, and asks the person to check it', () => {
    expect(statusText('refunded')).toMatch(/Weave says .* check that it arrived/)
  })

  it.each(['waiting', 'processing'] as const)('keeps polling while %s', (status) => {
    expect(shouldPoll(status)).toBe(true)
  })

  it.each(['paid', 'failed', 'expired', 'refunded'] as const)('stops polling once %s', (status) => {
    expect(shouldPoll(status)).toBe(false)
  })
})

describe('accountHint', () => {
  it('asks a bank for an account number', () => {
    expect(accountHint('bank', 'KES')).toMatchObject({
      label: 'Account number',
      inputMode: 'numeric',
    })
  })

  it('asks mobile money for a phone number with the right country code', () => {
    expect(accountHint('mobile_money', 'KES')).toMatchObject({
      label: 'Phone number',
      inputMode: 'tel',
      placeholder: '254712345678',
    })
    expect(accountHint('mobile_money', 'UGX').placeholder).toMatch(/^256/)
    expect(accountHint('mobile_money', 'TZS').placeholder).toMatch(/^255/)
  })

  it('asks generally until an institution is picked', () => {
    expect(accountHint(undefined, 'KES').label).toBe('Account or phone number')
  })

  it('removes what people type between digits', () => {
    expect(cleanIdentifier(' 0712 345-678 ')).toBe('0712345678')
    expect(cleanIdentifier('+254 712 345678')).toBe('+254712345678')
  })
})

describe('afterWallet', () => {
  it('moves a signature on to submit', () => {
    const signed = { family: 'solana', signedTransaction: 'x' } as const
    expect(afterWallet({ ok: true, signed }, 'solana')).toEqual({ next: 'submit', signed })
  })

  it.each(['solana', 'sui', 'stellar'] as const)(
    'returns to review when declined on %s, since nothing can have gone out',
    (family) => {
      expect(afterWallet({ ok: false, reason: 'rejected' }, family)).toEqual({ next: 'review' })
    }
  )

  it.each(['solana', 'sui', 'stellar'] as const)(
    'calls a wallet error on %s a failure, since only this app sends those',
    (family) => {
      expect(afterWallet({ ok: false, reason: 'wallet_error', detail: 'no' }, family)).toEqual({
        next: 'failed',
        error: 'no',
      })
    }
  )

  it.each(['near', 'evm'] as const)(
    'asks for a check after a wallet error on %s, since that wallet sends for itself',
    (family) => {
      const result = afterWallet({ ok: false, reason: 'wallet_error', detail: 'no' }, family)
      expect(result).toEqual({ next: 'check' })
    }
  )

  it.each(['near', 'evm'] as const)(
    'asks for a check after a decline on %s, since a dropped connection can read as one',
    (family) => {
      expect(afterWallet({ ok: false, reason: 'rejected' }, family)).toEqual({ next: 'check' })
    }
  )
})

describe('accountMismatch', () => {
  it('passes the wallet the order was made for', () => {
    expect(accountMismatch('alice.near', 'alice.near')).toBeUndefined()
  })

  it('reads EVM addresses without regard to case', () => {
    expect(accountMismatch('0xABCDEF1234', '0xabcdef1234')).toBeUndefined()
  })

  it('keeps case on chains where it is part of the address', () => {
    expect(accountMismatch('GABCDEF123456', 'gabcdef123456')).toMatch(/Switch back/)
  })

  it('asks for the other wallet by a short name when they differ', () => {
    const message = accountMismatch('0x1111111111222222', '0x3333333333444444')
    expect(message).toMatch(/Switch back/)
    expect(message).toMatch(/0x3333…4444/)
  })

  it('asks the same when no wallet is connected', () => {
    expect(accountMismatch(undefined, 'alice.near')).toMatch(/alice\.near/)
  })
})

describe('afterSubmit', () => {
  it('follows a landed deposit', () => {
    expect(afterSubmit({ ok: true, hash: 'h', explorerUrl: 'u' }, 'solana')).toEqual({
      next: 'tracking',
      hash: 'h',
      explorerUrl: 'u',
    })
  })

  it('calls an unknown outcome pending', () => {
    const result = afterSubmit({ ok: false, error: 'unsure', pending: true }, 'solana')
    expect(result).toMatchObject({ next: 'pending' })
  })

  it('takes a clean refusal as a failure where this app does the sending', () => {
    expect(afterSubmit({ ok: false, error: 'It was refused.' }, 'solana')).toEqual({
      next: 'failed',
      error: 'It was refused.',
    })
  })

  it('does not show a bare error code as the reason', () => {
    expect(afterSubmit({ ok: false, code: 'not_found', error: 'not_found' }, 'solana')).toEqual({
      next: 'failed',
      error: 'The deposit did not go through.',
    })
  })

  it('never calls it a failure where the wallet already sent', () => {
    expect(afterSubmit({ ok: false, error: 'refused' }, 'near').next).toBe('pending')
    expect(afterSubmit({ ok: false, error: 'refused' }, 'evm').next).toBe('pending')
  })

  it.each([undefined, null, {}, { error: 'server_error' }, 'oops'])(
    'treats the unreadable answer %j as pending',
    (answer) => {
      expect(afterSubmit(answer, 'solana').next).toBe('pending')
    }
  )
})

describe('nextAttempt', () => {
  const mint = (): string => 'new'

  it('mints a key the first time', () => {
    expect(nextAttempt(null, 'a', mint)).toEqual({ fingerprint: 'a', key: 'new' })
  })

  it('reuses the key on a retry of the same request', () => {
    const held = { fingerprint: 'a', key: 'old' }
    expect(nextAttempt(held, 'a', mint)).toBe(held)
  })

  it('mints a new key when the request changed', () => {
    expect(nextAttempt({ fingerprint: 'a', key: 'old' }, 'b', mint).key).toBe('new')
  })
})

describe('what may be offered', () => {
  it('reviews only an order still waiting with no deposit', () => {
    expect(orderPhase(order())).toBe('review')
    expect(orderPhase(order({ depositHash: 'h' }))).toBe('tracking')
    expect(orderPhase(order({ status: 'processing' }))).toBe('tracking')
    expect(orderPhase(order({ status: 'paid' }))).toBe('tracking')
    expect(orderPhase(order({ status: 'expired' }))).toBe('tracking')
  })

  it('offers signing only in review of an unpaid order', () => {
    expect(canSign('review', order())).toBe(true)
    expect(canSign('review', order({ depositHash: 'h' }))).toBe(false)
    expect(canSign('review', order({ status: 'processing' }))).toBe(false)
    expect(canSign('review', undefined)).toBe(false)
    for (const phase of [
      'signing',
      'submitting',
      'tracking',
      'pending',
      'failed',
      'check',
    ] as const) {
      expect(canSign(phase, order())).toBe(false)
    }
  })

  it('notices a deposit once the order shows one', () => {
    expect(depositConfirmed(order())).toBe(false)
    expect(depositConfirmed(order({ depositHash: 'h' }))).toBe(true)
    expect(depositConfirmed(order({ status: 'processing' }))).toBe(true)
    expect(depositConfirmed(order({ status: 'expired' }))).toBe(true)
  })

  it('locks the card once money may be moving, until the order ends', () => {
    expect(isLocked('form', undefined)).toBe(false)
    expect(isLocked('review', order())).toBe(false)
    expect(isLocked('failed', order())).toBe(false)
    expect(isLocked('signing', order())).toBe(true)
    expect(isLocked('submitting', order())).toBe(true)
    expect(isLocked('pending', order())).toBe(true)
    expect(isLocked('check', order())).toBe(true)
    expect(isLocked('check', order({ status: 'expired' }))).toBe(false)
    expect(isLocked('tracking', order({ status: 'processing' }))).toBe(true)
    expect(isLocked('tracking', order({ status: 'paid' }))).toBe(false)
    expect(isLocked('pending', order({ status: 'refunded' }))).toBe(false)
  })
})

describe('words', () => {
  it('says a token must be swapped to USDC first', () => {
    const reply = unsupportedTokenReply('SOL', 'solana')
    expect(reply).toMatch(/USDC/)
    expect(reply).toMatch(/swap/i)
    expect(reply).toMatch(/SOL/)
  })

  it('lists what can be paid out, and promises nothing else', () => {
    const reply = unsupportedCurrencyReply('BRL', [
      { code: 'KES', name: 'Kenyan shilling', symbol: 'KSh', country: 'Kenya' },
      { code: 'UGX', name: 'Ugandan shilling', symbol: 'USh', country: 'Uganda' },
    ])
    expect(reply).toMatch(/BRL/)
    expect(reply).toMatch(/Kenyan shilling \(KES\)/)
    expect(reply).toMatch(/Ugandan shilling \(UGX\)/)
    expect(reply).not.toMatch(/soon|coming|later|yet/i)
  })

  it('says plainly when there are no options', () => {
    expect(unsupportedCurrencyReply('BRL', [])).toBe("Cash-outs aren't available right now.")
  })

  it('links a deposit to the explorer of its chain', () => {
    expect(depositExplorerUrl('near', 'h')).toBe('https://nearblocks.io/txns/h')
    expect(depositExplorerUrl('solana', 'h')).toBe('https://solscan.io/tx/h')
    expect(depositExplorerUrl('sui', 'h')).toBe('https://suiscan.xyz/mainnet/tx/h')
    expect(depositExplorerUrl('avalanche', 'h')).toBe('https://snowtrace.io/tx/h')
    expect(depositExplorerUrl('stellar', 'h')).toBe('https://stellar.expert/explorer/public/tx/h')
  })
})

describe('awaitsPaidAmount', () => {
  it('is true only for a paid order whose amount Weave has not given yet', () => {
    expect(awaitsPaidAmount({ status: 'paid' })).toBe(true)
    expect(awaitsPaidAmount({ status: 'paid', paidDest: '877.08' })).toBe(false)
    expect(awaitsPaidAmount({ status: 'processing' })).toBe(false)
    expect(awaitsPaidAmount({ status: 'failed' })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'

import { chainBalanceReply } from '../chains/balance-reply'
import { readBalanceList } from '../chat/balance-lines'
import { balanceMessage } from '../chat/orchestrate-copy'

const NL = String.fromCharCode(10)

describe('readBalanceList', () => {
  it('reads the Stellar reply as one row per asset', () => {
    const text = balanceMessage({
      exists: true,
      xlm: '2.3909029',
      trustlines: { USDC: { balance: '0.0025383' } },
    } as unknown as Parameters<typeof balanceMessage>[0])
    expect(readBalanceList(text)).toEqual({
      rows: [
        { amount: '2.3909029', symbol: 'XLM' },
        { amount: '0.0025383', symbol: 'USDC' },
      ],
      after: [],
    })
  })

  it('reads amounts with thousands separators', () => {
    const text = ['Your wallet holds:', '• 12,500.5 XLM'].join(NL)
    expect(readBalanceList(text)?.rows).toEqual([{ amount: '12,500.5', symbol: 'XLM' }])
  })

  it('keeps an unlisted token apart from its id, and the lines after the list', () => {
    const text = chainBalanceReply(
      {
        complete: false,
        knownOnly: true,
        tokens: [
          { id: 'native', symbol: 'SOL', amount: '0.5', native: true, listed: true },
          { id: 'EPjF', symbol: 'USDC', amount: '3', native: false, listed: true },
          {
            id: 'So1aNaMintAddressThatIsLong',
            symbol: 'BONK',
            amount: '100',
            native: false,
            listed: false,
          },
        ],
      } as unknown as Parameters<typeof chainBalanceReply>[0],
      'Solana'
    )
    expect(readBalanceList(text)).toEqual({
      rows: [
        { amount: '0.5', symbol: 'SOL' },
        { amount: '3', symbol: 'USDC' },
        { amount: '100', symbol: 'BONK', id: 'So1a…Long' },
      ],
      after: ['Only tokens Intent knows on Solana are shown.'],
    })
  })

  it('leaves any other message alone', () => {
    expect(readBalanceList('Intent does not rank platforms.')).toBeUndefined()
    expect(readBalanceList('Your wallet holds:')).toBeUndefined()
    expect(readBalanceList(['Your wallet holds:', 'nothing I can read'].join(NL))).toBeUndefined()
  })
})

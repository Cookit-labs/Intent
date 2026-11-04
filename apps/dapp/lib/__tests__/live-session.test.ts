import { describe, expect, it } from 'vitest'

import {
  appendLiveTurn,
  chainOutcomeSentence,
  clearLiveSession,
  liveSessionKey,
  loadLiveSession,
  ownedTurns,
  showChatOnPath,
  type LiveTurn,
} from '../chat/live-session'

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

const turn = (text: string, at = 1): LiveTurn => ({ role: 'user', text, at })

describe('who a saved chat belongs to', () => {
  it('never shows one account the turns of another', () => {
    const storage = memoryStorage()
    appendLiveTurn(storage, 'solana', 'alice', turn('mine'))
    expect(loadLiveSession(storage, 'solana', 'bob')).toEqual([])
    expect(loadLiveSession(storage, 'solana', 'alice')).toEqual([turn('mine')])
  })

  it('never shows one chain the turns of another', () => {
    const storage = memoryStorage()
    appendLiveTurn(storage, 'solana', 'alice', turn('mine'))
    expect(loadLiveSession(storage, 'sui', 'alice')).toEqual([])
  })

  it('gives each chain and account its own key', () => {
    expect(liveSessionKey('solana', 'alice')).not.toBe(liveSessionKey('solana', 'bob'))
    expect(liveSessionKey('solana', 'alice')).not.toBe(liveSessionKey('sui', 'alice'))
  })

  it('clears one account and leaves the others', () => {
    const storage = memoryStorage()
    appendLiveTurn(storage, 'solana', 'alice', turn('a'))
    appendLiveTurn(storage, 'solana', 'bob', turn('b'))
    clearLiveSession(storage, 'solana', 'alice')
    expect(loadLiveSession(storage, 'solana', 'alice')).toEqual([])
    expect(loadLiveSession(storage, 'solana', 'bob')).toEqual([turn('b')])
  })

  it('hides what was read for one wallet once another is connected', () => {
    const saved = { account: 'alice', turns: [turn('mine')] }
    expect(ownedTurns(saved, 'alice')).toEqual([turn('mine')])
    expect(ownedTurns(saved, 'bob')).toEqual([])
    expect(ownedTurns(saved, undefined)).toEqual([])
    expect(ownedTurns(null, 'alice')).toEqual([])
  })
})

describe('how much is kept', () => {
  it('keeps the newest 200, in order', () => {
    const storage = memoryStorage()
    for (let i = 0; i < 205; i += 1) appendLiveTurn(storage, 'solana', 'a', turn(`t${i}`, i))
    const turns = loadLiveSession(storage, 'solana', 'a')
    expect(turns).toHaveLength(200)
    expect(turns[0]?.text).toBe('t5')
    expect(turns[199]?.text).toBe('t204')
  })

  it('caps on load as well, for a list written longer than that', () => {
    const storage = memoryStorage()
    const long = Array.from({ length: 250 }, (_, i) => turn(`t${i}`, i))
    storage.setItem(liveSessionKey('solana', 'a'), JSON.stringify(long))
    const turns = loadLiveSession(storage, 'solana', 'a')
    expect(turns).toHaveLength(200)
    expect(turns[0]?.text).toBe('t50')
  })
})

describe('storage that does not cooperate', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('full')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }

  it('reads nothing and never throws', () => {
    expect(loadLiveSession(broken, 'solana', 'a')).toEqual([])
    expect(loadLiveSession(undefined, 'solana', 'a')).toEqual([])
  })

  it('writes nothing and never throws', () => {
    expect(() => appendLiveTurn(broken, 'solana', 'a', turn('x'))).not.toThrow()
    expect(() => appendLiveTurn(undefined, 'solana', 'a', turn('x'))).not.toThrow()
    expect(() => clearLiveSession(broken, 'solana', 'a')).not.toThrow()
    expect(() => clearLiveSession(undefined, 'solana', 'a')).not.toThrow()
  })

  it('reads malformed JSON as nothing', () => {
    const storage = memoryStorage()
    storage.setItem(liveSessionKey('solana', 'a'), '{not json')
    expect(loadLiveSession(storage, 'solana', 'a')).toEqual([])
  })

  it('reads JSON that is not a list as nothing', () => {
    const storage = memoryStorage()
    storage.setItem(liveSessionKey('solana', 'a'), '{"role":"user"}')
    expect(loadLiveSession(storage, 'solana', 'a')).toEqual([])
  })

  it('starts again over malformed JSON rather than losing the new turn', () => {
    const storage = memoryStorage()
    storage.setItem(liveSessionKey('solana', 'a'), '{not json')
    appendLiveTurn(storage, 'solana', 'a', turn('fresh'))
    expect(loadLiveSession(storage, 'solana', 'a')).toEqual([turn('fresh')])
  })
})

describe('what a saved turn can hold', () => {
  function loaded(entries: unknown[]): LiveTurn[] {
    const storage = memoryStorage()
    storage.setItem(liveSessionKey('solana', 'a'), JSON.stringify(entries))
    return loadLiveSession(storage, 'solana', 'a')
  }

  it('drops every field but the four it knows', () => {
    const [restored] = loaded([
      {
        role: 'agent',
        text: 'Sent on Jupiter.',
        at: 5,
        explorerUrl: 'https://solscan.io/tx/abc',
        signing: { family: 'solana', transaction: 'AQAB' },
        route: { venue: 'jupiter' },
        depositAddress: 'So1anaAddress',
        prepared: { pay: { amount: '1' } },
      },
    ])
    expect(restored).toEqual({
      role: 'agent',
      text: 'Sent on Jupiter.',
      at: 5,
      explorerUrl: 'https://solscan.io/tx/abc',
    })
  })

  it('never writes an unknown field either', () => {
    const storage = memoryStorage()
    const signable = { ...turn('hi'), signing: { transaction: 'AQAB' } }
    appendLiveTurn(storage, 'solana', 'a', signable)
    expect(storage.getItem(liveSessionKey('solana', 'a'))).not.toContain('AQAB')
  })

  it.each([
    'http://solscan.io/tx/abc',
    'javascript:alert(1)',
    'data:text/html,hi',
    '//solscan.io/tx/abc',
    'not a url',
    7,
  ])('drops the link %s and keeps the words', (explorerUrl) => {
    expect(loaded([{ role: 'agent', text: 'Sent.', at: 1, explorerUrl }])).toEqual([
      { role: 'agent', text: 'Sent.', at: 1 },
    ])
  })

  it('does not write a link that is not https', () => {
    const storage = memoryStorage()
    appendLiveTurn(storage, 'solana', 'a', { ...turn('x'), explorerUrl: 'javascript:alert(1)' })
    expect(storage.getItem(liveSessionKey('solana', 'a'))).not.toContain('javascript')
  })

  it('drops an entry that is not a turn', () => {
    expect(
      loaded([
        null,
        'text',
        { role: 'system', text: 'x', at: 1 },
        { role: 'user', at: 1 },
        { role: 'user', text: 'no time' },
        { role: 'user', text: 'x', at: Number.NaN },
        { role: 'user', text: 'kept', at: 2 },
      ])
    ).toEqual([{ role: 'user', text: 'kept', at: 2 }])
  })
})

describe('where the chat shows', () => {
  it.each(['/solana/intents', '/solana/intents/new'])('shows on %s', (path) => {
    expect(showChatOnPath(path, 'solana')).toBe(true)
  })

  it.each(['/solana/intents/abc', '/solana/agents', '/solana/intentsx', '/sui/intents', '/'])(
    'does not show on %s',
    (path) => {
      expect(showChatOnPath(path, 'solana')).toBe(false)
    }
  )

  it('matches the network segment Stellar sits under', () => {
    expect(showChatOnPath('/stellar-testnet/intents', 'stellar-testnet')).toBe(true)
    expect(showChatOnPath('/stellar-mainnet/intents', 'stellar-testnet')).toBe(false)
  })
})

describe('the one sentence a chain race settles to', () => {
  it('says nothing while the race is still open', () => {
    for (const phase of ['idle', 'building', 'review', 'signing', 'submitting']) {
      expect(chainOutcomeSentence({ phase, venueName: 'Jupiter' })).toBeUndefined()
    }
  })

  it('names the venue and that it was sent', () => {
    expect(chainOutcomeSentence({ phase: 'settled', venueName: 'Jupiter' })).toBe(
      'Sent on Jupiter.'
    )
  })

  it('warns against sending again when the outcome is not known', () => {
    expect(
      chainOutcomeSentence({ phase: 'pending', venueName: 'Jupiter', error: 'Not known yet.' })
    ).toBe(
      "The transaction on Jupiter may have gone through, so check your wallet's activity before trying again."
    )
  })

  it('names the venue and repeats what the card said when it failed', () => {
    expect(
      chainOutcomeSentence({ phase: 'failed', venueName: 'Jupiter', error: 'You declined it.' })
    ).toBe('On Jupiter: You declined it.')
  })

  it('still says something when a failure gave no reason', () => {
    expect(chainOutcomeSentence({ phase: 'failed', venueName: 'Jupiter' })).toBe(
      'On Jupiter: This could not be finished.'
    )
  })

  it('repeats a refusal that never reached a venue', () => {
    expect(chainOutcomeSentence({ phase: 'failed', error: 'A cash-out is under way.' })).toBe(
      'A cash-out is under way.'
    )
    expect(chainOutcomeSentence({ phase: 'failed' })).toBeUndefined()
  })
})

import { describe, expect, it, vi } from 'vitest'

import { isWalletAddress } from '../wallet/address'
import { connectAddress, pathUnderChain, screenAfterConnect } from '../wallet/chain-path'
import { isUserRejection, orderWallets } from '../wallet/connector'
import { evmWalletOptions } from '../wallet/evm-options'
import { createWalletStore } from '../wallet/wallet-store'

describe('isWalletAddress', () => {
  it.each([
    ['Stellar', 'GBD7QFQVR4QWNEJSHP4VN7RAAUKXTMZ4EJ4EBMCR7CP3HMF7RXEASTD7'],
    ['EVM', '0x52908400098527886E0F7030069857D2E4169EE7'],
    ['Sui', `0x${'ab'.repeat(32)}`],
    ['Solana', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'],
    ['NEAR named', 'alice.near'],
    ['NEAR nested', 'app.alice-1.near'],
    ['NEAR implicit', 'ab'.repeat(32)],
  ])('accepts a %s address', (_, address) => {
    expect(isWalletAddress(address)).toBe(true)
  })

  it.each([
    'not-an-address',
    '',
    'alice',
    '0x1234',
    'alice..near',
    'ALICE.near',
    'GBD7,GBD7',
    'alice.near,bob.near',
  ])('refuses %j', (value) => {
    expect(isWalletAddress(value)).toBe(false)
  })
})

describe('pathUnderChain', () => {
  it('keeps the screen', () => {
    expect(pathUnderChain('/stellar/history', 'near')).toBe('/near/history')
    expect(pathUnderChain('/near/intents/abc', 'sui')).toBe('/sui/intents/abc')
  })

  it('opens intents from a bare chain address', () => {
    expect(pathUnderChain('/stellar', 'solana')).toBe('/solana/intents')
  })
})

describe('orderWallets', () => {
  it('puts ready wallets first and keeps order within each group', () => {
    const wallet = (id: string, detected: boolean) => ({ id, name: id, detected })
    const ordered = orderWallets([
      wallet('a', false),
      wallet('b', true),
      wallet('c', false),
      wallet('d', true),
    ])
    expect(ordered.map((o) => o.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('isUserRejection', () => {
  it('treats a decline as ordinary, and a fault as a fault', () => {
    expect(isUserRejection('User rejected the request.')).toBe(true)
    expect(isUserRejection('The user declined')).toBe(true)
    expect(isUserRejection('Popup closed')).toBe(true)
    expect(isUserRejection('Internal JSON-RPC error')).toBe(false)
  })
})

describe('evmWalletOptions', () => {
  const generic = { id: 'injected', name: 'Browser Wallet', type: 'injected' }
  const metamask = { id: 'io.metamask', name: 'MetaMask', type: 'injected', icon: 'mm.svg' }

  it('hides the generic injected wallet when a named one is present', () => {
    const options = evmWalletOptions([generic, metamask])
    expect(options.filter((o) => o.detected).map((o) => o.id)).toEqual(['io.metamask'])
  })

  it('keeps the generic injected wallet when nothing named turned up', () => {
    const options = evmWalletOptions([generic])
    expect(options.filter((o) => o.detected).map((o) => o.id)).toEqual(['injected'])
  })

  it('keeps generic beside WalletConnect, which is not a browser wallet', () => {
    const wc = { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' }
    const options = evmWalletOptions([generic, wc])
    expect(options.filter((o) => o.detected).map((o) => o.id)).toEqual([
      'injected',
      'walletConnect',
    ])
  })

  it('offers an install link only for wallets not detected', () => {
    const options = evmWalletOptions([metamask])
    expect(options.find((o) => o.name === 'MetaMask')?.detected).toBe(true)
    const rabby = options.find((o) => o.name === 'Rabby Wallet')
    expect(rabby?.detected).toBe(false)
    expect(rabby?.installUrl).toBe('https://rabby.io')
  })
})

describe('createWalletStore', () => {
  function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    }
  }

  it('is restoring only when a wallet is remembered', () => {
    expect(createWalletStore('k', () => memory()).get().isRestoring).toBe(false)
    expect(createWalletStore('k', () => memory({ k: 'Phantom' })).get().isRestoring).toBe(true)
  })

  it('stays undecided on the server, so nothing renders a connect page there', () => {
    expect(createWalletStore('k', () => memory()).getServer().isRestoring).toBe(true)
  })

  it('notifies subscribers until they leave', () => {
    const store = createWalletStore('k', () => memory())
    const listener = vi.fn()
    const leave = store.subscribe(listener)
    store.set({ address: 'a' })
    expect(store.get().address).toBe('a')
    expect(listener).toHaveBeenCalledTimes(1)
    leave()
    store.set({ address: 'b' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('remembers and forgets a wallet', () => {
    const storage = memory()
    const store = createWalletStore('k', () => storage)
    store.remember('Phantom')
    expect(store.remembered()).toBe('Phantom')
    store.remember(undefined)
    expect(store.remembered()).toBeUndefined()
  })

  it('survives storage that throws, as private browsing does', () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    const store = createWalletStore('k', () => ({
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    }))
    expect(store.remembered()).toBeUndefined()
    expect(() => store.remember('Phantom')).not.toThrow()
  })
})

describe('connectAddress', () => {
  it('is the bare address for the default screen', () => {
    expect(connectAddress('/stellar/intents', '')).toBe('/')
    expect(connectAddress('/stellar', '')).toBe('/')
  })

  it('carries any other screen through, with its query', () => {
    expect(connectAddress('/near/agents', '')).toBe('/?next=%2Fagents')
    expect(connectAddress('/near/apps', '?a=1')).toBe('/?next=%2Fapps%3Fa%3D1')
  })
})

describe('screenAfterConnect', () => {
  it('opens intents by default', () => {
    expect(screenAfterConnect(null)).toBe('/intents')
    expect(screenAfterConnect('/')).toBe('/intents')
  })

  it('keeps a screen and its query', () => {
    expect(screenAfterConnect('/agents')).toBe('/agents')
    expect(screenAfterConnect('/apps?a=1')).toBe('/apps?a=1')
  })

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'agents', '/../admin'])(
    'refuses %j',
    (value) => {
      expect(screenAfterConnect(value)).toBe('/intents')
    }
  )
})

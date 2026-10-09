import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(multi: boolean, network: 'testnet' | 'mainnet') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', multi ? 'testnet,mainnet' : '')
  vi.stubGlobal('window', {})
  const config = await import('@intent/config')
  config.setClientNetwork(network)
  return import('../network-storage-key')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('networkKey', () => {
  it('keeps the plain key when one network is served, so saved sessions survive', async () => {
    const { networkKey } = await load(false, 'testnet')
    expect(networkKey('intent.session.v1')).toBe('intent.session.v1')
  })

  it('names the network when several are served, so one network’s session is never read on another', async () => {
    const onMain = await load(true, 'mainnet')
    expect(onMain.networkKey('intent.session.v1')).toBe('intent.session.v1.mainnet')
    const onTest = await load(true, 'testnet')
    expect(onTest.networkKey('intent.session.v1')).toBe('intent.session.v1.testnet')
  })
})

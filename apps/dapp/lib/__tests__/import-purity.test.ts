import { afterAll, describe, expect, it, vi } from 'vitest'

// Vitest provides `import.meta.glob`; the app's tsconfig does not know the type.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: false }): Record<string, () => Promise<unknown>>
  }
}

/**
 * No module may read the Stellar network while it is being imported.
 *
 * With several networks served, the network belongs to the request, and at
 * import time there is no request. A module that captures the network in a
 * constant would freeze whichever answer it got first and serve it to every
 * later request. Here nothing is selected, so such a module throws on import
 * and is named.
 */

const modules = import.meta.glob(
  [
    '../**/*.ts',
    '!../__tests__/**',
    '!../**/*.d.ts',
    '../../components/**/*.tsx',
    '../../providers/**/*.tsx',
    '../../hooks/**/*.ts',
  ],
  { eager: false }
)

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('importing', () => {
  it('reads no network at load, in any module', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', 'testnet,mainnet')
    const config = await import('@intent/config')
    config.setNetworkResolver(undefined)

    const offenders: string[] = []
    for (const [path, load] of Object.entries(modules)) {
      try {
        await load()
      } catch (e) {
        if (e instanceof Error && /No Stellar network is selected/.test(e.message)) {
          offenders.push(path)
        }
      }
    }
    expect(offenders).toEqual([])
  }, 600_000)
})

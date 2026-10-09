import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `next build` loads every route module once, outside any request, to collect its
 * page data. With two Stellar networks served there is no "current network" outside
 * a request, so a route that reads it while its module loads (a client built at the
 * top of the file, say) makes the whole build fail. The single-network build CI runs
 * cannot see that, so this loads every route the way the build does, with both on.
 */
const API = join(__dirname, '../../app/api')

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return routeFiles(path)
    return name === 'route.ts' ? [path] : []
  })
}

const routes = routeFiles(API)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('every API route loads on a deployment that serves both networks', () => {
  it('finds the routes it is meant to check', () => {
    expect(routes.length).toBeGreaterThan(30)
  })

  it('loads without reading the network outside a request', async () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet')
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORKS', 'testnet,mainnet')
    vi.resetModules()

    const failures: string[] = []
    for (const file of routes) {
      try {
        await import(/* @vite-ignore */ file)
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        failures.push(`${relative(API, file).replace(/\\/g, '/')}: ${reason}`)
      }
    }
    expect(failures).toEqual([])
  }, 120_000)
})

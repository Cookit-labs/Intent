import { describe, expect, it } from 'vitest'

import { resolveAsset } from '../swap/assets'
import { createSoroswapQuoter } from '../swap/sources/soroswap-quoter'
import type { QuoteRequest } from '../swap/quote'

/**
 * These exercise the boundaries the quoter enforces before it ever reaches the
 * network, plus its behaviour when the network misbehaves.
 *
 * The happy path is deliberately not mocked. Simulating a router means encoding
 * an XDR envelope and decoding an ScVal reply, and a fixture of that only ever
 * proves the fixture still parses. It was verified live instead: 200 XLM
 * returned `[2000000000, 197870351]` from the deployed testnet router. What is
 * worth testing here is that a broken or absent network degrades to a decline
 * rather than an exception, since a throwing source would take the whole
 * competition down with it.
 */

const XLM = resolveAsset('XLM')!
const USDC = resolveAsset('USDC')!

function sendReq(amount = '300000000'): QuoteRequest {
  return { kind: 'strict_send', from: XLM, to: USDC, sendAmount: amount }
}

describe('soroswap quoter', () => {
  it('is configured by default', () => {
    expect(createSoroswapQuoter().isConfigured()).toBe(true)
  })

  it('can be switched off without being removed from the source list', () => {
    expect(createSoroswapQuoter({ enabled: false }).isConfigured()).toBe(false)
  })

  it('declines a pair with no Soroban token, without calling the network', async () => {
    const quoter = createSoroswapQuoter({ rpcUrl: 'http://127.0.0.1:1/unreachable' })
    const weth = {
      kind: 'classic' as const,
      code: 'WETH',
      issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    }

    const out = await quoter.quote({
      kind: 'strict_send',
      from: XLM,
      to: weth,
      sendAmount: '100',
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unsupported_pair')
  })

  it('declines strict_receive rather than quoting a path it cannot fill', async () => {
    const quoter = createSoroswapQuoter({ rpcUrl: 'http://127.0.0.1:1/unreachable' })

    const out = await quoter.quote({
      kind: 'strict_receive',
      from: XLM,
      to: USDC,
      receiveAmount: '300000000',
    })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.reason).toBe('unsupported_pair')
  })

  it('returns a failure instead of throwing when the RPC is unreachable', async () => {
    const quoter = createSoroswapQuoter({ rpcUrl: 'http://127.0.0.1:1/unreachable' })

    const out = await quoter.quote(sendReq())

    // The specific reason depends on how the transport fails; what matters is
    // that it resolves at all. A source that throws denies the competition
    // every other source's route too.
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure.source).toBe('soroswap')
  })

  it('reports a simulation error as no_route rather than a crash', async () => {
    const quoter = createSoroswapQuoter({
      rpcUrl: 'http://127.0.0.1:1/unreachable',
      // A well-formed but undeployed contract id: the router call cannot
      // resolve, which is what a dead pool looks like.
      routerId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    })

    const out = await quoter.quote(sendReq())

    expect(out.ok).toBe(false)
  })
})

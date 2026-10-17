import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WALLET_HEADER } from '../wallet-header'

const session = { current: undefined as { email: string } | undefined }
vi.mock('../server/session', () => ({ readSessionFromRequest: () => session.current }))
vi.mock('../linq/client', () => ({ createLinqClient: () => ({ configured: true }) }))
vi.mock('@intent/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@intent/config')>()
  return { ...actual, isMainnet: () => true }
})

import { guardNaira } from '../naira/guard'

const wallet = Keypair.random().publicKey()
const req = (headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/api/naira/rate', { headers })

describe('guardNaira', () => {
  beforeEach(() => {
    session.current = undefined
  })

  it('lets a connected wallet cash out with no email sign-in', () => {
    expect(guardNaira(req({ [WALLET_HEADER]: wallet }))).toEqual({
      ok: true,
      email: `wallet:${wallet}`,
    })
  })

  it('still uses the email when one is signed in', () => {
    session.current = { email: 'a@b.co' }
    expect(guardNaira(req())).toEqual({ ok: true, email: 'a@b.co' })
  })

  it('asks for a connected wallet when there is neither', async () => {
    const guard = guardNaira(req())
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.response.status).toBe(401)
  })
})

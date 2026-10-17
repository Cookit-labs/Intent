import { Keypair } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WALLET_HEADER } from '../wallet-header'

const session = { current: undefined as { email: string } | undefined }
vi.mock('../server/session', () => ({ readSessionFromRequest: () => session.current }))

import { requesterOf } from '../server/requester'

const wallet = Keypair.random().publicKey()
const req = (headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/api/x', { headers })

describe('requesterOf', () => {
  beforeEach(() => {
    session.current = undefined
  })

  it('is the signed-in email when there is a session, whatever wallet is claimed', () => {
    session.current = { email: 'a@b.co' }
    expect(requesterOf(req({ [WALLET_HEADER]: wallet }))).toEqual({ email: 'a@b.co' })
  })

  it('is the connected wallet when nobody is signed in', () => {
    expect(requesterOf(req({ [WALLET_HEADER]: wallet }))).toEqual({ email: `wallet:${wallet}` })
  })

  it('is nobody without a session or a wallet', () => {
    expect(requesterOf(req())).toBeUndefined()
  })

  it('is nobody for a wallet header that is not a Stellar account', () => {
    expect(requesterOf(req({ [WALLET_HEADER]: 'not-an-address' }))).toBeUndefined()
    expect(requesterOf(req({ [WALLET_HEADER]: `${wallet},${wallet}` }))).toBeUndefined()
  })
})

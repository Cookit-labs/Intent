import { stellarTestnet } from '@intent/config'
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { sponsorForSubmission } from '../sponsor/sponsor'
import { fundWithFriendbot } from '../stellar-account'
import { submitSignedSwap } from '../swap/submit'

/**
 * A sponsored transaction settling on testnet, with the fee charged to the
 * sponsor and not to the user.
 *
 * Live rather than mocked because the thing being checked is the network's
 * behaviour: that a fee-bump wrapping a user-signed inner transaction is
 * accepted, applies the inner operations, and bills the outer account.
 * Two throwaway keys, both funded by friendbot, both discarded.
 */

const LIVE = process.env['SKIP_LIVE'] !== '1'

async function sequenceOf(account: string): Promise<string> {
  const res = await fetch(`${stellarTestnet.horizonUrl}/accounts/${account}`)
  const body = (await res.json()) as { sequence: string }
  return body.sequence
}

async function xlmBalance(account: string): Promise<number> {
  const res = await fetch(`${stellarTestnet.horizonUrl}/accounts/${account}`)
  const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] }
  return Number(body.balances.find((b) => b.asset_type === 'native')?.balance ?? '0')
}

describe.skipIf(!LIVE)('fee sponsorship on testnet', () => {
  it('settles a user-signed payment with the fee charged to the sponsor', async () => {
    const user = Keypair.random()
    const sponsor = Keypair.random()
    await fundWithFriendbot(user.publicKey())
    await fundWithFriendbot(sponsor.publicKey())

    const userBefore = await xlmBalance(user.publicKey())
    const sponsorBefore = await xlmBalance(sponsor.publicKey())

    const tx = new TransactionBuilder(
      new Account(user.publicKey(), await sequenceOf(user.publicKey())),
      {
        fee: BASE_FEE,
        networkPassphrase: stellarTestnet.networkPassphrase,
      }
    )
      .addOperation(
        Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: '1' })
      )
      .setTimeout(120)
      .build()
    tx.sign(user)

    const sent = await sponsorForSubmission(tx.toXDR(), user.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
    })
    expect(sent.sponsored).toBe(true)

    const result = await submitSignedSwap(sent.xdr)
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const userAfter = await xlmBalance(user.publicKey())
    const sponsorAfter = await xlmBalance(sponsor.publicKey())

    // The user paid exactly the 1 XLM they sent and not a stroop of fee;
    // the sponsor received that 1 XLM and paid the fee out of it.
    expect(userBefore - userAfter).toBeCloseTo(1, 7)
    expect(sponsorAfter - sponsorBefore).toBeLessThan(1)
    expect(sponsorAfter - sponsorBefore).toBeGreaterThan(0.99)
  }, 90_000)
})

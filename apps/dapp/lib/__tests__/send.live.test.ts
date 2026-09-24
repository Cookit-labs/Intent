import { stellarTestnet } from '@intent/config'
import { Keypair, TransactionBuilder, type Transaction } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'

import { resolveRecipient } from '../names/resolve'
import { assertSendPayment, buildSendPayment } from '../send/build-payment'
import { expectationFor } from '../send/prepare'
import { sponsorForSubmission } from '../sponsor/sponsor'
import { fundWithFriendbot } from '../stellar-account'
import { submitSignedSwap } from '../swap/submit'

/**
 * A send settling on testnet, by raw address, through every piece the routes
 * use: resolve, expectation, build, sign, resolve again, assert, sponsor,
 * submit. Three throwaway keys funded by friendbot, all discarded.
 *
 * By address rather than by name, and that limit is worth stating: a `.xlm`
 * name resolves on mainnet to an account that need not exist on testnet, so
 * name-to-payment cannot be exercised end to end here. The name half is
 * covered live by `soroban-domains.live.test.ts` and `federation.live.test.ts`;
 * this covers the payment half.
 */

const LIVE = process.env['SKIP_LIVE'] !== '1'

async function xlmBalance(account: string): Promise<number> {
  const res = await fetch(`${stellarTestnet.horizonUrl}/accounts/${account}`)
  const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] }
  return Number(body.balances.find((b) => b.asset_type === 'native')?.balance ?? '0')
}

describe.skipIf(!LIVE)('a send on testnet', () => {
  it('pays 1 XLM to another account, sponsored, with the memo the user typed', async () => {
    const payer = Keypair.random()
    const payee = Keypair.random()
    const sponsor = Keypair.random()
    await fundWithFriendbot(payer.publicKey())
    await fundWithFriendbot(payee.publicKey())
    await fundWithFriendbot(sponsor.publicKey())

    const payerBefore = await xlmBalance(payer.publicKey())
    const payeeBefore = await xlmBalance(payee.publicKey())

    // Build, as the build route does.
    const resolved = await resolveRecipient(payee.publicKey())
    const expectation = expectationFor(resolved, 'XLM', '1', 'live test')
    const built = await buildSendPayment({ account: payer.publicKey(), expectation })

    const tx = TransactionBuilder.fromXDR(
      built.xdr,
      stellarTestnet.networkPassphrase
    ) as Transaction
    tx.sign(payer)
    const signedXdr = tx.toXDR()

    // Submit, as the submit route does: resolved again, asserted against the
    // fresh answer, then sponsored and sent.
    const again = await resolveRecipient(payee.publicKey())
    assertSendPayment(signedXdr, payer.publicKey(), expectationFor(again, 'XLM', '1', 'live test'))

    const sent = await sponsorForSubmission(signedXdr, payer.publicKey(), {
      env: { SPONSOR_SECRET_KEY: sponsor.secret() },
    })
    expect(sent.sponsored).toBe(true)

    const result = await submitSignedSwap(sent.xdr)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    process.stdout.write(`send settled: ${result.explorerUrl}\n`)

    const payerAfter = await xlmBalance(payer.publicKey())
    const payeeAfter = await xlmBalance(payee.publicKey())

    // The payee received exactly 1 XLM; the payer paid exactly 1 XLM and not
    // a stroop of fee, which the sponsor covered.
    expect(payeeAfter - payeeBefore).toBeCloseTo(1, 7)
    expect(payerBefore - payerAfter).toBeCloseTo(1, 7)
  }, 120_000)
})

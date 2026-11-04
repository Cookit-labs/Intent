import { NEAR_ACCOUNT, NEAR_TX_HASH } from '../../chains/near/account'
import { viewCall, waitForTransaction } from '../../chains/near/rpc'
import { assertOneClickSafe, DEPOSIT_ADDRESS } from '../../chains/near/safety'
import { buildDepositTransaction } from '../../chains/near/swap'
import { explorerUrl, nearTokens, USDC_NEAR } from '../../chains/near/tokens'
import {
  ChainActionRefused,
  tokenBySymbol,
  toBaseUnits,
  type ChainToken,
  type SignedPayload,
  type SigningPayload,
  type SubmitResult,
} from '../../chains/types'
import type { DepositChain, DepositExpectation } from '../types'

const USDC = tokenBySymbol(nearTokens, 'USDC') as ChainToken

/** Long enough for an ordinary transaction to finish, and short enough to wait on in a request. */
const CONFIRM_WAIT_MS = 15_000

function refuse(sentence: string): never {
  throw new ChainActionRefused(`${sentence} Nothing was signed or sent.`)
}

/** Everything about the order itself, checked before any transaction is read or written. */
function orderUnits(expectation: DepositExpectation): string {
  const { account, depositAddress, memo, amount } = expectation
  if (memo !== undefined) refuse('This order has a memo, which a NEAR deposit cannot carry.')
  if (!NEAR_ACCOUNT.test(account)) refuse('That is not a NEAR account.')
  if (!DEPOSIT_ADDRESS.test(depositAddress)) {
    refuse('This order’s deposit address is not a NEAR deposit address.')
  }
  if (depositAddress === account) refuse('This order’s deposit address is your own account.')
  try {
    return toBaseUnits(amount, USDC.decimals)
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
}

/**
 * The shared check bounds the shape of a deposit but not who it pays or how much, since
 * for a 1Click swap those come from a quote. Here they come from the order, so they are
 * bound exactly, and only USDC is left of the tokens that check allows.
 */
function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
  const units = orderUnits(expectation)
  assertOneClickSafe(payload, expectation.account)
  if (payload.family !== 'near') refuse('That is not a NEAR transaction.')

  const transaction = payload.transactions[0]
  if (transaction?.receiverId !== USDC.id) refuse('This transfer is not USDC.')
  const args = transaction.actions[transaction.actions.length - 1]?.params.args
  if (args?.['receiver_id'] !== expectation.depositAddress) {
    refuse('This transfer does not go to this order’s deposit address.')
  }
  if (args?.['amount'] !== units) refuse('This transfer’s amount is not this order’s amount.')
}

async function build(expectation: DepositExpectation): Promise<SigningPayload> {
  const units = orderUnits(expectation)
  const transaction = await buildDepositTransaction(
    USDC,
    expectation.account,
    expectation.depositAddress,
    units
  )
  const payload: SigningPayload = { family: 'near', transactions: [transaction] }
  assertSafe(payload, expectation)
  return payload
}

/** After a wallet has sent, an order that no longer parses is simply not what was paid. */
function expectedUnits(amount: string): string | undefined {
  try {
    return toBaseUnits(amount, USDC.decimals)
  } catch {
    return undefined
  }
}

async function submit(
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  if (signed.family !== 'near') {
    return { ok: false, error: 'That is not a NEAR transaction, so nothing was looked up.' }
  }
  const { account, depositAddress, amount } = expectation
  const hash = signed.hashes[signed.hashes.length - 1]
  if (hash === undefined || !NEAR_TX_HASH.test(hash)) {
    // A NEAR wallet sends for itself, so a bad hash says nothing about whether USDC moved.
    return {
      ok: false,
      pending: true,
      error:
        "Your wallet did not return a transaction to follow, and it may still have sent this. Don't send it again until you've checked your wallet's activity.",
    }
  }

  const outcome = await waitForTransaction(hash, account, CONFIRM_WAIT_MS)
  if (outcome.state === 'unknown') {
    return {
      ok: false,
      pending: true,
      error: `Your wallet returned transaction ${hash}, but NEAR hasn't shown it finished yet. Don't send it again until you've checked ${explorerUrl(hash)}.`,
    }
  }
  if (outcome.state === 'failed') {
    return {
      ok: false,
      error: `Your deposit transaction failed on NEAR (${hash}), so the funds did not leave your account, apart from the gas. You can try again.`,
    }
  }

  const units = expectedUnits(amount)
  const paysDeposit =
    units !== undefined &&
    outcome.calls.some(
      (call) =>
        call.method === 'ft_transfer' &&
        call.args['receiver_id'] === depositAddress &&
        call.args['amount'] === units
    )
  // Any contract can answer ft_transfer, so the receiver is what makes this USDC.
  if (outcome.signer !== account || outcome.receiver !== USDC.id || !paysDeposit) {
    return {
      ok: false,
      error: `Transaction ${hash} is not this order's deposit. Check your wallet's activity before trying again.`,
    }
  }
  return { ok: true, hash, explorerUrl: explorerUrl(hash) }
}

export const nearDeposit: DepositChain = {
  chain: 'near',
  usdcDecimals: USDC.decimals,
  supportsMemo: false,
  isAccount: (address) => NEAR_ACCOUNT.test(address),
  isDepositAddress: (address) => DEPOSIT_ADDRESS.test(address),
  usdcBalance: async (account) =>
    BigInt(await viewCall<string>(USDC_NEAR, 'ft_balance_of', { account_id: account })),
  build,
  assertSafe,
  submit,
}

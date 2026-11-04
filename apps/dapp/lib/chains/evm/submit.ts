import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hash,
} from 'viem'

import type { DepositExpectation } from '../../weave/types'
import { toBaseUnits, type SignedPayload, type SubmitResult } from '../types'
import type { EvmClient, EvmReceipt } from './client'
import { EVM_CHAINS, EVM_NATIVE_ID, evmExplorerUrl, type EvmChain } from './tokens'

export const EVM_HASH = /^0x[0-9a-fA-F]{64}$/

export const TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function sameCalldata(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function transferCalldata(to: string, units: bigint): string {
  return encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [to as Address, units],
  })
}

/** Whether this receipt shows this account paying exactly this token transfer to this address. */
export function erc20TransferPaid(
  receipt: EvmReceipt,
  paid: { token: string; account: string; depositAddress: string; units: bigint }
): boolean {
  if (!sameAddress(receipt.from, paid.account)) return false
  if (receipt.to === null || !sameAddress(receipt.to, paid.token)) return false
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).some(
    (log) =>
      sameAddress(log.address, paid.token) &&
      sameAddress(log.args.from, paid.account) &&
      sameAddress(log.args.to, paid.depositAddress) &&
      log.args.value === paid.units
  )
}

function pending(error: string): SubmitResult {
  return { ok: false, pending: true, error }
}

/**
 * Asks the chain what the wallet sent. The wallet broadcast this for itself, so nothing here can
 * stop it, and an answer may lack `pending` only if it proves the funds did not move. Only a
 * revert does, and only of this very transfer: from this account, to that address, carrying
 * exactly this calldata and value. For a token `to` is the contract, so from and to alone would
 * pass the account's earlier failed call on that token while the real transfer went out.
 *
 * A receipt that is someone else's or for something else says nothing about the real transfer,
 * so it is pending too, and it is never reported to 1Click.
 */
export async function confirmEvmTransfer(
  chain: EvmChain,
  client: () => EvmClient,
  signed: SignedPayload,
  expectation: DepositExpectation
): Promise<SubmitResult> {
  const { name, spendReserve } = EVM_CHAINS[chain]
  const { account, depositAddress, amount, token } = expectation
  if (signed.family !== 'evm' || !EVM_HASH.test(signed.hash) || token === undefined) {
    return pending(
      "The wallet didn't return a transaction this app can follow. Check your wallet's activity before trying again, in case it was sent."
    )
  }
  const { hash } = signed
  const notConfirmed = pending(
    `This transfer isn't confirmed on ${name} yet, and it may still land, so don't send it again. Its transaction is ${hash}.`
  )
  const notThisSwap = pending(
    `Transaction ${hash} is not this swap's transfer, so it was not reported to NEAR Intents. Check your wallet's activity before trying again, in case the real one went out.`
  )

  let receipt: EvmReceipt
  try {
    receipt = await client().waitForReceipt(hash as Hash)
  } catch {
    // What a hash from another chain gives too: this chain never finds it.
    return notConfirmed
  }

  const native = token.id === EVM_NATIVE_ID
  const expectedTo = native ? depositAddress : token.id
  const fromThisAccountToThatAddress =
    sameAddress(receipt.from, account) && receipt.to !== null && sameAddress(receipt.to, expectedTo)
  if (!fromThisAccountToThatAddress) return notThisSwap

  // With no amount to compare against, this can't be shown to be this transfer, or not to be.
  let units: bigint
  try {
    units = BigInt(toBaseUnits(amount, token.decimals))
  } catch {
    return pending(
      `Transaction ${hash} couldn't be checked against this swap's amount. Check your wallet's activity before trying again, in case it went out.`
    )
  }

  if (receipt.status === 'reverted') {
    // The comparison sits in here too: an RPC can answer with a shape that makes it throw, and
    // that says no more about the transfer than a read that failed.
    let isThisTransfer: boolean
    try {
      const sent = await client().transaction(hash as Hash)
      isThisTransfer =
        sent.value === (native ? units : BigInt(0)) &&
        sameCalldata(sent.input, native ? '0x' : transferCalldata(depositAddress, units))
    } catch {
      return pending(
        `Transaction ${hash} failed on ${name}, but it couldn't be read to tell whether it was this swap's transfer. Check your wallet's activity before trying again, in case the real one went out.`
      )
    }
    if (!isThisTransfer) return notThisSwap
    const likelyCause = native && spendReserve !== undefined ? ` ${spendReserve.reverted}` : ''
    return {
      ok: false,
      error: `This transfer failed on ${name}. The ${token.symbol} did not move, and only the gas was spent.${likelyCause}`,
    }
  }

  if (native) {
    let value: bigint
    try {
      ;({ value } = await client().transaction(hash as Hash))
    } catch {
      return notConfirmed
    }
    if (value !== units) return notThisSwap
  } else if (!erc20TransferPaid(receipt, { token: token.id, account, depositAddress, units })) {
    return notThisSwap
  }
  return { ok: true, hash, explorerUrl: evmExplorerUrl(chain, hash) }
}

import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem'

import {
  ChainActionRefused,
  type ChainVenue,
  type SignedPayload,
  type SigningPayload,
  type SubmitInput,
  type SubmitResult,
} from '../types'
import { evmClient, evmReader, type EvmClient, type EvmReceipt } from './client'
import { EVM_HASH, sameAddress, sameCalldata } from './submit'
import { EVM_CHAINS, evmExplorerUrl, type EvmChain } from './tokens'

/**
 * Calling a venue's contract from the person's own wallet on Avalanche or Monad. The wallet sends
 * this itself, so what the server checks is the calldata before it is offered, and afterwards the
 * transaction the chain says was sent.
 */

export interface DecodedCall {
  functionName: string
  args: readonly unknown[]
}

export interface ApprovalSeen {
  token: string
  spender: string
  units: bigint
}

export interface CheckContext {
  account: string
  /** Native coin the call spends, in base units. */
  value: bigint
  approval?: ApprovalSeen | undefined
}

export interface EvmContractRule {
  abi: Abi
  /** Every function this venue may call here. Nothing else decodes as allowed. */
  functions: readonly string[]
  /** Must refuse anything that pays or credits someone else, or that doesn't match the approval. */
  check: (call: DecodedCall, context: CheckContext) => void
}

export interface EvmCallPolicy {
  venueName: string
  chain: EvmChain
  /** By contract address. An address not here is refused, so an upgrade blocks until reviewed. */
  contracts: Readonly<Record<string, EvmContractRule>>
  /** The contracts the venue may be approved to pull from the person. Empty means none. */
  spenders: readonly string[]
  /** The tokens that may be approved. */
  approvable: readonly string[]
  /** Only a call that takes the native coin may carry value. */
  mayPayNative?: boolean | undefined
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function ruleFor(policy: EvmCallPolicy, to: string): EvmContractRule {
  const found = Object.entries(policy.contracts).find(([address]) => sameAddress(address, to))
  return (
    found?.[1] ??
    refuse(
      `This transaction calls a contract I haven't confirmed for ${policy.venueName}. If ${policy.venueName} moved its contracts, this stays blocked until the new ones are checked.`
    )
  )
}

/** Decodes against the allowed functions, and proves nothing follows the arguments. */
function decodeAllowed(rule: EvmContractRule, data: string, venueName: string): DecodedCall {
  let functionName: string
  let args: readonly unknown[]
  try {
    const decoded = decodeFunctionData({ abi: rule.abi, data: data as Hex })
    functionName = decoded.functionName
    args = decoded.args ?? []
  } catch {
    return refuse(`This transaction does something I haven't confirmed for ${venueName}.`)
  }
  if (!rule.functions.includes(functionName)) {
    refuse(`This transaction calls ${functionName}, which I haven't confirmed for ${venueName}.`)
  }
  const again = encodeFunctionData({ abi: rule.abi, functionName, args })
  if (!sameCalldata(again, data)) {
    refuse('This transaction carries extra data, and must be exactly one call.')
  }
  return { functionName, args }
}

function readApproval(approval: { to: string; data: string }, policy: EvmCallPolicy): ApprovalSeen {
  if (!policy.approvable.some((token) => sameAddress(token, approval.to))) {
    refuse(`This asks to approve a token I haven't confirmed for ${policy.venueName}.`)
  }
  let args: readonly [Address, bigint]
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data as Hex })
    if (decoded.functionName !== 'approve') throw new Error('not an approval')
    args = decoded.args
  } catch {
    return refuse('This first step is not a token approval.')
  }
  const [spender, units] = args
  if (!policy.spenders.some((allowed) => sameAddress(allowed, spender))) {
    refuse(`This approves an address that isn't confirmed for ${policy.venueName}.`)
  }
  if (units === maxUint256) refuse('This approval is unlimited, and only an exact one is allowed.')
  const again = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, units],
  })
  if (!sameCalldata(again, approval.data)) {
    refuse('This approval carries extra data.')
  }
  return { token: approval.to, spender, units }
}

/** Refuses anything but the calls this venue is confirmed to make, for this person. */
export function assertEvmCallSafe(
  payload: SigningPayload,
  account: string,
  policy: EvmCallPolicy
): void {
  const { name, chain } = EVM_CHAINS[policy.chain]
  if (payload.family !== 'evm') refuse(`That is not a ${name} transaction.`)
  if (payload.chainId !== chain.id) refuse(`That transaction is not for ${name}.`)
  if (!/^\d+$/.test(payload.value)) refuse('That transaction’s value is not valid.')
  const value = BigInt(payload.value)
  if (value !== BigInt(0) && policy.mayPayNative !== true) {
    refuse(`That transaction also spends ${EVM_CHAINS[policy.chain].nativeSymbol} as value.`)
  }
  const rule = ruleFor(policy, payload.to)
  const call = decodeAllowed(rule, payload.data, policy.venueName)
  const approval =
    payload.approval === undefined ? undefined : readApproval(payload.approval, policy)
  rule.check(call, { account, value, approval })
}

export interface EvmCallPlan {
  chain: EvmChain
  account: string
  to: string
  data: string
  /** Native coin sent with the call, in base units. */
  value?: bigint | undefined
  /** A token the contract pulls from the person, which needs an approval unless one is in place. */
  pull?: { token: string; spender: string; units: bigint } | undefined
}

export interface EvmCallBuild {
  signing: SigningPayload
  needsApproval: boolean
}

export type EvmReaderClient = ReturnType<typeof evmReader>

/**
 * The transaction to offer, with an exact approval only when the allowance falls short. Tried
 * against the chain first, except where an approval still has to land, since it would fail for
 * that reason alone. A call that would fail is refused here rather than costing the person gas.
 */
export async function buildEvmCall(
  plan: EvmCallPlan,
  reader: EvmReaderClient = evmReader(plan.chain)
): Promise<EvmCallBuild> {
  const { chain, account, to, data, value = BigInt(0), pull } = plan
  let needsApproval = false
  if (pull !== undefined) {
    const allowance = await reader.readContract({
      address: pull.token as Address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account as Address, pull.spender as Address],
    })
    needsApproval = allowance < pull.units
  }
  if (!needsApproval) {
    try {
      await reader.call({
        account: account as Address,
        to: to as Address,
        data: data as Hex,
        value,
      })
    } catch {
      refuse(
        'This would fail on the chain right now. Check your balance and that you have enough for the network fee.'
      )
    }
  }
  const signing: SigningPayload = {
    family: 'evm',
    chainId: EVM_CHAINS[chain].chain.id,
    to,
    data,
    value: value.toString(),
    ...(needsApproval && pull !== undefined
      ? {
          approval: {
            to: pull.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [pull.spender as Address, pull.units],
            }),
          },
        }
      : {}),
  }
  return { signing, needsApproval }
}

/** The line for the card when a wallet will ask twice. */
export function approvalNote(venueName: string, amount: string, symbol: string): string {
  return `Your wallet asks twice: first to let ${venueName} take exactly ${amount} ${symbol}, then for this action. If you stop after the first, nothing moves, and the approval stays until it is used or replaced.`
}

function pending(error: string): SubmitResult {
  return { ok: false, pending: true, error }
}

/**
 * Asks the chain what the wallet sent. It went out already, so nothing here can stop it, and an
 * answer may lack `pending` only if it proves the funds did not move: a revert of a transaction
 * that is shown to be this venue's, from this person.
 */
export async function confirmEvmCall(
  policy: EvmCallPolicy,
  account: string,
  signed: SignedPayload,
  client: EvmClient = evmClient(policy.chain)
): Promise<SubmitResult> {
  const { name, chain } = EVM_CHAINS[policy.chain]
  if (signed.family !== 'evm' || !EVM_HASH.test(signed.hash)) {
    return pending(
      "The wallet didn't return a transaction this app can follow. Check your wallet's activity before trying again, in case it was sent."
    )
  }
  const { hash } = signed
  let receipt: EvmReceipt
  try {
    receipt = await client.waitForReceipt(hash as Hash)
  } catch {
    return pending(
      `This isn't confirmed on ${name} yet, and it may still land, so don't send it again. Its transaction is ${hash}.`
    )
  }
  const notThis = pending(
    `Transaction ${hash} is not this action. Check your wallet's activity before trying again, in case the real one went out.`
  )
  if (!sameAddress(receipt.from, account) || receipt.to === null) return notThis
  try {
    const sent = await client.transaction(hash as Hash)
    assertEvmCallSafe(
      {
        family: 'evm',
        chainId: chain.id,
        to: receipt.to,
        data: sent.input,
        value: sent.value.toString(),
      },
      account,
      policy
    )
  } catch {
    return notThis
  }
  if (receipt.status === 'reverted') {
    return {
      ok: false,
      error: `This failed on ${name}. Your funds did not move, and only the gas was spent.`,
    }
  }
  return { ok: true, hash, explorerUrl: evmExplorerUrl(policy.chain, hash) }
}

/** What a venue built on this path gives `ChainVenue`. */
export function evmCallVenueParts(
  policy: EvmCallPolicy,
  client?: EvmClient
): Pick<ChainVenue, 'assertSafe' | 'submit'> {
  return {
    assertSafe: (payload, account) => assertEvmCallSafe(payload, account, policy),
    submit: (input: SubmitInput) => confirmEvmCall(policy, input.account, input.signed, client),
  }
}

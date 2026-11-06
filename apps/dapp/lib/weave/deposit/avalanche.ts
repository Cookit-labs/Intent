import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type Transport,
} from 'viem'
import { avalanche } from 'viem/chains'

import { erc20TransferPaid } from '../../chains/evm/submit'
import {
  ChainActionRefused,
  toBaseUnits,
  type SignedPayload,
  type SigningPayload,
  type SubmitResult,
} from '../../chains/types'
import type { DepositChain, DepositExpectation } from '../types'

const USDC_DECIMALS = 6
/** Circle's native USDC on the C-Chain, not the bridged USDC.e. */
const USDC: Address = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const RPC_TIMEOUT_MS = 8_000
const RECEIPT_TIMEOUT_MS = 20_000
const EXPLORER_TX = 'https://snowtrace.io/tx/'

const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

export type DepositReceipt = Pick<TransactionReceipt, 'status' | 'from' | 'to' | 'logs'>

export interface AvalancheClient {
  usdcBalance: (account: Address) => Promise<bigint>
  avaxBalance: (account: Address) => Promise<bigint>
  waitForReceipt: (hash: Hash) => Promise<DepositReceipt>
}

export function avalancheClient(
  transport: Transport = http(process.env['AVALANCHE_RPC_URL']?.trim() || undefined, {
    timeout: RPC_TIMEOUT_MS,
    retryCount: 1,
  })
): AvalancheClient {
  const client = createPublicClient({ chain: avalanche, transport })
  return {
    usdcBalance: (account) =>
      client.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      }),
    avaxBalance: (address) => client.getBalance({ address }),
    waitForReceipt: (hash) =>
      client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
  }
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isAccount(address: string): boolean {
  return isAddress(address, { strict: false }) && !same(address, zeroAddress)
}

function isDepositAddress(address: string): boolean {
  return isAccount(address) && !same(address, USDC)
}

function expectedUnits(amount: string): bigint {
  try {
    return BigInt(toBaseUnits(amount, USDC_DECIMALS))
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
}

/** This deposit moves USDC and nothing else, so an order naming another token must not reach it. */
function assertUsdc(expectation: DepositExpectation): void {
  if (expectation.token !== undefined && !same(expectation.token.id, USDC)) {
    refuse('Avalanche deposits here move USDC and no other token.')
  }
}

function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
  if (payload.family !== 'evm') return refuse('That is not an Avalanche transaction.')
  assertUsdc(expectation)
  if (expectation.memo !== undefined) refuse('Avalanche cannot carry the memo this order needs.')
  if (!isDepositAddress(expectation.depositAddress)) {
    refuse('This order’s deposit address cannot take a deposit.')
  }
  if (payload.chainId !== avalanche.id) refuse('That transaction is not for Avalanche.')
  if (!same(payload.to, USDC)) refuse('That transaction is not a call to the USDC contract.')
  if (payload.value !== '0') refuse('That transaction also spends AVAX as value.')
  const amount = expectedUnits(expectation.amount)

  // Decoded against `transfer` alone, so any other selector cannot decode at all.
  let args: readonly [Address, bigint]
  try {
    args = decodeFunctionData({ abi: TRANSFER_ABI, data: payload.data as Hex }).args
  } catch {
    return refuse('That transaction is not a USDC transfer.')
  }
  const [recipient, sent] = args
  if (!same(recipient, expectation.depositAddress)) {
    refuse('That transfer is not to this order’s deposit address.')
  }
  if (sent !== amount) refuse('That transfer’s amount is not this order’s amount.')

  // The decoder ignores what comes after the arguments and above an address's 20 bytes.
  const canonical = encodeFunctionData({
    abi: TRANSFER_ABI,
    functionName: 'transfer',
    args: [recipient, sent],
  })
  if (!same(canonical, payload.data)) {
    refuse('That transaction carries extra data, and must be exactly one transfer.')
  }
}

async function readBalances(
  client: AvalancheClient,
  account: Address
): Promise<{ usdc: bigint; avax: bigint }> {
  try {
    const [usdc, avax] = await Promise.all([
      client.usdcBalance(account),
      client.avaxBalance(account),
    ])
    return { usdc, avax }
  } catch {
    return refuse('Could not read this account’s balances from Avalanche.')
  }
}

function paidThisOrder(receipt: DepositReceipt, expectation: DepositExpectation): boolean {
  return erc20TransferPaid(receipt, {
    token: USDC,
    account: expectation.account,
    depositAddress: expectation.depositAddress,
    units: BigInt(toBaseUnits(expectation.amount, USDC_DECIMALS)),
  })
}

/** Takes the client as a function so nothing connects until a deposit is actually read. */
export function createAvalancheDeposit(client: () => AvalancheClient): DepositChain {
  return {
    chain: 'avalanche',
    usdcDecimals: USDC_DECIMALS,
    supportsMemo: false,
    isAccount,
    isDepositAddress,
    assertSafe,
    usdcBalance: (account) => client().usdcBalance(account as Address),

    build: async (expectation) => {
      const { account, depositAddress, amount, memo } = expectation
      if (memo !== undefined) refuse('Avalanche cannot carry the memo this order needs.')
      if (!isAccount(account)) refuse('This order’s account is not an Avalanche account.')
      if (!isDepositAddress(depositAddress)) {
        refuse('This order’s deposit address cannot take a deposit.')
      }
      const units = expectedUnits(amount)

      const { usdc, avax } = await readBalances(client(), account as Address)
      if (usdc < units) refuse('This account holds less USDC than this order needs.')
      if (avax === BigInt(0)) refuse('This account has no AVAX to pay the network fee.')

      const payload: SigningPayload = {
        family: 'evm',
        chainId: avalanche.id,
        to: USDC,
        data: encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: 'transfer',
          args: [depositAddress as Address, units],
        }),
        value: '0',
      }
      assertSafe(payload, expectation)
      return payload
    },

    // The wallet sent this itself, so there are no bytes to check: the chain is asked
    // what the transaction did, and these refusals never claim nothing was signed.
    submit: async (signed: SignedPayload, expectation): Promise<SubmitResult> => {
      if (signed.family !== 'evm') {
        throw new ChainActionRefused(
          'That is not an Avalanche transaction. Nothing was sent from here.'
        )
      }
      if (expectation.token !== undefined && !same(expectation.token.id, USDC)) {
        throw new ChainActionRefused(
          'This deposit can only be confirmed as USDC. Nothing was sent from here.'
        )
      }
      const { hash } = signed
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new ChainActionRefused(
          'That is not a transaction hash, so this deposit cannot be confirmed. Nothing was sent from here.'
        )
      }

      let receipt: DepositReceipt
      try {
        receipt = await client().waitForReceipt(hash as Hash)
      } catch {
        return {
          ok: false,
          pending: true,
          error: `This transfer is not confirmed yet, and it may still land. Do not send it again. Its transaction is ${hash}.`,
        }
      }

      if (receipt.status === 'reverted') {
        return {
          ok: false,
          error:
            'This transfer failed on Avalanche. The USDC did not move, and only the gas was spent.',
        }
      }
      if (!paidThisOrder(receipt, expectation)) {
        return { ok: false, error: 'That transaction is not this order’s deposit.' }
      }
      return { ok: true, hash, explorerUrl: `${EXPLORER_TX}${hash}` }
    },
  }
}

let shared: AvalancheClient | undefined

export const avalancheDeposit: DepositChain = createAvalancheDeposit(() => {
  shared ??= avalancheClient()
  return shared
})

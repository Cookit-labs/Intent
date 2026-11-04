import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'

import type { DepositChain, DepositExpectation } from '../../weave/types'
import { formatUnits } from '../near/tokens'
import {
  ChainActionRefused,
  toBaseUnits,
  withArticle,
  type ChainToken,
  type SigningPayload,
} from '../types'
import { evmClient, type EvmClient } from './client'
import { confirmEvmTransfer, sameAddress } from './submit'
import { EVM_CHAINS, EVM_NATIVE_ID, type EvmChain } from './tokens'

const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

export interface EvmDeposit extends Pick<
  DepositChain,
  'isAccount' | 'isDepositAddress' | 'build' | 'assertSafe' | 'submit'
> {
  /** Refuses a swap this account can't pay for, with its gas. Fails closed if it can't be read. */
  assertFunds: (account: string, token: ChainToken, amount: string) => Promise<void>
}

function refuse(reason: string): never {
  throw new ChainActionRefused(`${reason} Nothing was signed or sent.`)
}

function unitsOf(amount: string, token: ChainToken): bigint {
  try {
    return BigInt(toBaseUnits(amount, token.decimals))
  } catch (e) {
    return refuse(e instanceof Error ? e.message : 'That is not an amount.')
  }
}

/**
 * One transfer on Avalanche or Monad: the native coin to the deposit address, or one ERC-20
 * `transfer` to it. The token always comes from the order and is never assumed, because a proof
 * naming USDT must not be able to build or pass as USDC.
 */
export function createEvmDeposit(chain: EvmChain, client: () => EvmClient): EvmDeposit {
  const { name, chain: viemChain, tokens, nativeSymbol, gasReserve } = EVM_CHAINS[chain]

  function isAccount(address: string): boolean {
    return isAddress(address, { strict: false }) && !sameAddress(address, zeroAddress)
  }

  function isDepositAddress(address: string): boolean {
    return (
      isAccount(address) &&
      !tokens.some((token) => token.id !== EVM_NATIVE_ID && sameAddress(address, token.id))
    )
  }

  function tokenOf(expectation: DepositExpectation): ChainToken {
    const token = tokens.find((t) => t.id === expectation.token?.id)
    return token ?? refuse(`That token isn't one this app moves on ${name}.`)
  }

  function assertOrder(expectation: DepositExpectation): ChainToken {
    if (expectation.memo !== undefined) refuse(`${name} cannot carry the memo this order needs.`)
    if (!isDepositAddress(expectation.depositAddress)) {
      refuse('This order’s deposit address cannot take a deposit.')
    }
    return tokenOf(expectation)
  }

  function assertSafe(payload: SigningPayload, expectation: DepositExpectation): void {
    if (payload.family !== 'evm') return refuse(`That is not ${withArticle(name)} transaction.`)
    const token = assertOrder(expectation)
    if (payload.chainId !== viemChain.id) refuse(`That transaction is not for ${name}.`)
    const units = unitsOf(expectation.amount, token)

    if (token.id === EVM_NATIVE_ID) {
      if (!sameAddress(payload.to, expectation.depositAddress)) {
        refuse('That transfer is not to this order’s deposit address.')
      }
      if (payload.value !== units.toString()) {
        refuse('That transfer’s amount is not this order’s amount.')
      }
      if (payload.data !== '0x') refuse('A transfer of the native coin carries no data.')
      return
    }

    if (!sameAddress(payload.to, token.id)) {
      refuse(`That transaction is not a call to the ${token.symbol} contract.`)
    }
    if (payload.value !== '0') refuse(`That transaction also spends ${nativeSymbol} as value.`)
    // Decoded against `transfer` alone, so any other selector cannot decode at all.
    let args: readonly [Address, bigint]
    try {
      args = decodeFunctionData({ abi: TRANSFER_ABI, data: payload.data as Hex }).args
    } catch {
      return refuse(`That transaction is not a ${token.symbol} transfer.`)
    }
    const [recipient, sent] = args
    if (!sameAddress(recipient, expectation.depositAddress)) {
      refuse('That transfer is not to this order’s deposit address.')
    }
    if (sent !== units) refuse('That transfer’s amount is not this order’s amount.')
    // The decoder ignores what comes after the arguments and above an address's 20 bytes.
    const canonical = encodeFunctionData({
      abi: TRANSFER_ABI,
      functionName: 'transfer',
      args: [recipient, sent],
    })
    if (!sameAddress(canonical, payload.data)) {
      refuse('That transaction carries extra data, and must be exactly one transfer.')
    }
  }

  return {
    isAccount,
    isDepositAddress,
    assertSafe,

    assertFunds: async (account, token, amount) => {
      const units = unitsOf(amount, token)
      const reserve = BigInt(gasReserve)
      const kept = `${formatUnits(gasReserve, 18)} ${nativeSymbol}`
      const native = token.id === EVM_NATIVE_ID
      let held: bigint | undefined
      let coin: bigint
      try {
        const reader = client()
        ;[held, coin] = await Promise.all([
          native ? undefined : reader.tokenBalance(token.id as Address, account as Address),
          reader.nativeBalance(account as Address),
        ])
      } catch {
        return refuse(`Could not read this account’s balances from ${name}.`)
      }
      if (native) {
        if (coin < units + reserve) {
          refuse(
            `This account needs ${amount} ${nativeSymbol} for the swap and about ${kept} more for the network fee, and holds less than that.`
          )
        }
        return
      }
      if (held === undefined || held < units) {
        refuse(`This account holds less ${token.symbol} than this swap needs.`)
      }
      if (coin < reserve) {
        refuse(
          `This account has too little ${nativeSymbol} for the network fee. Keep about ${kept}.`
        )
      }
    },

    build: async (expectation) => {
      const token = assertOrder(expectation)
      if (!isAccount(expectation.account)) refuse(`That is not ${withArticle(name)} account.`)
      const units = unitsOf(expectation.amount, token)
      const payload: SigningPayload =
        token.id === EVM_NATIVE_ID
          ? {
              family: 'evm',
              chainId: viemChain.id,
              to: expectation.depositAddress,
              data: '0x',
              value: units.toString(),
            }
          : {
              family: 'evm',
              chainId: viemChain.id,
              to: token.id,
              data: encodeFunctionData({
                abi: TRANSFER_ABI,
                functionName: 'transfer',
                args: [expectation.depositAddress as Address, units],
              }),
              value: '0',
            }
      assertSafe(payload, expectation)
      return payload
    },

    submit: (signed, expectation) => confirmEvmTransfer(chain, client, signed, expectation),
  }
}

const shared: Partial<Record<EvmChain, EvmClient>> = {}

/** Takes the client as a function so nothing connects until a deposit is actually read. */
export function evmDeposit(chain: EvmChain): EvmDeposit {
  return createEvmDeposit(chain, () => (shared[chain] ??= evmClient(chain)))
}

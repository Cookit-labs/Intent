import type { Address } from 'viem'

import { fromBaseUnits } from '../solana/tokens'
import { ChainActionRefused, withArticle, type TokenBalance, type WalletBalances } from '../types'
import { evmClient, type EvmClient } from './client'
import { EVM_CHAINS, EVM_NATIVE_ID, type EvmChain } from './tokens'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * The chain's coin and each token in its own table. There is no "everything held" call on an EVM
 * chain, so this is never complete.
 */
export async function readEvmBalances(
  chain: EvmChain,
  account: string,
  client: EvmClient = evmClient(chain)
): Promise<WalletBalances> {
  if (!ADDRESS.test(account)) {
    throw new ChainActionRefused(
      `That is not ${withArticle(EVM_CHAINS[chain].name)} address. Connect an EVM wallet and try again.`
    )
  }
  const owner = account as Address
  const tokens = await Promise.all(
    EVM_CHAINS[chain].tokens.map(async (token): Promise<TokenBalance> => {
      const native = token.id === EVM_NATIVE_ID
      const base = native
        ? await client.nativeBalance(owner)
        : await client.tokenBalance(token.id as Address, owner)
      return {
        symbol: token.symbol,
        id: token.id,
        amount: fromBaseUnits(base.toString(), token.decimals),
        decimals: token.decimals,
        native,
        listed: true,
      }
    })
  )
  return { tokens, complete: false }
}

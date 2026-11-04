'use client'

import {
  accountExplorerUrl,
  arcDescriptor,
  avalancheDescriptor,
  monadDescriptor,
} from '@intent/config'
import type { ChainDescriptor } from '@intent/types'
import { BaseError, UserRejectedRequestError, type Address, type Hex } from 'viem'
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { getAccount, sendTransaction, switchChain } from 'wagmi/actions'
import { avalanche, monad } from 'viem/chains'

import type { ChainAdapter, ChainWallet } from '../chain-adapter'
import { withArticle, type SignedOutcome, type SigningPayload } from '../chains/types'
import { arcTestnet, wagmiConfig } from '../wagmi.config'
import { isUserRejection } from '../wallet/connector'
import { walletErrorMessage } from '../wallet/error-message'

/**
 * An EVM chain's wallet, behind the shared adapter interface. wagmi holds one
 * connection for all of them, so what differs per chain is the network the
 * wallet is expected to be on.
 *
 * On Arc the balance is the *native* USDC view (18 decimals), which is what the
 * wallet shows. Reading USDC through its ERC-20 interface gives 6 decimals for
 * the same balance: see `USDC_ERC20_DECIMALS` in `@intent/config`.
 */
function evmAdapter(
  descriptor: ChainDescriptor,
  chainId: number,
  signPrepared?: ChainAdapter['signPrepared']
): ChainAdapter {
  function useEvmWallet(): ChainWallet {
    const {
      address,
      isConnected,
      isConnecting,
      isReconnecting,
      chainId: walletChain,
      connector,
    } = useAccount()
    const { switchChain, isPending: isSwitching } = useSwitchChain()
    const { connect, connectors, error: connectError } = useConnect()
    const { disconnect } = useDisconnect()

    const isWrongNetwork = isConnected && walletChain !== chainId

    const { data: balanceData } = useBalance({
      address,
      chainId,
      query: { enabled: isConnected && !isWrongNetwork },
    })

    return {
      address,
      isConnected,
      isConnecting: isConnecting || isReconnecting,
      isRestoring: isReconnecting,
      isWrongNetwork,
      balance: balanceData?.formatted,
      balanceSymbol: balanceData?.symbol ?? descriptor.nativeCurrency.symbol,
      // Only Arc has a faucet to send anyone to. Compared against BigInt(0)
      // rather than a 0n literal: the TS target predates BigInt literal syntax.
      needsFunding:
        descriptor.slug === 'arc' &&
        isConnected &&
        !isWrongNetwork &&
        balanceData !== undefined &&
        balanceData.value === BigInt(0),
      // An injected connector is always registered, so the browser-extension
      // check happens at connect time rather than here.
      isWalletUnavailable: false,
      error: connectError?.message,
      connect: () => {
        const injected = connectors[0]
        if (injected) connect({ connector: injected })
      },
      disconnect: () => disconnect(),
      switchNetwork: () => switchChain({ chainId }),
      isSwitching,
      walletName: connector?.name,
      walletIcon: connector?.icon,
    }
  }

  return {
    descriptor,
    useWallet: useEvmWallet,
    accountUrl: (address) => accountExplorerUrl(descriptor.slug, address),
    ...(signPrepared !== undefined ? { signPrepared } : {}),
  }
}

function signOn(name: string, chainId: 43114 | 143): NonNullable<ChainAdapter['signPrepared']> {
  return async (payload: SigningPayload): Promise<SignedOutcome> => {
    if (payload.family !== 'evm') {
      return {
        ok: false,
        reason: 'wallet_error',
        detail: `That is not ${withArticle(name)} transaction.`,
      }
    }
    if (payload.chainId !== chainId) {
      return { ok: false, reason: 'wallet_error', detail: `That transaction is not for ${name}.` }
    }
    // BigInt would also read hex or an empty string, and this is real money.
    if (!/^\d+$/.test(payload.value)) {
      return { ok: false, reason: 'wallet_error', detail: 'That transaction’s value is not valid.' }
    }
    const { status, chainId: walletChain } = getAccount(wagmiConfig)
    if (status !== 'connected') {
      return { ok: false, reason: 'wallet_error', detail: 'Reconnect your wallet and try again.' }
    }
    try {
      if (walletChain !== chainId) {
        await switchChain(wagmiConfig, { chainId })
      }
      const hash = await sendTransaction(wagmiConfig, {
        to: payload.to as Address,
        data: payload.data as Hex,
        value: BigInt(payload.value),
        chainId,
      })
      return { ok: true, signed: { family: 'evm', hash } }
    } catch (e) {
      // viem's message goes on to list the whole request, so its short one is what is read.
      const detail = e instanceof BaseError ? e.shortMessage : walletErrorMessage(e)
      const declined =
        (e instanceof BaseError &&
          e.walk((cause) => cause instanceof UserRejectedRequestError) !== null) ||
        isUserRejection(detail)
      return declined
        ? { ok: false, reason: 'rejected' }
        : { ok: false, reason: 'wallet_error', detail }
    }
  }
}

export const arcAdapter = evmAdapter(arcDescriptor, arcTestnet.id)
export const avalancheAdapter = evmAdapter(
  avalancheDescriptor,
  avalanche.id,
  signOn('Avalanche', avalanche.id)
)
export const monadAdapter = evmAdapter(monadDescriptor, monad.id, signOn('Monad', monad.id))

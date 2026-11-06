import { BaseError, UserRejectedRequestError, type Address, type Hex } from 'viem'

import { isUserRejection } from '../../wallet/connector'
import { walletErrorMessage } from '../../wallet/error-message'
import { ChainActionRefused, type SignedOutcome, type SigningPayload } from '../types'
import { assertCowOrderShape, viemTypedData } from './cow-rules'

/** What signing a typed message needs of a wallet. wagmi's actions in the app, fakes in tests. */
export interface TypedWallet {
  account: () => { status: string; address?: string | undefined; chainId?: number | undefined }
  switchChain: (chainId: number) => Promise<unknown>
  signTypedData: (args: { account: Address } & ReturnType<typeof viemTypedData>) => Promise<string>
}

/** A wallet's failure as the card reads it: a decline, or the wallet's own short words. */
export function walletFailure(e: unknown): SignedOutcome {
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

/**
 * Signs a typed message, which only ever is a CoW order on Avalanche. A wallet shows it as fields
 * few people can read, so it is checked here, again, against everything that does not depend on
 * what was asked, and refused before the wallet is touched. Nothing else typed is ever signed.
 */
export async function signTypedOn(
  name: string,
  chainId: number,
  payload: SigningPayload,
  wallet: TypedWallet,
  now: number = Date.now()
): Promise<SignedOutcome> {
  const refuse = (detail: string): SignedOutcome => ({ ok: false, reason: 'wallet_error', detail })
  if (payload.family !== 'evm-typed') return refuse('That is not an order to sign.')
  if (payload.chainId !== chainId) return refuse(`That order is not for ${name}.`)
  const { status, address, chainId: walletChain } = wallet.account()
  if (status !== 'connected' || address === undefined) {
    return refuse('Reconnect your wallet and try again.')
  }
  if (address.toLowerCase() !== payload.account.toLowerCase()) {
    return refuse('This order was made for another wallet. Switch back to that wallet to sign it.')
  }
  let order
  try {
    order = assertCowOrderShape(payload, address, now)
  } catch (e) {
    if (e instanceof ChainActionRefused) return refuse(e.message)
    throw e
  }
  try {
    if (walletChain !== chainId) await wallet.switchChain(chainId)
    const signature = await wallet.signTypedData({
      account: address as Address,
      ...viemTypedData(order),
    })
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return refuse('The wallet gave back no signature.')
    return { ok: true, signed: { family: 'evm-typed', signature: signature as Hex } }
  } catch (e) {
    return walletFailure(e)
  }
}

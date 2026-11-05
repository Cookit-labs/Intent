import type { Wallet, WalletAccount } from '@wallet-standard/base'

import type { SignedPayload, SigningPayload } from '../types'

interface SuiSignTransaction {
  'sui:signTransaction'?: {
    signTransaction: (input: {
      transaction: { toJSON: () => Promise<string> }
      account: WalletAccount
      chain: string
    }) => Promise<{ bytes: string; signature: string }>
  }
}

/** The Wallet Standard's Sui signing feature. The server checks and sends the result. */
export async function signSui(
  wallet: Wallet,
  account: WalletAccount,
  payload: SigningPayload
): Promise<SignedPayload> {
  if (payload.family !== 'sui') throw new Error('That is not a Sui transaction.')
  const feature = (wallet.features as SuiSignTransaction)['sui:signTransaction']
  if (feature === undefined) throw new Error(`${wallet.name} cannot sign Sui transactions here.`)
  const { bytes, signature } = await feature.signTransaction({
    transaction: { toJSON: async () => payload.transaction },
    account,
    chain: 'sui:mainnet',
  })
  return { family: 'sui', transaction: bytes, signature }
}

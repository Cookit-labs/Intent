import type { Wallet, WalletAccount } from '@wallet-standard/base'

import { base64FromBytes, bytesFromBase64 } from '../base64'
import type { SignedPayload, SigningPayload } from '../types'

interface SolanaSignTransaction {
  'solana:signTransaction'?: {
    signTransaction: (input: {
      account: WalletAccount
      transaction: Uint8Array
      chain: string
    }) => Promise<readonly { signedTransaction: Uint8Array }[]>
  }
}

/** The Wallet Standard's Solana signing feature. The server checks and sends the result. */
export async function signSolana(
  wallet: Wallet,
  account: WalletAccount,
  payload: SigningPayload
): Promise<SignedPayload> {
  if (payload.family !== 'solana') throw new Error('That is not a Solana transaction.')
  const feature = (wallet.features as SolanaSignTransaction)['solana:signTransaction']
  if (feature === undefined) throw new Error(`${wallet.name} cannot sign Solana transactions here.`)
  const [output] = await feature.signTransaction({
    account,
    transaction: bytesFromBase64(payload.transaction),
    chain: 'solana:mainnet',
  })
  if (output === undefined) throw new Error('The wallet returned nothing to send.')
  return { family: 'solana', signedTransaction: base64FromBytes(output.signedTransaction) }
}
